import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { frame } from "@rcmdsh/shared";
import { startRelay, type RelayHandle } from "../src/server";
import { Registry } from "../src/registry";

const DAEMON_TOKEN = "rcm_daemon_test_token";
const CLIENT_TOKEN = "rcm_client_test_token";
const DEVICE_ID = "device-int-1";

let handle: RelayHandle;
let registry: Registry;
let baseUrl: string;

interface TestSocket {
  ws: WebSocket;
  messages: unknown[];
  waitFor(predicate: (m: Record<string, unknown>) => boolean, timeoutMs?: number): Promise<Record<string, unknown>>;
}

function connect(path: "/ws/daemon" | "/ws/client", token: string, role: "daemon" | "client"): Promise<TestSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}${path}`);
    const messages: unknown[] = [];
    ws.on("message", (raw) => {
      try {
        messages.push(JSON.parse(String(raw)) as unknown);
      } catch {
        messages.push({ type: "__unparseable__" });
      }
    });
    ws.on("error", () => {});
    ws.on("open", () => {
      ws.send(JSON.stringify(frame({ type: "relay.hello", role, token })));
      const socket: TestSocket = {
        ws,
        messages,
        waitFor(predicate, timeoutMs = 5000) {
          return new Promise((res, rej) => {
            const start = Date.now();
            const tick = () => {
              const found = messages.find((m) => predicate(m as Record<string, unknown>));
              if (found) {
                res(found as Record<string, unknown>);
              } else if (Date.now() - start > timeoutMs) {
                rej(new Error(`timed out on ${path}, saw: ${JSON.stringify(messages.map((m) => (m as { type?: string }).type))}`));
              } else {
                setTimeout(tick, 25);
              }
            };
            tick();
          });
        },
      };
      socket
        .waitFor((m) => m.type === "relay.welcome")
        .then(() => resolve(socket))
        .catch(reject);
    });
  });
}

beforeAll(async () => {
  handle = await startRelay({ port: 0, dbPath: ":memory:", log: () => {} });
  registry = handle.registry;
  registry.upsertDevice(DEVICE_ID, "test-laptop", "DAEMONPUB");
  registry.storeToken(DAEMON_TOKEN, "daemon", DEVICE_ID, null);
  registry.storeToken(CLIENT_TOKEN, "client", DEVICE_ID, "client-int-1");
});

afterAll(async () => {
  await handle.close();
});

describe("RelayRouter", () => {
  it("authenticates daemon and client and forwards frames both ways", async () => {
    const daemon = await connect("/ws/daemon", DAEMON_TOKEN, "daemon");
    const client = await connect("/ws/client", CLIENT_TOKEN, "client");

    const appFrame = JSON.stringify(frame({ type: "sessions.list" }));
    client.ws.send(appFrame);

    const routed = await daemon.waitFor((m) => m.type === "relay.route");
    expect(routed.from).toBe("client-int-1");
    expect(routed.frame).toBe(appFrame);

    const reply = JSON.stringify(frame({ type: "sessions.list", sessions: [] }));
    daemon.ws.send(JSON.stringify(frame({ type: "relay.route", to: "client-int-1", frame: reply })));

    const received = await client.waitFor((m) => m.type === "sessions.list");
    expect(received).toMatchObject({ type: "sessions.list" });

    client.ws.close();
    daemon.ws.close();
  });

  it("rejects bad tokens", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/client`);
    const messages: unknown[] = [];
    ws.on("message", (raw) => messages.push(JSON.parse(String(raw)) as unknown));
    ws.on("error", () => {});
    await new Promise<void>((resolve) => ws.on("open", resolve));
    ws.send(JSON.stringify(frame({ type: "relay.hello", role: "client", token: "wrong-token" })));
    await new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        if (messages.some((m) => (m as Record<string, unknown>).type === "relay.reject")) resolve(null);
        else if (Date.now() - start > 5000) reject(new Error("no reject received"));
        else setTimeout(tick, 25);
      };
      tick();
    });
    expect((ws as unknown as { readyState: number }).readyState).toBeGreaterThan(1);
    ws.terminate();
  });

  it("tells the client when the daemon is offline", async () => {
    const client = await connect("/ws/client", CLIENT_TOKEN, "client");
    client.ws.send(JSON.stringify(frame({ type: "sessions.list" })));
    const err = await client.waitFor((m) => m.type === "relay.error");
    expect(err.code).toBe("daemon_offline");
    client.ws.close();
  });

  it("notifies online clients when the daemon goes offline", async () => {
    const daemon = await connect("/ws/daemon", DAEMON_TOKEN, "daemon");
    const client = await connect("/ws/client", CLIENT_TOKEN, "client");

    await client.waitFor((m) => m.type === "relay.status" && m.daemonOnline === true);

    daemon.ws.close();
    await client.waitFor((m) => m.type === "relay.status" && m.daemonOnline === false);
    client.ws.close();
  });

  it("returns the client status before the daemon connects", async () => {
    const client = await connect("/ws/client", CLIENT_TOKEN, "client");
    const status = await client.waitFor((m) => m.type === "relay.status");
    expect(typeof status.daemonOnline).toBe("boolean");
    client.ws.close();
  });
});
