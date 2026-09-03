import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { explainUnreachableGateway, type AttachClientOptions } from "../src/attach/AttachClient";

const servers: net.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

function listenOnFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    servers.push(server);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" ? address.port : 0);
    });
  });
}

// Binds and immediately releases a port so the test has one that is closed.
function grabClosedPort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function makeOptions(gatewayUrl: string, logs: string[]): AttachClientOptions {
  return { gatewayUrl, token: "tok", shellId: null, log: (message) => logs.push(message) };
}

describe("explainUnreachableGateway", () => {
  it("says the daemon is not running when nothing listens", async () => {
    const gatewayPort = await grabClosedPort();
    const relayPort = await grabClosedPort();
    const logs: string[] = [];
    await explainUnreachableGateway(makeOptions(`ws://127.0.0.1:${gatewayPort}/bridge`, logs), relayPort);
    expect(logs[0]).toBe("the rcmdsh daemon is not running on this computer");
    expect(logs[1]).toContain("start it in another window");
  });

  it("says the port is busy when something else listens on the gateway port", async () => {
    const gatewayPort = await listenOnFreePort();
    const relayPort = await grabClosedPort();
    const logs: string[] = [];
    await explainUnreachableGateway(makeOptions(`ws://127.0.0.1:${gatewayPort}/bridge`, logs), relayPort);
    expect(logs[0]).toContain("something else is listening");
    expect(logs[0]).toContain(String(gatewayPort));
  });

  it("points at pending pairing when the relay is up but the gateway is not", async () => {
    const gatewayPort = await grabClosedPort();
    const relayPort = await listenOnFreePort();
    const logs: string[] = [];
    await explainUnreachableGateway(makeOptions(`ws://127.0.0.1:${gatewayPort}/bridge`, logs), relayPort);
    expect(logs[0]).toContain("waiting for a device to pair");
    expect(logs[1]).toContain(String(relayPort));
  });
});
