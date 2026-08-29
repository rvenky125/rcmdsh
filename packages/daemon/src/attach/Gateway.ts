import { b64ToBytes, frame, parseJson, randomId } from "rcmdsh-core";
import { WebSocketServer, type WebSocket } from "ws";
import { parseBridgeToDaemon, type BridgeToDaemonMessage } from "rcmdsh-core";
import { BridgeSession } from "../pty/BridgeSession";
import type { SessionEvents, SessionManager } from "../pty/SessionManager";

export interface AttachGatewayOptions {
  port: number;
  token: string;
  sessions: SessionManager;
  events: SessionEvents;
  log: (message: string) => void;
  onSessionsChanged: () => void;
}

interface PendingBridge {
  resolve: (session: BridgeSession) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const BRIDGE_TIMEOUT_MS = 10_000;
const PORT_ATTEMPTS = 10;

// Local websocket server that `rcmdsh attach` clients connect to. Binds to
// 127.0.0.1 only and authenticates with the attach token from the config, so
// paired phones never touch it.
export class AttachGateway {
  private wss: WebSocketServer | null = null;
  private readonly pending = new Map<string, PendingBridge>();
  private readonly sessionBySocket = new WeakMap<WebSocket, BridgeSession>();

  constructor(private readonly options: AttachGatewayOptions) {}

  get port(): number | null {
    const address = this.wss?.address();
    return address && typeof address === "object" ? address.port : null;
  }

  async start(): Promise<void> {
    for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt++) {
      const port = this.options.port + attempt;
      const bound = await this.tryListenOn(port);
      if (bound) return;
    }
    const message =
      this.lastBindError instanceof Error ? this.lastBindError.message : String(this.lastBindError);
    this.options.log(`attach gateway could not bind near port ${this.options.port}: ${message}`);
    this.options.log("rcmdsh attach and visible windows are disabled for this run");
  }

  stop(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("gateway stopped"));
    }
    this.pending.clear();
    if (this.wss) {
      for (const client of this.wss.clients) {
        try {
          client.close();
        } catch {
          // already gone
        }
      }
      try {
        this.wss.close();
      } catch {
        // already closed
      }
      this.wss = null;
    }
  }

  // Resolves when an attach client carrying this bridgeId says hello.
  expectBridge(bridgeId: string, timeoutMs = BRIDGE_TIMEOUT_MS): Promise<BridgeSession> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(bridgeId);
        reject(new Error("attach window did not connect in time"));
      }, timeoutMs);
      this.pending.set(bridgeId, { resolve, reject, timer });
    });
  }

  private lastBindError: unknown = null;

  private tryListenOn(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const wss = new WebSocketServer({ host: "127.0.0.1", port, path: "/bridge" });
      wss.once("error", (err) => {
        this.lastBindError = err;
        try {
          wss.close();
        } catch {
          // never opened
        }
        resolve(false);
      });
      wss.once("listening", () => {
        wss.removeAllListeners("error");
        wss.on("connection", (ws) => this.handleConnection(ws));
        wss.on("error", (err) => this.options.log(`attach gateway error: ${err.message}`));
        this.wss = wss;
        this.options.log(`attach gateway listening on 127.0.0.1:${port}`);
        resolve(true);
      });
    });
  }

  private handleConnection(ws: WebSocket): void {
    let session: BridgeSession | null = null;

    const sendToBridge = (message: Record<string, unknown>): void => {
      try {
        ws.send(JSON.stringify(frame(message)));
      } catch {
        // socket closing
      }
    };

    ws.on("message", (raw) => {
      const text = String(raw);
      if (!session) {
        session = this.acceptHello(ws, text, sendToBridge);
        return;
      }
      const parsed = parseJson(text);
      if (!parsed.ok) return;
      const result = parseBridgeToDaemon(parsed.value);
      if (!result.ok) return;
      this.routeToSession(session, result.value);
    });

    ws.on("close", () => {
      const attached = session ?? this.sessionBySocket.get(ws);
      if (attached) {
        attached.handleDisconnect();
        this.options.onSessionsChanged();
      }
    });

    ws.on("error", () => {
      // close event follows; nothing to do here
    });
  }

  private acceptHello(
    ws: WebSocket,
    text: string,
    sendToBridge: (message: Record<string, unknown>) => void,
  ): BridgeSession | null {
    const parsed = parseJson(text);
    if (!parsed.ok) {
      sendToBridge({ type: "bridge.error", code: "bad_request", message: "invalid JSON" });
      ws.close();
      return null;
    }
    const result = parseBridgeToDaemon(parsed.value);
    if (!result.ok || result.value.type !== "bridge.hello") {
      sendToBridge({ type: "bridge.error", code: "bad_request", message: "expected bridge.hello" });
      ws.close();
      return null;
    }
    const hello = result.value;
    if (hello.token !== this.options.token) {
      this.options.log("attach client rejected: bad token");
      sendToBridge({ type: "bridge.error", code: "bad_token", message: "attach token rejected" });
      ws.close();
      return null;
    }

    const session = new BridgeSession(
      randomId(),
      hello.shell,
      ws,
      this.options.events,
      hello.pid,
      hello.cols,
      hello.rows,
    );
    try {
      this.options.sessions.register(session);
    } catch (err) {
      sendToBridge({
        type: "bridge.error",
        code: "too_many_sessions",
        message: err instanceof Error ? err.message : String(err),
      });
      ws.close();
      return null;
    }

    const pending = hello.bridgeId ? this.pending.get(hello.bridgeId) : undefined;
    if (pending) {
      if (hello.bridgeId) this.pending.delete(hello.bridgeId);
      clearTimeout(pending.timer);
      pending.resolve(session);
    }
    this.sessionBySocket.set(ws, session);
    sendToBridge({ type: "bridge.welcome", id: session.id, shell: session.shellId });
    this.options.log(`attach session registered (${hello.shell}, pid ${hello.pid ?? "?"})`);
    this.options.onSessionsChanged();
    return session;
  }

  private routeToSession(session: BridgeSession, message: BridgeToDaemonMessage): void {
    switch (message.type) {
      case "bridge.output": {
        session.handleOutput(new TextDecoder().decode(b64ToBytes(message.data)));
        return;
      }
      case "bridge.exit": {
        session.handleExit(message.exitCode);
        this.options.onSessionsChanged();
        return;
      }
      case "bridge.resize": {
        session.handleResize(message.cols, message.rows);
        return;
      }
      case "bridge.hello": {
        // duplicate hello on an established connection; ignore
        return;
      }
    }
  }
}
