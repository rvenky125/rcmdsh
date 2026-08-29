import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { bytesToB64, frame, utf8Bytes } from "rcmdsh-core";
import { AttachGateway } from "../src/attach/Gateway";
import { SessionManager, type SessionEvents } from "../src/pty/SessionManager";

function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        reject(new Error("timed out waiting for condition"));
      } else {
        setTimeout(tick, 20);
      }
    };
    tick();
  });
}

function openSocket(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    ws.once("message", (raw) => resolve(JSON.parse(String(raw)) as Record<string, unknown>));
    ws.once("close", () => reject(new Error("socket closed")));
  });
}

function b64(text: string): string {
  return bytesToB64(utf8Bytes(text));
}

describe("AttachGateway", () => {
  const created: AttachGateway[] = [];

  function makeGateway(token = "tok") {
    const outputs: Array<{ id: string; data: string }> = [];
    const exits: Array<{ id: string; exitCode: number | null }> = [];
    let changeCount = 0;
    const events: SessionEvents = {
      onOutput: (id, data) => outputs.push({ id, data }),
      onExit: (id, exitCode) => exits.push({ id, exitCode }),
    };
    const sessions = new SessionManager(events);
    const gateway = new AttachGateway({
      port: 0, // ephemeral; gateway.port reports the bound one
      token,
      sessions,
      events,
      log: () => {},
      onSessionsChanged: () => {
        changeCount++;
      },
    });
    created.push(gateway);
    return { gateway, sessions, outputs, exits, changes: () => changeCount };
  }

  afterEach(async () => {
    for (const gateway of created.splice(0)) {
      gateway.stop();
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it("authenticates hello and registers a bridge session", async () => {
    const harness = makeGateway();
    await harness.gateway.start();
    const port = harness.gateway.port;
    expect(port).toBeGreaterThan(0);

    const ws = await openSocket(port!);
    ws.send(JSON.stringify(frame({ type: "bridge.hello", token: "tok", shell: "cmd", cols: 80, rows: 24, pid: 4321 })));
    const welcome = await nextMessage(ws);
    expect(welcome).toMatchObject({ type: "bridge.welcome", shell: "cmd" });
    const id = welcome["id"] as string;

    expect(harness.sessions.list()).toHaveLength(1);
    expect(harness.sessions.list()[0]).toMatchObject({ id, origin: "bridge", pid: 4321, alive: true });
    expect(harness.changes()).toBeGreaterThan(0);
    ws.close();
  });

  it("rejects bad tokens", async () => {
    const harness = makeGateway("secret");
    await harness.gateway.start();
    const ws = await openSocket(harness.gateway.port!);
    ws.send(JSON.stringify(frame({ type: "bridge.hello", token: "wrong", shell: "cmd", cols: 80, rows: 24 })));
    const reply = await nextMessage(ws);
    expect(reply).toMatchObject({ type: "bridge.error", code: "bad_token" });
    expect(harness.sessions.list()).toHaveLength(0);
    ws.close();
  });

  it("routes output and exit between bridge and daemon events", async () => {
    const harness = makeGateway();
    await harness.gateway.start();
    const ws = await openSocket(harness.gateway.port!);
    ws.send(JSON.stringify(frame({ type: "bridge.hello", token: "tok", shell: "cmd", cols: 80, rows: 24, pid: 7 })));
    const welcome = await nextMessage(ws);
    const id = welcome["id"] as string;

    ws.send(JSON.stringify(frame({ type: "bridge.output", id, data: b64("hello world") })));
    await waitFor(() => harness.outputs.some((o) => o.id === id));
    expect(harness.outputs.map((o) => o.data).join("")).toBe("hello world");
    expect(harness.sessions.replay(id)).toBe("hello world");

    ws.send(JSON.stringify(frame({ type: "bridge.resize", id, cols: 100, rows: 30 })));

    ws.send(JSON.stringify(frame({ type: "bridge.exit", id, exitCode: 3 })));
    await waitFor(() => harness.exits.length > 0);
    expect(harness.exits[0]).toEqual({ id, exitCode: 3 });
    expect(harness.sessions.list()[0].alive).toBe(false);
    ws.close();
  });

  it("marks the session dead when the bridge disconnects", async () => {
    const harness = makeGateway();
    await harness.gateway.start();
    const ws = await openSocket(harness.gateway.port!);
    ws.send(JSON.stringify(frame({ type: "bridge.hello", token: "tok", shell: "cmd", cols: 80, rows: 24, pid: 9 })));
    const welcome = await nextMessage(ws);
    const id = welcome["id"] as string;

    ws.close();
    await waitFor(() => harness.exits.length > 0);
    expect(harness.exits[0]).toEqual({ id, exitCode: null });
    expect(harness.sessions.list()[0].alive).toBe(false);
  });

  it("resolves expectBridge for pending visible-window creates", async () => {
    const harness = makeGateway();
    await harness.gateway.start();
    const bridgeId = "pending-abc";
    const expected = harness.gateway.expectBridge(bridgeId, 5000);

    const ws = await openSocket(harness.gateway.port!);
    ws.send(
      JSON.stringify(
        frame({ type: "bridge.hello", token: "tok", shell: "powershell", cols: 90, rows: 28, pid: 12, bridgeId }),
      ),
    );
    const session = await expected;
    expect(session.shellId).toBe("powershell");
    expect(session.pid).toBe(12);
    expect(harness.sessions.list()).toHaveLength(1);
    ws.close();
  });

  it("rejects expectBridge when the window never connects", async () => {
    const harness = makeGateway();
    await harness.gateway.start();
    await expect(harness.gateway.expectBridge("never-comes", 120)).rejects.toThrow(
      "attach window did not connect in time",
    );
  });
});
