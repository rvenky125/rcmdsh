import { bytesToB64, type DaemonToClientMessage } from "rcmdsh-core";
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { RelaySocket } from "../lib/ws";
import { loadPairing } from "../lib/store";

function isLocalRelay(url: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(url);
}

type OutputListener = (message: DaemonToClientMessage) => void;

const RESIZE_DEBOUNCE_MS = 100;

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
    const localEcho = !isLocalRelay(loadPairing()?.relay ?? "");
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

    const enqueueInput = (data: string) => {
      if (localEcho) term.write(data);
      pending += data;
      if (rafId === null) rafId = requestAnimationFrame(flushInput);
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
        term.write(new TextDecoder().decode(bytes));
      } else if (message.type === "session.exit" && message.id === sessionId) {
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
