import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { frame, parseJson, RelayHello, RelayWelcome, RelayError } from "rcmdsh-core";
import type { Registry } from "./registry";

const AUTH_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 30_000;

interface ClientMeta {
  deviceId: string;
  clientId: string;
  name: string;
}

export class RelayRouter {
  private readonly daemonWss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  private readonly clientWss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  private readonly daemons = new Map<string, WebSocket>();
  private readonly clients = new Map<WebSocket, ClientMeta>();
  private readonly clientSockets = new Map<string, WebSocket>();
  private pingTimer: NodeJS.Timeout;

  constructor(
    private readonly registry: Registry,
    private readonly log: (message: string) => void,
  ) {
    this.daemonWss.on("connection", (ws) => this.handleDaemonConnection(ws));
    this.clientWss.on("connection", (ws) => this.handleClientConnection(ws));
    this.pingTimer = setInterval(() => this.pingAll(), PING_INTERVAL_MS);
    this.pingTimer.unref();
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname === "/ws/daemon") {
      this.daemonWss.handleUpgrade(request, socket, head, (ws) => this.daemonWss.emit("connection", ws, request));
    } else if (pathname === "/ws/client") {
      this.clientWss.handleUpgrade(request, socket, head, (ws) => this.clientWss.emit("connection", ws, request));
    } else {
      socket.destroy();
    }
  }

  close(): void {
    clearInterval(this.pingTimer);
    for (const ws of this.daemons.values()) ws.terminate();
    for (const ws of this.clientSockets.values()) ws.terminate();
    this.daemonWss.close();
    this.clientWss.close();
  }

  private pingAll(): void {
    for (const ws of [this.daemons.values(), this.clientSockets.values()].flatMap((m) => Array.from(m))) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.ping();
        } catch {
          // socket died between checks; close event will clean it up
        }
      }
    }
  }

  private notifyClientsOnline(deviceId: string, online: boolean): void {
    for (const [ws, meta] of this.clients) {
      if (meta.deviceId !== deviceId) continue;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(frame({ type: "relay.status", daemonOnline: online })));
      }
    }
  }

  private handleDaemonConnection(ws: WebSocket): void {
    let deviceId: string | null = null;

    const authTimer = setTimeout(() => {
      if (!deviceId) ws.close(4000, "auth timeout");
    }, AUTH_TIMEOUT_MS);
    authTimer.unref();

    ws.on("message", (raw) => {
      if (deviceId) {
        this.handleDaemonFrame(deviceId, String(raw));
        return;
      }
      const auth = this.authenticate(String(raw), "daemon");
      if (!auth) {
        this.reject(ws, "unauthorized", "invalid or revoked daemon token");
        return;
      }
      deviceId = auth.deviceId;
      const existing = this.daemons.get(deviceId);
      if (existing && existing !== ws) {
        this.log(`replacing stale daemon connection for ${deviceId}`);
        existing.terminate();
      }
      this.daemons.set(deviceId, ws);
      clearTimeout(authTimer);
      ws.send(JSON.stringify(frame({ type: "relay.welcome", deviceId })));
      this.notifyClientsOnline(deviceId, true);
      this.log(`daemon ${deviceId} connected`);
    });

    ws.on("close", () => {
      clearTimeout(authTimer);
      if (deviceId && this.daemons.get(deviceId) === ws) {
        this.daemons.delete(deviceId);
        this.notifyClientsOnline(deviceId, false);
        this.log(`daemon ${deviceId} disconnected`);
      }
    });

    ws.on("error", () => {
      // close handler performs cleanup
    });
  }

  private handleClientConnection(ws: WebSocket): void {
    let meta: ClientMeta | null = null;

    const authTimer = setTimeout(() => {
      if (!meta) ws.close(4000, "auth timeout");
    }, AUTH_TIMEOUT_MS);
    authTimer.unref();

    ws.on("message", (raw) => {
      const text = String(raw);
      if (!meta) {
        const auth = this.authenticate(String(text), "client");
        if (!auth || !auth.clientId) {
          this.reject(ws, "unauthorized", "invalid or revoked device token");
          return;
        }
        const device = this.registry.getDevice(auth.deviceId);
        meta = { deviceId: auth.deviceId, clientId: auth.clientId, name: device?.name ?? "computer" };
        this.clients.set(ws, meta);
        this.clientSockets.set(meta.clientId, ws);
        clearTimeout(authTimer);
        ws.send(
          JSON.stringify(
            frame({
              type: "relay.welcome",
              deviceId: meta.deviceId,
              clientId: meta.clientId,
              name: meta.name,
            }),
          ),
        );
        ws.send(JSON.stringify(frame({ type: "relay.status", daemonOnline: this.daemons.has(meta.deviceId) })));
        this.log(`client ${meta.clientId} connected for device ${meta.deviceId}`);
        return;
      }

      const daemon = this.daemons.get(meta.deviceId);
      if (!daemon || daemon.readyState !== WebSocket.OPEN) {
        ws.send(
          JSON.stringify(
            frame({ type: "relay.error", code: "daemon_offline", message: "your computer is not connected to the relay" }),
          ),
        );
        return;
      }
      const envelope = frame({ type: "relay.route", from: meta.clientId, frame: text });
      daemon.send(JSON.stringify(envelope));
    });

    ws.on("close", () => {
      clearTimeout(authTimer);
      if (meta) {
        this.clients.delete(ws);
        if (this.clientSockets.get(meta.clientId) === ws) {
          this.clientSockets.delete(meta.clientId);
        }
        this.log(`client ${meta.clientId} disconnected`);
      }
    });

    ws.on("error", () => {
      // close handler performs cleanup
    });
  }

  private handleDaemonFrame(deviceId: string, raw: string): void {
    const parsed = parseJson(raw);
    if (!parsed.ok) {
      this.log(`daemon ${deviceId} sent malformed frame`);
      return;
    }
    const value = parsed.value as Record<string, unknown>;
    if (value["type"] !== "relay.route") {
      this.log(`daemon ${deviceId} sent unexpected message type: ${String(value["type"])}`);
      return;
    }
    const to = typeof value["to"] === "string" ? value["to"] : "all";
    const frameText = typeof value["frame"] === "string" ? value["frame"] : null;
    if (frameText === null) {
      this.log(`daemon ${deviceId} route missing frame`);
      return;
    }

    let delivered = 0;
    for (const [ws, meta] of this.clients) {
      if (meta.deviceId !== deviceId) continue;
      if (to !== "all" && meta.clientId !== to) continue;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(frameText);
        delivered++;
      }
    }
    if (delivered === 0 && to !== "all") {
      const daemon = this.daemons.get(deviceId);
      if (daemon && daemon.readyState === WebSocket.OPEN) {
        daemon.send(
          JSON.stringify(
            frame({ type: "relay.route", from: undefined, frame: JSON.stringify(frame({ type: "relay.error", code: "client_offline", message: `client ${to} is offline` })) }),
          ),
        );
      }
    }
  }

  private authenticate(raw: string, role: "daemon" | "client"): { deviceId: string; clientId: string | null } | null {
    const parsed = parseJson(raw);
    if (!parsed.ok) return null;
    const hello = RelayHello.safeParse(parsed.value);
    if (!hello.success || hello.data.role !== role) return null;
    const token = hello.data.token;
    const row = this.registry.lookupToken(token, hello.data.role);
    if (!row) {
      return null;
    }
    return { deviceId: row.deviceId, clientId: row.clientId };
  }

  private reject(ws: WebSocket, code: string, message: string): void {
    ws.send(JSON.stringify(frame({ type: "relay.reject", code, message })));
    ws.close(4001, code);
  }
}
