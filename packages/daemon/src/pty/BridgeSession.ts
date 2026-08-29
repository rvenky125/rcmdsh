import { b64ToBytes, bytesToB64, frame, utf8Bytes } from "rcmdsh-core";
import { OutputBatcher, Scrollback } from "./SessionManager";
import type { SessionEvents, SessionHandle, SessionSummary } from "./SessionManager";

export interface BridgeSocketLike {
  send(data: string): void;
  close(): void;
}

const KILL_FALLBACK_MS = 3000;

// Daemon-side view of a session that lives inside an `rcmdsh attach` client.
// The gateway feeds inbound frames into handle*; SessionHandle methods send
// frames back over the local websocket.
export class BridgeSession implements SessionHandle {
  readonly id: string;
  readonly shellId: string;
  readonly title: string;
  readonly createdAt: number;
  readonly pid: number | null;
  cols: number;
  rows: number;
  alive = true;
  exitCode: number | null = null;

  private readonly socket: BridgeSocketLike;
  private readonly events: SessionEvents;
  private readonly scrollback = new Scrollback();
  private readonly batcher: OutputBatcher;
  private killFallbackTimer: NodeJS.Timeout | null = null;
  private killSent = false;

  constructor(
    id: string,
    shellId: string,
    socket: BridgeSocketLike,
    events: SessionEvents,
    pid: number | null,
    cols: number,
    rows: number,
  ) {
    this.id = id;
    this.shellId = shellId;
    this.title = shellId;
    this.createdAt = Date.now();
    this.pid = pid;
    this.cols = cols;
    this.rows = rows;
    this.socket = socket;
    this.events = events;
    this.batcher = new OutputBatcher((blob) => this.events.onOutput(this.id, blob));
  }

  // ---- inbound from the attach gateway ----

  handleOutput(data: string): void {
    if (!this.alive) return;
    this.scrollback.push(data);
    this.batcher.push(data);
  }

  handleResize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }

  handleExit(exitCode: number | null): void {
    if (!this.alive) return;
    this.alive = false;
    this.exitCode = exitCode;
    this.clearKillFallback();
    this.batcher.flushNow();
    this.events.onExit(this.id, exitCode);
  }

  handleDisconnect(): void {
    this.handleExit(null);
  }

  // ---- SessionHandle ----

  write(data: string): void {
    if (!this.alive) return;
    this.send({ type: "bridge.input", id: this.id, data: bytesToB64(utf8Bytes(data)) });
  }

  resize(cols: number, rows: number): void {
    if (!this.alive) return;
    this.cols = cols;
    this.rows = rows;
    this.send({ type: "bridge.resize", id: this.id, cols, rows });
  }

  kill(): void {
    if (!this.alive || this.killSent) return;
    this.killSent = true;
    this.send({ type: "bridge.kill", id: this.id });
    // The bridge normally answers with bridge.exit; if it is stuck or gone
    // without a close event, retire the session anyway.
    if (this.killFallbackTimer === null) {
      this.killFallbackTimer = setTimeout(() => {
        this.killFallbackTimer = null;
        this.handleExit(null);
      }, KILL_FALLBACK_MS);
    }
  }

  replay(): string {
    return this.scrollback.read();
  }

  summary(): SessionSummary {
    return {
      id: this.id,
      shell: this.shellId,
      title: this.title,
      createdAt: this.createdAt,
      alive: this.alive,
      origin: "bridge",
      pid: this.pid,
    };
  }

  // ---- helpers ----

  private send(message: Record<string, unknown>): void {
    try {
      this.socket.send(JSON.stringify(frame(message)));
    } catch {
      // socket is closing; handleDisconnect will retire the session
    }
  }

  private clearKillFallback(): void {
    if (this.killFallbackTimer !== null) {
      clearTimeout(this.killFallbackTimer);
      this.killFallbackTimer = null;
    }
  }
}

export function bridgeInputToText(data: string): string {
  return new TextDecoder().decode(b64ToBytes(data));
}
