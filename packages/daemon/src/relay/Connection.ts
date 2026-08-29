import WebSocket from "ws";
import { frame, parseJson, RelayHello, RelayReject, RelayRoute, RelayWelcome } from "rcmdsh-core";

export interface RelayConnectionOptions {
  relayUrl: string;
  token: string;
  log: (message: string) => void;
  onRoute: (fromClientId: string | undefined, frameText: string) => void;
  onOnline: () => void;
  onOffline: () => void;
  onRejected: (code: string, message: string) => void;
}

const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 500;

export class RelayConnection {
  private ws: WebSocket | null = null;
  private attempts = 0;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: RelayConnectionOptions) {}

  get online(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // already gone
      }
      this.ws = null;
    }
  }

  sendRoute(to: string | "all", frameText: string): void {
    this.sendJson(frame({ type: "relay.route", to, frame: frameText }));
  }

  private connect(): void {
    if (this.stopped) return;
    const url = new URL(this.options.relayUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/ws/daemon";

    const ws = new WebSocket(url, { handshakeTimeout: 10_000 });
    this.ws = ws;

    ws.on("open", () => {
      this.sendJson(frame({ type: "relay.hello", role: "daemon", token: this.options.token }));
    });

    ws.on("message", (raw) => {
      this.handleMessage(String(raw));
    });

    ws.on("close", () => {
      const wasConnected = this.attempts === 0;
      this.ws = null;
      this.options.onOffline();
      if (!this.stopped) {
        if (wasConnected) this.options.log("disconnected from relay");
        this.scheduleReconnect();
      }
    });

    ws.on("error", (err) => {
      this.options.log(`relay connection error: ${err.message}`);
    });
  }

  private handleMessage(raw: string): void {
    const parsed = parseJson(raw);
    if (!parsed.ok) {
      this.options.log(`ignoring malformed relay message`);
      return;
    }
    const value = parsed.value as Record<string, unknown>;

    if (RelayWelcome.safeParse(value).success) {
      this.attempts = 0;
      this.options.log("connected to relay");
      this.options.onOnline();
      return;
    }
    if (RelayReject.safeParse(value).success) {
      const reject = value as unknown as RelayReject;
      this.options.log(`relay rejected connection: ${reject.message}`);
      this.options.onRejected(reject.code, reject.message);
      this.stop();
      return;
    }
    const route = RelayRoute.safeParse(value);
    if (route.success) {
      this.options.onRoute(route.data.from, route.data.frame);
      return;
    }
    if (RelayHello.safeParse(value).success) {
      return;
    }
    this.options.log(`ignoring unexpected relay message: ${String(value["type"])}`);
  }

  private sendJson(value: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(value));
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return;
    const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** this.attempts);
    const delay = Math.round(backoff * (0.7 + Math.random() * 0.6));
    this.attempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
