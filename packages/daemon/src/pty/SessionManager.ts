import * as nodePty from "node-pty";
import os from "node:os";
import { randomId } from "rcmdsh-core";
import type { ShellDef } from "./shells";
import { describeSpawnError } from "./spawnEnv";

const SCROLLBACK_BYTES = 128 * 1024;
const OUTPUT_FLUSH_MS = 16;
const MAX_SESSIONS = 50;

export class UnknownSessionError extends Error {
  constructor(id: string) {
    super(`unknown session: ${id}`);
    this.name = "UnknownSessionError";
  }
}

export class Scrollback {
  private chunks: string[] = [];
  private total = 0;

  constructor(private readonly capacity: number = SCROLLBACK_BYTES) {}

  push(data: string): void {
    this.chunks.push(data);
    this.total += data.length;
    while (this.total > this.capacity && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!;
      this.total -= dropped.length;
    }
  }

  read(): string {
    return this.chunks.join("");
  }
}

export class OutputBatcher {
  private pending: string[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly flush: (blob: string) => void,
    private readonly delayMs: number = OUTPUT_FLUSH_MS,
  ) {}

  push(data: string): void {
    this.pending.push(data);
    if (this.timer === null) {
      this.timer = setTimeout(() => this.flushNow(), this.delayMs);
    }
  }

  flushNow(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.length === 0) return;
    const blob = this.pending.join("");
    this.pending = [];
    if (blob.length > 0) {
      this.flush(blob);
    }
  }
}

export interface SessionEvents {
  onOutput(sessionId: string, data: string): void;
  onExit(sessionId: string, exitCode: number | null): void;
}

export interface SessionSummary {
  id: string;
  shell: string;
  title: string;
  createdAt: number;
  alive: boolean;
  origin: "pty" | "bridge";
  pid: number | null;
}

export interface SessionHandle {
  readonly id: string;
  readonly shellId: string;
  readonly title: string;
  readonly createdAt: number;
  alive: boolean;
  exitCode: number | null;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  replay(): string;
  summary(): SessionSummary;
}

export class Session implements SessionHandle {
  readonly id: string;
  readonly shellId: string;
  readonly title: string;
  readonly createdAt: number;
  readonly pid: number | null;
  alive = true;
  exitCode: number | null = null;
  cols: number;
  rows: number;

  private readonly scrollback = new Scrollback();
  private readonly batcher: OutputBatcher;

  constructor(
    id: string,
    shellId: string,
    private readonly process: nodePty.IPty,
    private readonly events: SessionEvents,
    cols: number,
    rows: number,
  ) {
    this.id = id;
    this.shellId = shellId;
    this.title = shellId;
    this.createdAt = Date.now();
    this.pid = typeof process.pid === "number" ? process.pid : null;
    this.cols = cols;
    this.rows = rows;
    this.batcher = new OutputBatcher((blob) => this.events.onOutput(this.id, blob));

    this.process.onData((data) => {
      this.scrollback.push(data);
      this.batcher.push(data);
    });
    this.process.onExit(({ exitCode }) => {
      this.alive = false;
      this.exitCode = exitCode;
      this.batcher.flushNow();
      this.events.onExit(this.id, exitCode);
    });
  }

  write(data: string): void {
    if (this.alive) {
      this.process.write(data);
    }
  }

  resize(cols: number, rows: number): void {
    if (this.alive) {
      try {
        this.process.resize(cols, rows);
        this.cols = cols;
        this.rows = rows;
      } catch {
        // resizing a just-exited pty can throw; nothing to do
      }
    }
  }

  kill(): void {
    if (this.alive) {
      try {
        this.process.kill();
      } catch {
        this.alive = false;
      }
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
      origin: "pty",
      pid: this.pid,
    };
  }
}

export interface CreateOptions {
  cols: number;
  rows: number;
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionHandle>();

  constructor(private readonly events: SessionEvents) {}

  create(shell: ShellDef, options: CreateOptions): Session {
    if (this.aliveCount() >= MAX_SESSIONS) {
      this.evictOldestDead();
      if (this.aliveCount() >= MAX_SESSIONS) {
        throw new Error("too many active sessions");
      }
    }
    const id = randomId();
    let ptyProcess: nodePty.IPty;
    try {
      ptyProcess = nodePty.spawn(shell.command, shell.args, {
        name: "xterm-256color",
        cols: options.cols,
        rows: options.rows,
        cwd: os.homedir(),
        env: process.env as Record<string, string>,
      });
    } catch (err) {
      throw new Error(describeSpawnError(err, shell.command));
    }
    const session = new Session(id, shell.id, ptyProcess, this.events, options.cols, options.rows);
    this.sessions.set(id, session);
    return session;
  }

  register(handle: SessionHandle): void {
    if (this.aliveCount() >= MAX_SESSIONS) {
      throw new Error("too many active sessions");
    }
    this.sessions.set(handle.id, handle);
  }

  unregister(id: string): void {
    this.sessions.delete(id);
  }

  get(id: string): SessionHandle {
    const session = this.sessions.get(id);
    if (!session) throw new UnknownSessionError(id);
    return session;
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  list(): SessionSummary[] {
    return Array.from(this.sessions.values()).map((session) => session.summary());
  }

  write(id: string, data: string): void {
    this.get(id).write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    this.get(id).resize(cols, rows);
  }

  kill(id: string): void {
    this.get(id).kill();
  }

  replay(id: string): string {
    return this.get(id).replay();
  }

  killAll(): void {
    for (const session of this.sessions.values()) {
      session.kill();
    }
  }

  private aliveCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.alive) count++;
    }
    return count;
  }

  private evictOldestDead(): void {
    let oldest: SessionHandle | null = null;
    for (const session of this.sessions.values()) {
      if (!session.alive && (oldest === null || session.createdAt < oldest.createdAt)) {
        oldest = session;
      }
    }
    if (oldest) {
      this.sessions.delete(oldest.id);
    }
  }
}
