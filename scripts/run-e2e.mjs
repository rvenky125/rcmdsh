#!/usr/bin/env node
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RELAY_DB = join(ROOT, "e2e-relay.db");
const DEV_TOKEN = "rcm_dev_local_token";
const DAEMON_TOKEN = DEV_TOKEN;
const CLIENT_TOKEN = DEV_TOKEN;
// Override with RCMDSH_E2E_PORT when 8787 is already in use (e.g. a relay you
// are running manually).
const PORT = Number(process.env.RCMDSH_E2E_PORT ?? 8787);
const RELAY_URL = `http://127.0.0.1:${PORT}`;
const RELAY_WS = `ws://127.0.0.1:${PORT}`;
const DAEMON_HOME = join(ROOT, "e2e-daemon-home");

let relayProc = null;
let daemonProc = null;
let ws = null;
let msgId = 0;
let exited = false;

const inbox = [];
const frame = (fields) => ({ v: 1, msgId: `m${++msgId}`, ts: Date.now(), ...fields });

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

async function waitFor(predicate, label, timeoutMs = 15000) {
  const start = Date.now();
  const seenCount = inbox.length;
  while (Date.now() - start < timeoutMs) {
    const found = inbox.find((m) => predicate(m));
    if (found) return found;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function waitForNew(predicate, label, afterCount, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = inbox.slice(afterCount).find((m) => predicate(m));
    if (found) return found;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function startRelay() {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [
      join(ROOT, "packages", "relay", "dist", "index.js"),
      "--port", String(PORT),
      "--db", RELAY_DB,
      "--web", join(ROOT, "packages", "web", "dist"),
      "--dev-token", DEV_TOKEN,
    ], { stdio: ["ignore", "pipe", "pipe"] });

    relayProc = child;
    child.stdout.on("data", (d) => process.stdout.write("[relay] " + d));
    child.stderr.on("data", (d) => process.stderr.write("[relay!] " + d));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0 && !exited) reject(new Error(`relay exited ${code}`));
    });

    // wait for health endpoint
    const poll = setInterval(() => {
      fetch(`${RELAY_URL}/health`)
        .then((r) => r.json())
        .then(() => { clearInterval(poll); resolve(); })
        .catch(() => {});
    }, 200);
    setTimeout(() => { clearInterval(poll); reject(new Error("relay health timeout")); }, 30000);
  });
}

async function startDaemon() {
  const res = await fetch(`${RELAY_URL}/v1/debug/tokens`);
  const debug = await res.json();
  console.log("[e2e] DB tokens:", JSON.stringify(debug.tokens));

  return new Promise((resolve, reject) => {
    const child = spawn("node", [
      join(ROOT, "packages", "daemon", "dist", "index.js"),
      "start",
      "--relay", RELAY_URL,
      "--insecure-dev-token", DAEMON_TOKEN,
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, RCMDSH_HOME: DAEMON_HOME },
    });

    daemonProc = child;
    child.stdout.on("data", (d) => process.stdout.write("[daemon] " + d));
    child.stderr.on("data", (d) => process.stderr.write("[daemon!] " + d));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0 && !exited) reject(new Error(`daemon exited ${code}`));
    });

    // wait for daemon to connect
    const poll = setInterval(() => {
      fetch(`${RELAY_URL}/health`)
        .then((r) => r.json())
        .then((j) => { if (j.relay === undefined) { clearInterval(poll); resolve(); } })
        .catch(() => {});
    }, 200);
    setTimeout(() => { clearInterval(poll); reject(new Error("daemon startup timeout")); }, 30000);
  });
}

async function runClient() {
  ws = new WebSocket(`${RELAY_WS}/ws/client`);
  ws.on("message", (raw) => inbox.push(JSON.parse(String(raw))));
  ws.on("error", (e) => console.error("ws error:", e.message));

  await new Promise((r, rej) => {
    ws.on("open", r);
    setTimeout(() => rej(new Error("client connect timeout")), 15000);
  });

  send(frame({ type: "relay.hello", role: "client", token: CLIENT_TOKEN }));
  await waitFor((m) => m.type === "relay.welcome", "welcome");
  console.log("PASS  relay welcome");

  const status = await waitFor((m) => m.type === "relay.status" && m.daemonOnline === true, "daemon online");
  console.log("PASS  daemon online:", status.daemonOnline);

  send(frame({ type: "sessions.list" }));
  const list = await waitFor((m) => m.type === "sessions.list", "sessions list");
  console.log("PASS  sessions.list round-trips,", list.sessions.length, "sessions");

  send(frame({ type: "session.create", shell: process.platform === "win32" ? "powershell" : "bash", cols: 80, rows: 24 }));
  const created = await waitFor((m) => m.type === "sessions.list" && m.sessions.some((s) => s.alive), "created session");
  const session = created.sessions.find((s) => s.alive);
  console.log("PASS  session created:", session.id.slice(0, 8), "shell:", session.shell);

  const marker = "e2e_marker_" + Date.now();
  const encoded = Buffer.from(marker + "\r\n").toString("base64");
  send(frame({ type: "session.input", id: session.id, data: encoded }));
  const output = await waitFor(
    (m) => m.type === "session.output" && Buffer.from(m.data, "base64").toString("utf8").includes(marker),
    "echoed marker",
  );
  console.log("PASS  session.input echoed:", marker.slice(0, 20));

  send(frame({ type: "session.resize", id: session.id, cols: 120, rows: 40 }));
  console.log("PASS  session.resize sent");

  send(frame({ type: "session.attach", id: session.id }));
  const replay = await waitFor(
    (m) => m.type === "session.output" && Buffer.from(m.data, "base64").toString("utf8").includes(marker),
    "scrollback replay",
  );
  console.log("PASS  session.attach replays scrollback");

  const afterExitCount = inbox.length;
  send(frame({ type: "session.kill", id: session.id }));
  const exit = await waitForNew(
    (m) => m.type === "session.exit" && m.id === session.id,
    "exit event",
    afterExitCount,
  );
  console.log("PASS  session.exit:", exit.exitCode);

  const after = await waitForNew(
    (m) => m.type === "sessions.list" && m.sessions.some((s) => s.id === session.id && !s.alive),
    "post-exit list",
    afterExitCount,
  );
  console.log("PASS  sessions list reflects exit:", after.sessions.length, "sessions");
}

async function cleanup() {
  exited = true;
  if (ws) ws.close();
  await new Promise((r) => setTimeout(r, 500));
  if (daemonProc) daemonProc.kill();
  await new Promise((r) => setTimeout(r, 500));
  if (relayProc) relayProc.kill();
}

try {
  await startRelay();
  await startDaemon();
  await runClient();
  console.log("\nAll checks passed.");
} catch (err) {
  console.error("\nE2E failed:", err.message);
  process.exitCode = 1;
} finally {
  await cleanup();
}
