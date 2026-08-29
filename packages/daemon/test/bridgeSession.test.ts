import { describe, expect, it, vi } from "vitest";
import { BridgeSession, type BridgeSocketLike } from "../src/pty/BridgeSession";
import type { SessionEvents } from "../src/pty/SessionManager";

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        reject(new Error("timed out waiting for condition"));
      } else {
        setTimeout(tick, 5);
      }
    };
    tick();
  });
}

function makeHarness() {
  const sent: Array<Record<string, unknown>> = [];
  const outputs: Array<{ id: string; data: string }> = [];
  const exits: Array<{ id: string; exitCode: number | null }> = [];
  const socket: BridgeSocketLike = {
    send: (data: string) => sent.push(JSON.parse(data) as Record<string, unknown>),
    close: () => {},
  };
  const events: SessionEvents = {
    onOutput: (id, data) => outputs.push({ id, data }),
    onExit: (id, exitCode) => exits.push({ id, exitCode }),
  };
  const session = new BridgeSession("bs1", "cmd", socket, events, 4242, 80, 24);
  return { session, sent, outputs, exits };
}

describe("BridgeSession", () => {
  it("reports bridge origin and pid", () => {
    const { session } = makeHarness();
    expect(session.summary()).toMatchObject({
      id: "bs1",
      shell: "cmd",
      origin: "bridge",
      pid: 4242,
      alive: true,
    });
  });

  it("sends input frames for writes", () => {
    const { session, sent } = makeHarness();
    session.write("dir\r\n");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "bridge.input", id: "bs1" });
    expect(typeof sent[0]["data"]).toBe("string");
    expect(sent[0]["data"].length).toBeGreaterThan(0);
  });

  it("sends resize frames and tracks size", () => {
    const { session, sent } = makeHarness();
    session.resize(120, 40);
    expect(session.cols).toBe(120);
    expect(session.rows).toBe(40);
    expect(sent[0]).toMatchObject({ type: "bridge.resize", id: "bs1", cols: 120, rows: 40 });
  });

  it("feeds output to listeners and scrollback replay", async () => {
    const { session, outputs } = makeHarness();
    session.handleOutput("hello ");
    session.handleOutput("world");
    await waitFor(() => outputs.length > 0);
    expect(outputs.map((o) => o.data).join("")).toBe("hello world");
    expect(session.replay()).toBe("hello world");
  });

  it("marks the session dead with a null exit code on disconnect", () => {
    const { session, exits } = makeHarness();
    session.handleOutput("partial");
    session.handleDisconnect();
    expect(session.alive).toBe(false);
    expect(session.exitCode).toBeNull();
    expect(exits).toEqual([{ id: "bs1", exitCode: null }]);
    expect(session.replay()).toBe("partial");
  });

  it("marks the session dead with the reported exit code on exit", () => {
    const { session, exits } = makeHarness();
    session.handleExit(0);
    expect(session.alive).toBe(false);
    expect(session.exitCode).toBe(0);
    expect(exits).toEqual([{ id: "bs1", exitCode: 0 }]);
  });

  it("stops writing after death", () => {
    const { session, sent } = makeHarness();
    session.handleExit(0);
    session.write("x");
    expect(sent).toHaveLength(0);
  });

  it("sends kill exactly once even with the fallback timer", () => {
    vi.useFakeTimers();
    try {
      const { session, sent } = makeHarness();
      session.kill();
      session.kill();
      vi.advanceTimersByTime(4000);
      expect(sent.filter((m) => m["type"] === "bridge.kill")).toHaveLength(1);
      expect(session.alive).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores output arriving after exit", () => {
    const { session, outputs } = makeHarness();
    session.handleExit(1);
    session.handleOutput("late");
    expect(outputs).toHaveLength(0);
  });
});
