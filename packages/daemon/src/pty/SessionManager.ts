import * as nodePty from "node-pty";
import os from "node:os";
import { randomId } from "@rcmdsh/shared";
import type { ShellDef } from "./shells";

const SCROLLBACK_BYTES = 128 * 1024;
const OUTPUT_FLUSH_MS = 16;
const MAX_SESSIONS = 50;

export class UnknownSessionError extends Error {
  constructor(id: string) {
    super(`unknown session: ${id}`);
    this.name = "UnknownSessionError";
  }
}

class Scrollback {
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
}

export class Session {
  readonly id: string;
  readonly shellId: string;
  readonly title: string;
  readonly createdAt: number;
  alive = true;
  exitCode: number | null = null;

  private readonly scrollback = new Scrollback();
  private pending: string[] = [];
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    id: string,
    shellId: string,
    private readonly process: nodePty.IPty,
    private readonly events: SessionEvents,
  ) {
    this.id = id;
    this.shellId = shellId;
    this.title = shellId;
    this.createdAt = Date.now();

    this.process.onData((data) => {
      this.scrollback.push(data);
      this.queueOutput(data);
    });
    this.process.onExit(({ exitCode }) => {
      this.alive = false;
      this.exitCode = exitCode;
      this.flushNow();
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
    };
  }

  private queueOutput(data: string): void {
    this.pending.push(data);
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => this.flushNow(), OUTPUT_FLUSH_MS);
    }
  }

  private flushNow(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pending.length === 0) return;
    const blob = this.pending.join("");
    this.pending = [];
    if (blob.length > 0) {
      this.events.onOutput(this.id, blob);
    }
  }
}

export interface CreateOptions {
  cols: number;
  rows: number;
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly events: SessionEvents) {}

  create(shell: ShellDef, options: CreateOptions): Session {
    if (this.aliveCount() >= MAX_SESSIONS) {
      this.evictOldestDead();
      if (this.aliveCount() >= MAX_SESSIONS) {
        throw new Error("too many active sessions");
      }
    }
    const id = randomId();
    const ptyProcess = nodePty.spawn(shell.command, shell.args, {
      name: "xterm-256color",
      cols: options.cols,
      rows: options.rows,
      cwd: os.homedir(),
      env: process.env as Record<string, string>,
    });
    const session = new Session(id, shell.id, ptyProcess, this.events);
    this.sessions.set(id, session);
    return session;
  }

  get(id: string): Session {
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
    let oldest: Session | null = null;
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
