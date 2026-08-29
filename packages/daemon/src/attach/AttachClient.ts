import { b64ToBytes, bytesToB64, frame, parseJson, utf8Bytes } from "rcmdsh-core";
import { parseDaemonToBridge, type DaemonToBridgeMessage } from "rcmdsh-core";
import * as nodePty from "node-pty";
import WebSocket from "ws";
import { loadConfig } from "../config";
import { allowedShellsForPlatform } from "../pty/shells";
import { startRawPipe } from "./rawPipe";

export interface AttachClientOptions {
  gatewayUrl: string;
  token: string;
  shellId: string | null;
  bridgeId?: string;
  log: (message: string) => void;
}

const CONNECT_ATTEMPTS = 5;
const CONNECT_RETRY_MS = 500;

// Runs inside a visible terminal window (or any existing prompt): spawns the
// shell locally under its own PTY and tees everything between the local
// console and the daemon's attach gateway, so the phone and the local window
// drive the same session.
export async function runAttach(options: AttachClientOptions): Promise<void> {
  const config = loadConfig();
  const allowed = allowedShellsForPlatform(config.allowedShells);
  const shell = options.shellId
    ? allowed.find((s) => s.id === options.shellId)
    : allowed[0];
  if (!shell) {
    options.log(`shell "${options.shellId ?? ""}" is not allowed remotely - edit allowedShells in the config`);
    process.exitCode = 1;
    return;
  }

  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  const ws = await connectWithRetry(options);
  if (!ws) {
    options.log(`could not reach the daemon at ${options.gatewayUrl} - is it running?`);
    process.exitCode = 1;
    return;
  }

  let sessionId: string | null = null;
  let remoteAlive = false;
  let exitReported = false;

  const pty = nodePty.spawn(shell.command, shell.args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
  });

  const sendToDaemon = (message: Record<string, unknown>): boolean => {
    if (!remoteAlive) return false;
    try {
      ws.send(JSON.stringify(frame(message)));
      return true;
    } catch {
      return false;
    }
  };

  const reportExit = (code: number) => {
    if (exitReported) return;
    exitReported = true;
    sendToDaemon({ type: "bridge.exit", id: sessionId ?? "", exitCode: code });
    try {
      ws.close();
    } catch {
      // already closed
    }
  };

  ws.on("message", (raw) => {
    const parsed = parseJson(String(raw));
    if (!parsed.ok) return;
    const result = parseDaemonToBridge(parsed.value);
    if (!result.ok) return;
    const message: DaemonToBridgeMessage = result.value;
    switch (message.type) {
      case "bridge.welcome": {
        sessionId = message.id;
        remoteAlive = true;
        break;
      }
      case "bridge.input": {
        pty.write(new TextDecoder().decode(b64ToBytes(message.data)));
        break;
      }
      case "bridge.kill": {
        try {
          pty.kill();
        } catch {
          reportExit(0);
          process.exit(0);
        }
        break;
      }
      case "bridge.error": {
        options.log(`daemon: ${message.code} - ${message.message}`);
        if (message.code === "bad_token" || message.code === "too_many_sessions") {
          try {
            pty.kill();
          } catch {
            process.exit(1);
          }
        }
        break;
      }
    }
  });

  ws.on("close", () => {
    if (!remoteAlive) return;
    remoteAlive = false;
    options.log("connection to the daemon lost - the shell keeps running in this window");
  });

  ws.on("error", () => {
    // close event follows
  });

  const rawPipe = startRawPipe(process.stdin, process.stdout, {
    onData: (data) => pty.write(data),
    onResize: (nextCols, nextRows) => {
      try {
        pty.resize(nextCols, nextRows);
      } catch {
        // pty may have just exited
      }
      if (sessionId) {
        sendToDaemon({ type: "bridge.resize", id: sessionId, cols: nextCols, rows: nextRows });
      }
    },
  });

  pty.onData((data) => {
    process.stdout.write(data);
    if (sessionId) {
      sendToDaemon({ type: "bridge.output", id: sessionId, data: bytesToB64(utf8Bytes(data)) });
    }
  });

  pty.onExit(({ exitCode }) => {
    rawPipe.stop();
    reportExit(exitCode);
    setTimeout(() => process.exit(0), 100);
  });

  try {
    ws.send(
      JSON.stringify(
        frame({
          type: "bridge.hello",
          token: options.token,
          shell: shell.id,
          cols,
          rows,
          pid: typeof pty.pid === "number" ? pty.pid : null,
          ...(options.bridgeId ? { bridgeId: options.bridgeId } : {}),
        }),
      ),
    );
  } catch {
    // gateway vanished between connect and hello; close handler reports it
  }
  options.log(`shared session started (${shell.name}) - type exit or close this window to end it`);
}

async function connectWithRetry(options: AttachClientOptions): Promise<WebSocket | null> {
  for (let attempt = 0; attempt < CONNECT_ATTEMPTS; attempt++) {
    const ws = await connectOnce(options.gatewayUrl);
    if (ws) return ws;
    await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_MS));
  }
  return null;
}

function connectOnce(url: string): Promise<WebSocket | null> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { handshakeTimeout: 3000 });
    const settle = (result: WebSocket | null) => {
      ws.removeAllListeners();
      resolve(result);
    };
    ws.once("open", () => settle(ws));
    ws.once("error", () => {
      try {
        ws.terminate();
      } catch {
        // already dead
      }
      settle(null);
    });
  });
}
