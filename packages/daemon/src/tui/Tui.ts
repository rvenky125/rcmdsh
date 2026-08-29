import { startRawPipe } from "../attach/rawPipe";
import type { LocalTuiHooks } from "../app";
import type { SessionSummary } from "../pty/SessionManager";

const ALT_SCREEN_ON = "\x1b[?1049h";
const ALT_SCREEN_OFF = "\x1b[?1049l";
const CURSOR_HIDE = "\x1b[?25l";
const CURSOR_SHOW = "\x1b[?25h";
const CLEAR = "\x1b[2J\x1b[H";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const REVERSE = "\x1b[7m";

const DETACH_PREFIX = "\x02"; // Ctrl+B, tmux-style
const FOOTER_KEYS =
  "↑/↓ or j/k move · a/Enter attach · n new session · x kill · r refresh · q quit";

type View = { name: "list" } | { name: "attach"; id: string };

export interface TuiOptions {
  deviceName: string;
  hooks: LocalTuiHooks;
}

// Keyboard-driven session list + attach view for the daemon's own console.
// Runs in the alternate screen buffer; q leaves the daemon running without the
// UI, Ctrl+C (in list view) shuts the daemon down.
export class Tui {
  private view: View = { name: "list" };
  private selected = 0;
  private prefixSeen = false;
  private stopped = false;
  private readonly logBuffer: string[] = [];
  private originalConsoleLog: ((...args: unknown[]) => void) | null = null;
  private pipe: ReturnType<typeof startRawPipe> | null = null;

  constructor(private readonly options: TuiOptions) {}

  start(): void {
    if (!process.stdout.isTTY || this.stopped) return;
    this.suppressLogs();
    process.stdout.write(ALT_SCREEN_ON + CURSOR_HIDE);
    this.pipe = startRawPipe(process.stdin, process.stdout, {
      onData: (data) => this.handleKey(data),
      onResize: (cols, rows) => this.handleResize(cols, rows),
    });
    this.render();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.restoreLogs();
    if (process.stdout.isTTY) {
      process.stdout.write(ALT_SCREEN_OFF + CURSOR_SHOW);
    }
    this.pipe?.stop();
    this.pipe = null;
  }

  // Called by the daemon for every session output chunk while the TUI lives.
  handleSessionOutput(sessionId: string, data: string): void {
    if (this.stopped) return;
    if (this.view.name === "attach" && this.view.id === sessionId) {
      process.stdout.write(data);
    }
  }

  // Called when sessions change (exit, bridge register, TUI create).
  refresh(): void {
    if (this.stopped) return;
    if (this.view.name === "attach") {
      const attachedId = this.view.id;
      const session = this.options.hooks
        .sessions()
        .find((s) => s.id === attachedId);
      if (!session || !session.alive) {
        this.showList(`session ${attachedId.slice(0, 8)} exited`);
        return;
      }
      return;
    }
    this.render();
  }

  private handleKey(data: string): void {
    if (this.view.name === "attach") {
      this.handleAttachKey(data);
      return;
    }
    if (data === "\x03") {
      // Ctrl+C in the list: shut the daemon down cleanly
      process.kill(process.pid, "SIGINT");
      return;
    }
    switch (data) {
      case "\x1b[A": // up arrow
      case "k": {
        this.move(-1);
        return;
      }
      case "\x1b[B": // down arrow
      case "j": {
        this.move(1);
        return;
      }
      case "\r":
      case "\n":
      case "a": {
        this.attachSelected();
        return;
      }
      case "n": {
        this.options.hooks.createDefaultSession();
        return;
      }
      case "x": {
        this.killSelected();
        return;
      }
      case "r": {
        this.render();
        return;
      }
      case "q": {
        this.stop();
        return;
      }
      default:
        return;
    }
  }

  private handleAttachKey(data: string): void {
    if (this.view.name !== "attach") return;
    const id = this.view.id;
    if (this.prefixSeen) {
      this.prefixSeen = false;
      if (data === "d") {
        this.showList();
        return;
      }
      // prefix followed by anything else: pass the prefix through first
      this.options.hooks.write(id, DETACH_PREFIX);
    }
    if (data === DETACH_PREFIX) {
      this.prefixSeen = true;
      return;
    }
    this.options.hooks.write(id, data);
  }

