import { describe, expect, it } from "vitest";
import {
  deriveSessionKey,
  deriveSharedSecret,
  generateKeyPair,
  generateToken,
  hkdfSha512,
  hmacSha512,
  openSealed,
  seal,
} from "../src/crypto";
import { utf8Bytes, bytesToB64, b64ToBytes } from "../src/base64";

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("hmacSha512", () => {
  it("matches RFC 4231 test case 2", () => {
    const mac = hmacSha512(utf8Bytes("Jefe"), utf8Bytes("what do ya want for nothing?"));
    expect(hex(mac)).toBe(
      "164b7a7bfcf819e2e395fbe73b56e0a387bd64222e831fd610270cd7ea2505549758bf75c05a994a6d034f65f8f0e6fdcaeab1a34d4a6b4b636e070a38bce737",
    );
  });

  it("matches the HMAC-SHA512 Wikipedia example", () => {
    const mac = hmacSha512(utf8Bytes("key"), utf8Bytes("The quick brown fox jumps over the lazy dog"));
    expect(hex(mac)).toBe(
      "b42af09057bac1e2d41708e48a902e09b5ff7f12ab428a4fe86653c73dd248fb82f948a549f7b791a5b41915ee4d1ec3935357e4e2317250d0372afa2ebeeb3a",
    );
  });

  it("hashes keys longer than the block size", () => {
    const longKey = new Uint8Array(200).fill(0xab);
    const mac = hmacSha512(longKey, utf8Bytes("data"));
    expect(mac.length).toBe(64);
  });
});

describe("hkdfSha512", () => {
  it("produces stable output for the same inputs", () => {
    const a = hkdfSha512(utf8Bytes("ikm"), utf8Bytes("salt"), utf8Bytes("info"), 32);
    const b = hkdfSha512(utf8Bytes("ikm"), utf8Bytes("salt"), utf8Bytes("info"), 32);
    expect(hex(a)).toBe(hex(b));
  });

  it("produces different output for different info", () => {
    const a = hkdfSha512(utf8Bytes("ikm"), utf8Bytes("salt"), utf8Bytes("info-a"), 32);
    const b = hkdfSha512(utf8Bytes("ikm"), utf8Bytes("salt"), utf8Bytes("info-b"), 32);
    expect(hex(a)).not.toBe(hex(b));
  });

  it("supports lengths spanning multiple hash blocks", () => {
    const okm = hkdfSha512(utf8Bytes("ikm"), utf8Bytes("salt"), utf8Bytes("info"), 200);
    expect(okm.length).toBe(200);
  });
});

describe("end-to-end key agreement", () => {
  it("both parties derive the same session key", () => {
    const daemon = generateKeyPair();
    const client = generateKeyPair();

    const daemonSide = deriveSharedSecret(daemon.secretKey, client.publicKey);
    const clientSide = deriveSharedSecret(client.secretKey, daemon.publicKey);
    expect(hex(daemonSide)).toBe(hex(clientSide));

    const daemonKey = deriveSessionKey(daemonSide);
    const clientKey = deriveSessionKey(clientSide);
    expect(hex(daemonKey)).toBe(hex(clientKey));
  });

  it("seal/open round-trips and rejects tampering", () => {
    const daemon = generateKeyPair();
    const client = generateKeyPair();
    const key = deriveSessionKey(deriveSharedSecret(daemon.secretKey, client.publicKey));

    const message = utf8Bytes(JSON.stringify({ type: "session.input", data: "dir\r\n" }));
    const sealed = seal(key, message);

    expect(openSealed(key, sealed)).toEqual(message);

    const tampered = sealed.slice();
    tampered[tampered.length - 1]! ^= 0x01;
    expect(openSealed(key, tampered)).toBeNull();

    const wrongKey = deriveSessionKey(deriveSharedSecret(client.secretKey, client.publicKey));
    expect(openSealed(wrongKey, sealed)).toBeNull();
  });

  it("every seal uses a fresh nonce", () => {
    const daemon = generateKeyPair();
    const client = generateKeyPair();
    const key = deriveSessionKey(deriveSharedSecret(daemon.secretKey, client.publicKey));
    const a = seal(key, utf8Bytes("same"));
    const b = seal(key, utf8Bytes("same"));
    expect(bytesToB64(a)).not.toBe(bytesToB64(b));
  });

  it("rejects malformed keys", () => {
    const pair = generateKeyPair();
    expect(() => deriveSharedSecret(pair.secretKey, new Uint8Array(3))).toThrow();
    expect(() => deriveSharedSecret(new Uint8Array(3), pair.publicKey)).toThrow();
  });
});

describe("generateToken", () => {
  it("creates prefixed hex tokens", () => {
    const token = generateToken();
    expect(token.startsWith("rcm_")).toBe(true);
    expect(token.length).toBe("rcm_".length + 48);
    expect(b64ToBytes(bytesToB64(new Uint8Array(4))).length).toBe(4);
  });
});
