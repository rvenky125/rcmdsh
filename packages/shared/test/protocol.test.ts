import { describe, expect, it } from "vitest";
import {
  ClientToDaemonMessage,
  DaemonToClientMessage,
  DaemonToBridgeMessage,
  BridgeToDaemonMessage,
  EncryptedFrame,
  frame,
  parseBridgeToDaemon,
  parseClientToDaemon,
  parseDaemonToBridge,
  parseDaemonToClient,
} from "../src/protocol";

describe("client-to-daemon messages", () => {
  it("round-trips every message type", () => {
    const messages = [
      frame({ type: "sessions.list" }),
      frame({ type: "session.create", shell: "powershell", cols: 120, rows: 40 }),
      frame({ type: "session.input", id: "s1", data: "ZGlyXHJcbg==" }),
      frame({ type: "session.resize", id: "s1", cols: 100, rows: 30 }),
      frame({ type: "session.kill", id: "s1" }),
    ];
    for (const msg of messages) {
      const parsed = parseClientToDaemon(JSON.parse(JSON.stringify(msg)));
      expect(parsed).toMatchObject({ ok: true });
      if (parsed.ok) {
        expect(parsed.value).toEqual(msg);
      }
    }
  });

  it("applies default terminal size", () => {
    const parsed = parseClientToDaemon(
      frame({ type: "session.create", shell: "bash" }),
    );
    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok && parsed.value.type === "session.create") {
      expect(parsed.value.cols).toBe(80);
      expect(parsed.value.rows).toBe(24);
    }
  });

  it("accepts the visible flag on session.create", () => {
    const parsed = parseClientToDaemon(
      frame({ type: "session.create", shell: "cmd", visible: true }),
    );
    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok && parsed.value.type === "session.create") {
      expect(parsed.value.visible).toBe(true);
    }
    const omitted = parseClientToDaemon(frame({ type: "session.create", shell: "cmd" }));
    expect(omitted.ok && omitted.value.type === "session.create" && omitted.value.visible).toBeFalsy();
  });

  it("rejects unknown types and missing envelope fields", () => {
    expect(parseClientToDaemon({ type: "nope" }).ok).toBe(false);
    expect(parseClientToDaemon({ type: "sessions.list", v: 2, msgId: "x", ts: 1 }).ok).toBe(false);
    expect(parseClientToDaemon({ type: "sessions.list", v: 1, ts: 1 }).ok).toBe(false);
    expect(parseClientToDaemon({ type: "session.input", v: 1, msgId: "x", ts: 1, id: "s" }).ok).toBe(false);
  });
});

describe("daemon-to-client messages", () => {
  it("round-trips every message type", () => {
    const messages = [
      frame({
        type: "sessions.list",
        sessions: [
          { id: "s1", shell: "bash", title: "bash", createdAt: 1, alive: true, origin: "pty", pid: 123 },
          { id: "s2", shell: "cmd", title: "cmd", createdAt: 2, alive: true, origin: "bridge", pid: 456 },
        ],
      }),
      frame({ type: "capabilities", shells: [{ id: "bash", name: "Bash" }] }),
      frame({ type: "session.output", id: "s1", data: "aGVsbG8=" }),
      frame({ type: "session.exit", id: "s1", exitCode: 0 }),
      frame({ type: "error", code: "not_found", message: "no such session" }),
    ];
    for (const msg of messages) {
      const parsed = parseDaemonToClient(JSON.parse(JSON.stringify(msg)));
      expect(parsed).toMatchObject({ ok: true });
    }
  });

  it("defaults origin and pid on session info for older clients", () => {
    const parsed = parseDaemonToClient(
      frame({
        type: "sessions.list",
        sessions: [{ id: "s1", shell: "bash", title: "bash", createdAt: 1, alive: true }],
      }),
    );
    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok && parsed.value.type === "sessions.list") {
      expect(parsed.value.sessions[0]).toMatchObject({ origin: "pty", pid: null });
    }
  });

  it("allows null exit code", () => {
    const parsed = parseDaemonToClient(frame({ type: "session.exit", id: "s1", exitCode: null }));
    expect(parsed).toMatchObject({ ok: true });
  });

  it("rejects malformed sessions", () => {
    expect(parseDaemonToClient(frame({ type: "sessions.list", sessions: "nope" })).ok).toBe(false);
  });
});

