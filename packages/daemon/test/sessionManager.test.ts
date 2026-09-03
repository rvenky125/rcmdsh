import { describe, expect, it } from "vitest";
import { SessionManager, UnknownSessionError } from "../src/pty/SessionManager";
import { getShellDef, shellsForPlatform } from "../src/pty/shells";

interface Harness {
  manager: SessionManager;
  outputs: Array<{ id: string; data: string }>;
  exits: Array<{ id: string; exitCode: number | null }>;
  combined(id: string): string;
}

function makeHarness(): Harness {
  const outputs: Array<{ id: string; data: string }> = [];
  const exits: Array<{ id: string; exitCode: number | null }> = [];
  const manager = new SessionManager({
    onOutput: (id, data) => outputs.push({ id, data }),
    onExit: (id, exitCode) => exits.push({ id, exitCode }),
  });
  return {
    manager,
    outputs,
    exits,
    combined: (id) => outputs.filter((o) => o.id === id).map((o) => o.data).join(""),
  };
}

function waitFor(predicate: () => boolean, timeoutMs = 20000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        reject(new Error("timed out waiting for condition"));
      } else {
        setTimeout(tick, 50);
      }
    };
    tick();
  });
}

const primaryShell = shellsForPlatform()[0]!;

describe("SessionManager", () => {
  it("has a usable shell for this platform", () => {
    expect(primaryShell).toBeTruthy();
    expect(getShellDef(primaryShell.id)).not.toBeNull();
  });

  it("spawns a shell and captures echoed output", async () => {
    const harness = makeHarness();
    const session = harness.manager.create(primaryShell, { cols: 80, rows: 24 });
    expect(session.alive).toBe(true);

    harness.manager.write(session.id, "echo rcmdsh_marker_42\r\n");
    await waitFor(() => harness.combined(session.id).includes("rcmdsh_marker_42"));

    harness.manager.kill(session.id);
  });

  it("reports the exit event when the shell exits", async () => {
    const harness = makeHarness();
    const session = harness.manager.create(primaryShell, { cols: 80, rows: 24 });
    harness.manager.write(session.id, "exit\r\n");
    await waitFor(() => harness.exits.some((e) => e.id === session.id));
    expect(harness.manager.get(session.id).alive).toBe(false);
  });

  it("replays scrollback for reconnecting clients", async () => {
    const harness = makeHarness();
    const session = harness.manager.create(primaryShell, { cols: 80, rows: 24 });
    harness.manager.write(session.id, "echo replay_marker_99\r\n");
    await waitFor(() => harness.combined(session.id).includes("replay_marker_99"));
    expect(harness.manager.replay(session.id)).toContain("replay_marker_99");
    harness.manager.kill(session.id);
  });

  it("resizes without throwing and tracks the current size", async () => {
    const harness = makeHarness();
    const session = harness.manager.create(primaryShell, { cols: 80, rows: 24 });
    expect(session.cols).toBe(80);
    expect(session.rows).toBe(24);
    harness.manager.resize(session.id, 120, 40);
    expect(session.cols).toBe(120);
    expect(session.rows).toBe(40);
    harness.manager.resize(session.id, 50, 10);
    expect(session.cols).toBe(50);
    expect(session.rows).toBe(10);
    harness.manager.kill(session.id);
    await waitFor(() => !harness.manager.get(session.id).alive);
  });

  it("throws for unknown session ids", () => {
    const harness = makeHarness();
    expect(() => harness.manager.write("missing", "x")).toThrow(UnknownSessionError);
    expect(() => harness.manager.replay("missing")).toThrow(UnknownSessionError);
    expect(() => harness.manager.kill("missing")).toThrow(UnknownSessionError);
  });

  it("lists sessions with metadata", () => {
    const harness = makeHarness();
    const session = harness.manager.create(primaryShell, { cols: 80, rows: 24 });
    const list = harness.manager.list();
    const entry = list.find((s) => s.id === session.id);
    expect(entry).toMatchObject({ shell: primaryShell.id, alive: true });
    harness.manager.kill(session.id);
  });

  it("killAll terminates every session", async () => {
    const harness = makeHarness();
    const a = harness.manager.create(primaryShell, { cols: 80, rows: 24 });
    const b = harness.manager.create(primaryShell, { cols: 80, rows: 24 });
    harness.manager.killAll();
    await waitFor(() => !harness.manager.get(a.id).alive && !harness.manager.get(b.id).alive);
  });
});
