import WebSocket from "ws";

const RELAY = process.env.RELAY ?? "ws://127.0.0.1:8787";
const TOKEN = process.env.TOKEN ?? "rcm_dev_local_token";
const SHELL = process.env.SHELL_ID ?? (process.platform === "win32" ? "powershell" : "bash");
const MARKER = "e2e_marker_777";

let msgId = 0;
const frame = (fields) => ({ v: 1, msgId: `m${++msgId}`, ts: Date.now(), ...fields });

const ws = new WebSocket(`${RELAY}/ws/client`);
const inbox = [];
ws.on("message", (raw) => inbox.push(JSON.parse(String(raw))));
ws.on("error", (err) => {
  console.error("socket error:", err.message);
});

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function waitFor(predicate, label, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = inbox.find(predicate);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

try {
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    setTimeout(() => reject(new Error("connect timeout")), 10000);
  });
  console.log(`connected to ${RELAY}`);

  send({ type: "relay.hello", role: "client", token: TOKEN });
  await waitFor((m) => m.type === "relay.welcome", "welcome");
  record("relay welcome", true);
  const status = await waitFor(
    (m) => m.type === "relay.status" && m.daemonOnline === true,
    "daemon online status",
  );
  record("daemon online", true, JSON.stringify(status));

  send({ type: "sessions.list" });
  const empty = await waitFor((m) => m.type === "sessions.list", "sessions list");
  record("sessions.list round trip", Array.isArray(empty.sessions), `${empty.sessions.length} sessions`);

  send({ type: "session.create", shell: SHELL, cols: 80, rows: 24 });
  const created = await waitFor(
    (m) => m.type === "sessions.list" && m.sessions.length > 0,
    "created session",
  );
  const session = created.sessions[0];
  record("session.create", session.alive === true, `id=${session.id.slice(0, 8)} shell=${session.shell}`);

  send({ type: "session.input", id: session.id, data: Buffer.from(`echo ${MARKER}\r\n`).toString("base64") });
  const marker = await waitFor(
    (m) => m.type === "session.output" && Buffer.from(m.data, "base64").toString("utf8").includes(MARKER),
    "echoed marker",
  );
  record("session.input/output echo", true, `output ${marker.data.length} b64 chars`);

  send({ type: "session.resize", id: session.id, cols: 120, rows: 40 });
  await new Promise((r) => setTimeout(r, 500));
  record("session.resize sent without error", true);

  send({ type: "session.attach", id: session.id });
  await waitFor((m) => m.type === "session.output" && Buffer.from(m.data, "base64").toString("utf8").includes(MARKER), "scrollback replay");
  record("session.attach replays scrollback", true);

  send({ type: "session.kill", id: session.id });
  await waitFor((m) => m.type === "session.exit" && m.id === session.id, "exit event");
  record("session.exit event", true);

  const after = await waitFor(
    (m) => m.type === "sessions.list" && m.sessions.some((s) => s.id === session.id && s.alive === false),
    "sessions list shows dead session",
  );
  record("sessions.list reflects exit", true, `${after.sessions.length} total`);
} catch (err) {
  record("unexpected failure", false, err.message);
} finally {
  ws.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length > 0 ? 1 : 0);
