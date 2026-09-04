import { bytesToB64, type DaemonToClientMessage } from "rcmdsh-core";
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { RelaySocket } from "../lib/ws";

type OutputListener = (message: DaemonToClientMessage) => void;

const RESIZE_DEBOUNCE_MS = 100;

// How long a predicted keystroke waits for the server's echo before we
// assume echo is off (password prompt) and erase it from the screen.
const PREDICT_CONFIRM_MS = 800;

function commonPrefixLen(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

const ANSI_CSI = /\x1b\[[0-9;:]*[A-Za-z]/g;
const ANSI_OSC = /\x1b\][^\x07]*(\x07|\x1b\\)/g;
// Codes that erase/insert/scroll content. A blob containing them may repaint
// the screen, so the echo reconciler must never swallow it and any pending
// prediction is stale. Positioning (ABCDEFGHf), visibility (?25h/l) and color
// (m) codes are safe: PSReadLine wraps every keystroke emit in them.
const CONTENT_CHANGE = /\x1b\[[0-9;:]*[JKLMPSTX@]/;

function stripAnsi(text: string): string {
  return text.replace(ANSI_OSC, "").replace(ANSI_CSI, "");
}

interface TerminalScreenProps {
  socket: RelaySocket;
  sessionId: string;
  sessionTitle: string;
  subscribe: (listener: OutputListener) => () => void;
  onBack: () => void;
}

function encodeInput(text: string): string {
  return bytesToB64(new TextEncoder().encode(text));
}

export function TerminalScreen({ socket, sessionId, sessionTitle, subscribe, onBack }: TerminalScreenProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const ctrlModeRef = useRef(false);
  const ctrlButtonRef = useRef<HTMLButtonElement>(null);
  const enqueueInputRef = useRef<(data: string) => void>(() => {});

  useEffect(() => {
    const term = new Terminal({
      fontFamily: "Menlo, Consolas, 'Courier New', monospace",
      fontSize: 13,
      theme: {
        background: "#0b1220",
        foreground: "#e2e8f0",
        cursor: "#22d3ee",
        selectionBackground: "#1e3a5f",
      },
      scrollback: 2000,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current!);

    let pending = "";
    let rafId: number | null = null;

    const flushInput = () => {
      rafId = null;
      if (pending.length === 0) return;
      const out = pending;
      pending = "";
      socket.request({ type: "session.input", id: sessionId, data: encodeInput(out) });
    };

    // Predictive local echo (mosh-lite): printable keystrokes are rendered
    // immediately so typing feels instant, then the server's echo of those
    // exact characters is swallowed on arrival (longest-prefix match).
    // Programs that redraw the line (PSReadLine, vim) simply paint over the
    // prediction, and keystrokes the server never echoes (password prompts)
    // are erased after PREDICT_CONFIRM_MS so secrets never linger.
    let unconfirmed = "";
    let probing = false; // after a no-echo cycle, predict single-char probes only
    let eraseTimer: number | null = null;

    const cancelErase = () => {
      if (eraseTimer !== null) {
        window.clearTimeout(eraseTimer);
        eraseTimer = null;
      }
    };

    const scheduleErase = () => {
      cancelErase();
      eraseTimer = window.setTimeout(() => {
        eraseTimer = null;
        if (unconfirmed.length === 0) return;
        term.write("\b \b".repeat(unconfirmed.length));
        unconfirmed = "";
        probing = true;
      }, PREDICT_CONFIRM_MS);
    };

    const isPredictable = (data: string): boolean => {
      if (data.length !== 1) return false;
      const code = data.charCodeAt(0);
      return code >= 32 && code <= 126;
    };

    const enqueueInput = (data: string) => {
      pending += data;
      if (rafId === null) rafId = requestAnimationFrame(flushInput);
      if ((probing ? unconfirmed.length === 0 : true) && isPredictable(data)) {
        unconfirmed += data;
        term.write(data);
        scheduleErase();
      }
    };
    enqueueInputRef.current = enqueueInput;

    const flushBeforeUnload = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      flushInput();
    };

    term.onData(enqueueInput);
    window.addEventListener("beforeunload", flushBeforeUnload);

    const doFit = () => {
      try {
        fitAddon.fit();
      } catch {
        // container may be hidden mid-layout
      }
    };
    let resizeTimer: number | null = null;
    const sendResize = (cols: number, rows: number) => {
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        resizeTimer = null;
        socket.request({
          type: "session.resize",
          id: sessionId,
          cols: Math.max(2, cols),
          rows: Math.max(2, rows),
        });
      }, RESIZE_DEBOUNCE_MS);
    };
    term.onResize(({ cols, rows }) => sendResize(cols, rows));
    doFit();
    window.addEventListener("resize", doFit);
    window.visualViewport?.addEventListener("resize", doFit);
    // The container (not the window) is what the terminal must fill; observing
    // it catches devtools docking, mobile URL-bar collapses and any layout
    // shift that plain window resize events miss.
    const resizeObserver =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => doFit()) : null;
    resizeObserver?.observe(containerRef.current!);

    const requestAttach = () => {
      socket.request({
        type: "session.attach",
        id: sessionId,
        cols: Math.max(2, term.cols),
        rows: Math.max(2, term.rows),
      });
    };
    requestAttach();

    const onMessage: OutputListener = (message) => {
      if (message.type === "session.output" && message.id === sessionId) {
        const bytes = Uint8Array.from(atob(message.data), (c) => c.charCodeAt(0));
        const text = new TextDecoder().decode(bytes);
        if (unconfirmed.length > 0) {
          // Plain echo (cmd.exe, bash): the blob starts with exactly the
          // predicted characters.
          const direct = commonPrefixLen(text, unconfirmed);
          if (direct > 0) {
            unconfirmed = unconfirmed.slice(direct);
            probing = false;
            cancelErase();
            if (unconfirmed.length > 0) scheduleErase();
            term.write(text.slice(direct));
            return;
          }
          if (!CONTENT_CHANGE.test(text) && !text.includes("\r")) {
            // Control-only preamble (cursor visibility/positioning before the
            // emit): apply it and keep waiting for the echo.
            if (stripAnsi(text).length === 0) {
              term.write(text);
              return;
            }
            // Styled echo (PSReadLine emits each keystroke wrapped in cursor
            // and color codes): if the visible text starts with the
            // prediction, the server merely re-rendered what we already
            // showed — swallow the matched part instead of drawing it twice.
            const styled = commonPrefixLen(stripAnsi(text), unconfirmed);
            if (styled > 0) {
              let seen = 0;
              let idx = 0;
              while (seen < styled && idx < text.length) {
                const rest = text.slice(idx);
                const code = rest.match(/^(\x1b\[[0-9;:]*[A-Za-z]|\x1b\][^\x07]*(\x07|\x1b\\))/);
                if (code) {
                  idx += code[0].length;
                  continue;
                }
                idx++;
                seen++;
              }
              unconfirmed = unconfirmed.slice(styled);
              probing = false;
              cancelErase();
              if (unconfirmed.length > 0) scheduleErase();
              term.write(text.slice(idx));
              return;
            }
          }
          // Not our echo (masked prompts like Read-Host -AsSecureString that
          // emit "*", full-screen repaints, async writes): erase the
          // prediction first — a repaint redraws its region anyway, but a
          // leaked password character would never be taken back — then
          // render the blob raw.
          term.write("\b \b".repeat(unconfirmed.length));
          unconfirmed = "";
          cancelErase();
        }
        term.write(text);
      } else if (message.type === "session.exit" && message.id === sessionId) {
        cancelErase();
        unconfirmed = "";
        term.write(`\r\n\x1b[33m[session exited with code ${message.exitCode ?? "?"}]\x1b[0m\r\n`);
      }
    };
    const unsubscribe = subscribe(onMessage);

    const onKeyDown = (e: KeyboardEvent) => {
      if (!ctrlModeRef.current) return;
      if (e.key.length === 1 && !e.altKey && !e.metaKey) {
        const code = e.key.toLowerCase().charCodeAt(0);
        if (code >= 97 && code <= 122) {
          e.preventDefault();
          e.stopPropagation();
          enqueueInput(String.fromCharCode(code - 96));
          ctrlModeRef.current = false;
          ctrlButtonRef.current?.classList.remove("active");
        }
      }
    };
    term.textarea?.addEventListener("keydown", onKeyDown, true);

    const focusTerminal = () => term.focus();
    containerRef.current!.addEventListener("click", focusTerminal);

    return () => {
      cancelErase();
      unsubscribe();
      resizeObserver?.disconnect();
      window.removeEventListener("resize", doFit);
      window.visualViewport?.removeEventListener("resize", doFit);
      window.removeEventListener("beforeunload", flushBeforeUnload);
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      term.textarea?.removeEventListener("keydown", onKeyDown, true);
      containerRef.current?.removeEventListener("click", focusTerminal);
      term.dispose();
    };
  }, [socket, sessionId, subscribe]);

  const sendKey = (data: string) => {
    enqueueInputRef.current(data);
  };

  return (
    <div className="terminal-screen">
      <div className="terminal-header">
        <button className="btn ghost" onClick={onBack} aria-label="Back">
          &larr;
        </button>
        <span className="terminal-title">{sessionTitle}</span>
        <button
          className="btn danger"
          onClick={() => {
            socket.request({ type: "session.kill", id: sessionId });
            onBack();
          }}
        >
          Kill
        </button>
      </div>
      <div ref={containerRef} className="terminal-container" />
      <div className="toolbar">
        <button className="key" onClick={() => sendKey("\x1b")}>Esc</button>
        <button className="key" onClick={() => sendKey("\t")}>Tab</button>
        <button
          ref={ctrlButtonRef}
          className="key"
          onClick={() => {
            ctrlModeRef.current = !ctrlModeRef.current;
            ctrlButtonRef.current?.classList.toggle("active", ctrlModeRef.current);
          }}
        >
          Ctrl
        </button>
        <button className="key" onClick={() => sendKey("\x1b[A")}>&uarr;</button>
        <button className="key" onClick={() => sendKey("\x1b[B")}>&darr;</button>
        <button className="key" onClick={() => sendKey("\x1b[C")}>&rarr;</button>
        <button className="key" onClick={() => sendKey("\x1b[D")}>&larr;</button>
        <button className="key" onClick={() => sendKey("\x03")}>^C</button>
        <button className="key" onClick={() => sendKey("\x04")}>^D</button>
        <button className="key wide" onClick={() => sendKey("\r")}>&crarr;</button>
      </div>
    </div>
  );
}