  private handleResize(cols: number, rows: number): void {
    if (this.view.name === "attach") {
      try {
        this.options.hooks.resize(this.view.id, cols, rows);
      } catch {
        // session may have just exited
      }
      return;
    }
    this.render();
  }

  private move(delta: number): void {
    const sessions = this.options.hooks.sessions();
    if (sessions.length === 0) return;
    this.selected = Math.min(sessions.length - 1, Math.max(0, this.selected + delta));
    this.render();
  }

  private attachSelected(): void {
    const sessions = this.options.hooks.sessions();
    const session = sessions[this.selected];
    if (!session || !session.alive) return;
    this.view = { name: "attach", id: session.id };
    this.prefixSeen = false;
    process.stdout.write(CURSOR_SHOW + CLEAR);
    process.stdout.write(
      `${DIM}[attached to ${session.shell} ${session.id.slice(0, 8)} - Ctrl+B then d to detach; the phone shares this session]${RESET}\r\n`,
    );
  }

  private killSelected(): void {
    const sessions = this.options.hooks.sessions();
    const session = sessions[this.selected];
    if (!session || !session.alive) return;
    try {
      this.options.hooks.kill(session.id);
    } catch {
      // already gone
    }
  }

  private showList(reason?: string): void {
    this.view = { name: "list" };
    this.prefixSeen = false;
    if (reason) {
      this.logBuffer.push(reason);
      if (this.logBuffer.length > 50) this.logBuffer.shift();
    }
    this.render();
  }

  private render(): void {
    if (this.stopped || this.view.name !== "list") return;
    const sessions = this.options.hooks.sessions();
    if (this.selected >= sessions.length) {
      this.selected = Math.max(0, sessions.length - 1);
    }
    const aliveCount = sessions.filter((s) => s.alive).length;
    const lines: string[] = [];
    lines.push(
      `${BOLD}rcmdsh${RESET} — ${this.options.deviceName}   ${DIM}${aliveCount} active session(s)${RESET}`,
    );
    lines.push("");
    if (sessions.length === 0) {
      lines.push(
        `${DIM}  no sessions yet - press n to open one, or create one from your phone${RESET}`,
      );
    } else {
      sessions.forEach((session, index) => {
        const marker = index === this.selected ? `${REVERSE} > ${RESET}` : "   ";
        const kind = session.origin === "bridge" ? "window" : "background";
        const state = session.alive ? "alive" : "exited";
        const line =
          `${marker}${session.id.slice(0, 8)}  ${session.shell.padEnd(12)} ${kind.padEnd(11)} ` +
          `${state.padEnd(9)} ${formatTime(session.createdAt)}${session.pid != null ? `  pid ${session.pid}` : ""}`;
        lines.push(session.alive ? line : `${DIM}${line}${RESET}`);
      });
    }
    lines.push("");
    lines.push(`${DIM}${FOOTER_KEYS}${RESET}`);
    const lastLog = this.logBuffer[this.logBuffer.length - 1];
    if (lastLog) {
      lines.push(`${DIM}${truncate(lastLog, process.stdout.columns ?? 80)}${RESET}`);
    }
    process.stdout.write(CLEAR + lines.join("\r\n") + "\r\n");
  }

  private suppressLogs(): void {
    this.originalConsoleLog = console.log;
    console.log = (...args: unknown[]) => {
      const message = args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
      this.logBuffer.push(message);
      if (this.logBuffer.length > 50) this.logBuffer.shift();
      this.render();
    };
  }

  private restoreLogs(): void {
    if (this.originalConsoleLog) {
      console.log = this.originalConsoleLog;
      this.originalConsoleLog = null;
    }
  }
}

function formatTime(createdAt: number): string {
  return new Date(createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function truncate(text: string, width: number): string {
  const line = text.replace(/\x1b\[[0-9;]*m/g, "").split("\n")[0] ?? "";
  return line.length > width - 2 ? line.slice(0, Math.max(0, width - 5)) + "..." : line;
}
