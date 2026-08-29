import {
  b64ToBytes,
  bytesToB64,
  frame,
  parseClientToDaemon,
  parseJson,
  utf8Bytes,
  type ClientToDaemonMessage,
  type DaemonToClientMessage,
} from "@rcmdsh/shared";
import type { DaemonConfig } from "./config";
import { getKeyPair } from "./config";
import { allowedShellsForPlatform } from "./pty/shells";
import { SessionManager } from "./pty/SessionManager";
import { RelayConnection } from "./relay/Connection";
import { daemonKeyForClient, openFromClient, sealToClient } from "./e2e";

export interface DaemonAppOptions {
  config: DaemonConfig;
  token: string;
  insecure: boolean;
  log: (message: string) => void;
}

interface ClientState {
  clientId: string;
  key: Uint8Array | null;
}

export class DaemonApp {
  private readonly sessions: SessionManager;
  private readonly connection: RelayConnection;
  private readonly clients = new Map<string, ClientState>();
  private readonly keyPair;

  constructor(private readonly options: DaemonAppOptions) {
    this.keyPair = getKeyPair(options.config);
    this.sessions = new SessionManager({
      onOutput: (sessionId, data) => {
        this.broadcast(
          frame({ type: "session.output", id: sessionId, data: bytesToB64(utf8Bytes(data)) }),
        );
      },
      onExit: (sessionId, exitCode) => {
        this.broadcast(frame({ type: "session.exit", id: sessionId, exitCode }));
        this.broadcast(this.sessionsListFrame());
      },
    });
    this.connection = new RelayConnection({
      relayUrl: options.config.relayUrl,
      token: options.token,
      log: options.log,
      onRoute: (from, frameText) => this.handleClientFrame(from, frameText),
      onOnline: () => this.options.log("daemon is reachable from paired devices"),
      onOffline: () => {},
      onRejected: (code, message) => this.options.log(`auth rejected (${code}): ${message}`),
    });
  }

  start(): void {
    this.connection.start();
  }

  stop(): void {
    this.connection.stop();
    this.sessions.killAll();
  }

  // ---- inbound from relay ----

  private handleClientFrame(from: string | undefined, frameText: string): void {
    if (!from) {
      this.options.log("dropping route without client id");
      return;
    }
    let client = this.clients.get(from);
    if (!client) {
      client = { clientId: from, key: null };
      this.clients.set(from, client);
    }

    const parsed = parseJson(frameText);
    if (!parsed.ok) {
      this.options.log("dropping malformed client frame");
      return;
    }
    const value = parsed.value as Record<string, unknown>;

    if (value["type"] === "e2e.hello") {
      const pubKey = value["clientPubKey"];
      if (typeof pubKey !== "string") {
        this.sendError(client, "bad_request", "missing clientPubKey");
        return;
      }
      const paired = this.options.config.pairedDevices.find((d) => d.clientPubKey === pubKey);
      if (!paired) {
        this.sendError(client, "unpaired", "this client public key is not paired with this daemon");
        return;
      }
      client.key = daemonKeyForClient(this.keyPair.secretKey, pubKey);
      this.options.log(`secure channel established with ${paired.name}`);
      this.sendToClient(client, frame({ type: "capabilities", shells: this.allowedShellsInfo() }));
      this.sendToClient(client, this.sessionsListFrame());
      return;
    }

    let message: ClientToDaemonMessage | null = null;
    if (client.key) {
      const opened = openFromClient(client.key, frameText);
      if (opened === null) {
        this.options.log(`failed to decrypt frame from ${from}`);
        return;
      }
      const result = parseClientToDaemon(opened);
      if (!result.ok) {
        this.sendError(client, "bad_request", result.error);
        return;
      }
      message = result.value;
    } else if (this.options.insecure) {
      const result = parseClientToDaemon(value);
      if (!result.ok) {
        this.sendPlaintextError(client, "bad_request", result.error);
        return;
      }
      message = result.value;
    } else {
      this.sendPlaintextError(client, "e2e_required", "send e2e.hello before application messages");
      return;
    }

    this.handleAppMessage(client, message);
  }

  private handleAppMessage(client: ClientState, message: ClientToDaemonMessage): void {
    switch (message.type) {
      case "sessions.list": {
        this.sendToClient(client, this.sessionsListFrame());
        this.sendToClient(client, frame({ type: "capabilities", shells: this.allowedShellsInfo() }));
        return;
      }
      case "session.create": {
        const shell = allowedShellsForPlatform(this.options.config.allowedShells).find(
          (s) => s.id === message.shell,
        );
        if (!shell) {
          this.sendError(client, "shell_not_allowed", `shell "${message.shell}" is not allowed`);
          return;
        }
        try {
          this.sessions.create(shell, { cols: message.cols, rows: message.rows });
        } catch (err) {
          this.sendError(client, "spawn_failed", err instanceof Error ? err.message : String(err));
          return;
        }
        this.broadcast(this.sessionsListFrame());
        return;
      }
      case "session.input": {
        try {
          this.sessions.write(message.id, new TextDecoder().decode(b64ToBytes(message.data)));
        } catch (err) {
          if (err instanceof Error && err.name === "UnknownSessionError") {
            this.sendError(client, "not_found", err.message);
          }
        }
        return;
      }
      case "session.resize": {
        try {
          this.sessions.resize(message.id, message.cols, message.rows);
        } catch {
          // session may have exited between frames
        }
        return;
      }
      case "session.attach": {
        try {
          const replay = this.sessions.replay(message.id);
          if (replay.length > 0) {
            this.sendToClient(
              client,
              frame({ type: "session.output", id: message.id, data: bytesToB64(utf8Bytes(replay)) }),
            );
          }
        } catch (err) {
          if (err instanceof Error && err.name === "UnknownSessionError") {
            this.sendError(client, "not_found", err.message);
          }
        }
        return;
      }
      case "session.kill": {
        try {
          this.sessions.kill(message.id);
        } catch (err) {
          if (err instanceof Error && err.name === "UnknownSessionError") {
            this.sendError(client, "not_found", err.message);
          }
        }
        return;
      }
    }
  }

  // ---- outbound to relay ----

  private broadcast(message: DaemonToClientMessage): void {
    for (const client of this.clients.values()) {
      this.sendToClient(client, message);
    }
  }

  private sendToClient(client: ClientState, message: DaemonToClientMessage): void {
    if (client.key) {
      this.connection.sendRoute(client.clientId, sealToClient(client.key, message));
    } else if (this.options.insecure) {
      this.connection.sendRoute(client.clientId, JSON.stringify(message));
    }
  }

  private sendError(client: ClientState, code: string, message: string): void {
    this.sendToClient(client, frame({ type: "error", code, message }));
  }

  private sendPlaintextError(client: ClientState, code: string, message: string): void {
    this.connection.sendRoute(
      client.clientId,
      JSON.stringify(frame({ type: "error", code, message })),
    );
  }

  private sessionsListFrame(): DaemonToClientMessage {
    return frame({ type: "sessions.list", sessions: this.sessions.list() });
  }

  private allowedShellsInfo() {
    return allowedShellsForPlatform(this.options.config.allowedShells).map((shell) => ({
      id: shell.id,
      name: shell.name,
    }));
  }
}