describe("frame helper", () => {
  it("stamps version, id and timestamp", () => {
    const f = frame({ type: "sessions.list" });
    expect(f.v).toBe(1);
    expect(f.msgId.length).toBeGreaterThan(0);
    expect(f.ts).toBeLessThanOrEqual(Date.now());
    expect(f.ts).toBeGreaterThan(Date.now() - 60_000);
  });
});

describe("schema guards", () => {
  it("validates encrypted frames", () => {
    const good = { v: 1, enc: true, msgId: "m", ts: 1, data: "AAAA" };
    expect(EncryptedFrame.safeParse(good).success).toBe(true);
    expect(EncryptedFrame.safeParse({ ...good, enc: false }).success).toBe(false);
    expect(EncryptedFrame.safeParse({ ...good, data: "" }).success).toBe(false);
  });

  it("zod discriminated unions reject duplicate-type ambiguity", () => {
    const result = ClientToDaemonMessage.safeParse(frame({ type: "session.create", shell: 42 }));
    expect(result.success).toBe(false);
    const result2 = DaemonToClientMessage.safeParse(frame({ type: "session.output", id: "s1" }));
    expect(result2.success).toBe(false);
  });
});

describe("bridge messages", () => {
  it("round-trips bridge-to-daemon messages", () => {
    const messages = [
      frame({ type: "bridge.hello", token: "tok", shell: "cmd", cols: 80, rows: 24, pid: 4242 }),
      frame({ type: "bridge.hello", token: "tok", shell: "cmd", cols: 80, rows: 24, pid: 4242, bridgeId: "pending-1" }),
      frame({ type: "bridge.output", id: "s1", data: "aGk=" }),
      frame({ type: "bridge.exit", id: "s1", exitCode: 0 }),
      frame({ type: "bridge.exit", id: "s1", exitCode: null }),
      frame({ type: "bridge.resize", id: "s1", cols: 120, rows: 40 }),
    ];
    for (const msg of messages) {
      const parsed = parseBridgeToDaemon(JSON.parse(JSON.stringify(msg)));
      expect(parsed).toMatchObject({ ok: true });
      if (parsed.ok) {
        expect(parsed.value).toEqual(msg);
      }
    }
  });

  it("round-trips daemon-to-bridge messages", () => {
    const messages = [
      frame({ type: "bridge.welcome", id: "s1", shell: "cmd" }),
      frame({ type: "bridge.input", id: "s1", data: "ZGlyXHJcbg==" }),
      frame({ type: "bridge.kill", id: "s1" }),
      frame({ type: "bridge.error", code: "bad_token", message: "nope" }),
    ];
    for (const msg of messages) {
      const parsed = parseDaemonToBridge(JSON.parse(JSON.stringify(msg)));
      expect(parsed).toMatchObject({ ok: true });
      if (parsed.ok) {
        expect(parsed.value).toEqual(msg);
      }
    }
  });

  it("defaults pid to null on bridge.hello", () => {
    const parsed = parseBridgeToDaemon(
      frame({ type: "bridge.hello", token: "tok", shell: "cmd", cols: 80, rows: 24 }),
    );
    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok && parsed.value.type === "bridge.hello") {
      expect(parsed.value.pid).toBeNull();
    }
  });

  it("rejects bridge messages with missing fields", () => {
    expect(parseBridgeToDaemon(frame({ type: "bridge.hello", shell: "cmd" })).ok).toBe(false);
    expect(parseBridgeToDaemon(frame({ type: "bridge.output", id: "s1" })).ok).toBe(false);
    expect(parseDaemonToBridge(frame({ type: "bridge.welcome" })).ok).toBe(false);
    expect(BridgeToDaemonMessage.safeParse(frame({ type: "bridge.nope" })).success).toBe(false);
  });
});
