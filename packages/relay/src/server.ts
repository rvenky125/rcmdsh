import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import path from "node:path";
import type { Duplex } from "node:stream";
import { RateLimiter } from "./pairing";
import { Registry } from "./registry";
import { RelayRouter } from "./router";

export interface RelayServerOptions {
  port: number;
  host?: string;
  dbPath: string;
  webDist?: string | null;
  devToken?: string;
  log?: (message: string) => void;
}

export interface RelayHandle {
  port: number;
  registry: Registry;
  close(): Promise<void>;
}

export async function startRelay(options: RelayServerOptions): Promise<RelayHandle> {
  const log = options.log ?? (() => {});
  const registry = new Registry(options.dbPath);

  if (options.devToken) {
    registry.upsertDevice("dev", "dev computer", "");
    registry.storeDaemonToken(options.devToken);
    registry.storeToken(options.devToken, "client", "dev", "dev-client");
    log(`dev token registered (INSECURE development mode)`);
  }

  const app = Fastify({ logger: false });
  const pairStartLimiter = new RateLimiter(20, 60 * 60 * 1000);
  const claimLimiter = new RateLimiter(60, 60 * 60 * 1000);

  if (options.webDist && fs.existsSync(options.webDist)) {
    await app.register(fastifyStatic, { root: path.resolve(options.webDist) });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/v1") || request.url.startsWith("/ws")) {
        reply.code(404).send({ error: "not found" });
        return;
      }
      reply.sendFile("index.html");
    });
  }

  app.get("/health", async () => ({ ok: true, service: "rcmdsh-relay", time: Date.now() }));

  app.get("/v1/debug/tokens", async () => {
    const tokens = registry.debugTokens();
    return { tokens };
  });

  app.post("/v1/pair/start", async (request, reply) => {
    const ip = request.ip;
    if (!pairStartLimiter.check(ip)) {
      reply.code(429).send({ error: "too many pairing attempts, try again later" });
      return;
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const deviceId = typeof body.deviceId === "string" ? body.deviceId : "";
    const name = typeof body.name === "string" && body.name.length > 0 ? body.name : "computer";
    const daemonPubKey = typeof body.daemonPubKey === "string" ? body.daemonPubKey : "";
    if (!deviceId || !daemonPubKey) {
      reply.code(400).send({ error: "deviceId and daemonPubKey are required" });
      return;
    }
    registry.upsertDevice(deviceId, name, daemonPubKey);
    const { pairingCode, expiresAt } = registry.createPairing(deviceId);
    return { pairingCode, expiresAt };
  });

  app.post("/v1/pair/claim", async (request, reply) => {
    if (!claimLimiter.check(request.ip)) {
      reply.code(429).send({ error: "too many pairing attempts, try again later" });
      return;
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const code = typeof body.code === "string" ? body.code.toUpperCase() : "";
    const clientPubKey = typeof body.clientPubKey === "string" ? body.clientPubKey : "";
    const clientName = typeof body.clientName === "string" && body.clientName.length > 0 ? body.clientName : "mobile device";
    if (!code || !clientPubKey) {
      reply.code(400).send({ error: "code and clientPubKey are required" });
      return;
    }
    const result = registry.claimPairing(code, clientPubKey, clientName);
    if (result === "expired") {
      reply.code(410).send({ error: "pairing code expired or unknown" });
      return;
    }
    if (result === "too_many_attempts") {
      reply.code(429).send({ error: "too many claim attempts for this code" });
      return;
    }
    if (result === "conflict") {
      reply.code(409).send({ error: "code already claimed by another device" });
      return;
    }
    return result;
  });

  app.get("/v1/pair/status", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const deviceId = typeof query.deviceId === "string" ? query.deviceId : "";
    const code = typeof query.code === "string" ? query.code.toUpperCase() : "";
    if (!deviceId || !code) {
      reply.code(400).send({ error: "deviceId and code are required" });
      return;
    }
    return registry.pollPairing(deviceId, code);
  });

  await app.listen({ port: options.port, host: options.host ?? "0.0.0.0" });
  const address = app.server.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port;

  const router = new RelayRouter(registry, log);
  app.server.on("upgrade", (request, socket, head) => {
    router.handleUpgrade(request, socket as Duplex, head);
  });

  log(`relay listening on ${options.host ?? "0.0.0.0"}:${options.port}`);

  return {
    port,
    registry,
    close: async () => {
      router.close();
      await app.close();
      registry.close();
    },
  };
}
