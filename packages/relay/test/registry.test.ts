import { describe, expect, it } from "vitest";
import {
  Registry,
  generatePairingCode,
  sha256Hex,
} from "../src/registry";

function makeRegistry(): Registry {
  return new Registry(":memory:");
}

describe("pairing codes", () => {
  it("uses an unambiguous alphabet and fixed length", () => {
    for (let i = 0; i < 50; i++) {
      const code = generatePairingCode();
      expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
    }
  });

  it("sha256Hex is deterministic", () => {
    expect(sha256Hex("abc")).toBe(sha256Hex("abc"));
    expect(sha256Hex("abc")).not.toBe(sha256Hex("abd"));
  });
});

describe("Registry", () => {
  it("stores and retrieves devices", () => {
    const registry = makeRegistry();
    const device = registry.upsertDevice("dev-1", "laptop", "PUBKEY");
    expect(device).toMatchObject({ deviceId: "dev-1", name: "laptop", daemonPubKey: "PUBKEY" });
    const renamed = registry.upsertDevice("dev-1", "laptop-2", "PUBKEY");
    expect(renamed.name).toBe("laptop-2");
    expect(registry.getDevice("dev-1")?.name).toBe("laptop-2");
    expect(registry.getDevice("nope")).toBeNull();
    registry.close();
  });

  it("tokens authenticate by role and can be revoked", () => {
    const registry = makeRegistry();
    registry.storeToken("d-token", "daemon", "dev-1", null);
    registry.storeToken("c-token", "client", "dev-1", "client-1");

    expect(registry.lookupToken("d-token", "daemon")).toEqual({ role: "daemon", deviceId: "dev-1", clientId: null });
    expect(registry.lookupToken("c-token", "client")).toEqual({ role: "client", deviceId: "dev-1", clientId: "client-1" });
    expect(registry.lookupToken("bad", "client")).toBeNull();
    expect(registry.lookupToken("c-token", "daemon")).toBeNull();

    registry.revokeDeviceTokens("dev-1");
    expect(registry.lookupToken("d-token", "daemon")).toBeNull();
    expect(registry.lookupToken("c-token", "client")).toBeNull();
    registry.close();
  });

  it("full pairing flow: start, poll pending, claim, poll claimed, idempotent re-claim", () => {
    const registry = makeRegistry();
    registry.upsertDevice("dev-1", "laptop", "DAEMONPUB");
    const { pairingCode } = registry.createPairing("dev-1");

    expect(registry.pollPairing("dev-1", pairingCode).status).toBe("pending");
    expect(registry.pollPairing("dev-1", "WRONGCOD").status).toBe("expired");

    const claim = registry.claimPairing(pairingCode, "CLIENTPUB", "pixel");
    expect(typeof claim).toBe("object");
    if (typeof claim !== "object") throw new Error("expected claim result");
    expect(claim.deviceId).toBe("dev-1");
    expect(claim.daemonPubKey).toBe("DAEMONPUB");
    expect(claim.clientToken.startsWith("rcm_")).toBe(true);

    const poll = registry.pollPairing("dev-1", pairingCode);
    expect(poll.status).toBe("claimed");
    expect(poll.clientPubKey).toBe("CLIENTPUB");
    expect(poll.daemonToken?.startsWith("rcm_")).toBe(true);

    const reClaim = registry.claimPairing(pairingCode, "CLIENTPUB", "pixel");
    if (typeof reClaim !== "object" || "status" in reClaim) throw new Error("expected claim result");
    expect(reClaim.clientToken).toBe(claim.clientToken);

    expect(registry.lookupToken(claim.clientToken, "client")?.role).toBe("client");
    expect(registry.lookupToken(poll.daemonToken!, "daemon")?.role).toBe("daemon");
    registry.close();
  });

  it("rejects a different client claiming an already-claimed code", () => {
    const registry = makeRegistry();
    registry.upsertDevice("dev-1", "laptop", "DAEMONPUB");
    const { pairingCode } = registry.createPairing("dev-1");
    registry.claimPairing(pairingCode, "PUB-A", "phone-a");
    expect(registry.claimPairing(pairingCode, "PUB-B", "phone-b")).toBe("conflict");
    registry.close();
  });

  it("rate-limits repeated claims", () => {
    const registry = makeRegistry();
    registry.upsertDevice("dev-1", "laptop", "DAEMONPUB");
    const { pairingCode } = registry.createPairing("dev-1");
    let result: unknown = null;
    for (let i = 0; i < 11; i++) {
      result = registry.claimPairing(pairingCode, `PUB-${i}`, "phone");
    }
    expect(result).toBe("too_many_attempts");
    registry.close();
  });

  it("cleanupExpired removes old pairings", () => {
    const registry = makeRegistry();
    registry.upsertDevice("dev-1", "laptop", "PUB");
    registry.createPairing("dev-1");
    registry.cleanupExpired();
    expect(registry.db.prepare("SELECT COUNT(*) AS n FROM pairings").get()).toEqual({ n: 1 });
    registry.close();
  });
});
