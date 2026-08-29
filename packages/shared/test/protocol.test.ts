import { describe, expect, it } from "vitest";
import {
  ClientToDaemonMessage,
  DaemonToClientMessage,
  EncryptedFrame,
  frame,
  parseClientToDaemon,
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
      frame({ type: "sessions.list", sessions: [{ id: "s1", shell: "bash", title: "bash", createdAt: 1, alive: true }] }),
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
