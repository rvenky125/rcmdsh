import {
  b64ToBytes,
  bytesToB64,
  deriveSessionKey,
  deriveSharedSecret,
  openSealed,
  randomId,
  seal,
  utf8Bytes,
} from "rcmdsh-core";

export function daemonKeyForClient(daemonSecret: Uint8Array, clientPubKeyB64: string): Uint8Array {
  const shared = deriveSharedSecret(daemonSecret, b64ToBytes(clientPubKeyB64));
  return deriveSessionKey(shared);
}

export function sealToClient(key: Uint8Array, message: unknown): string {
  const plaintext = utf8Bytes(JSON.stringify(message));
  const sealed = seal(key, plaintext);
  return JSON.stringify({
    v: 1,
    enc: true,
    msgId: randomId(),
    ts: Date.now(),
    data: bytesToB64(sealed),
  });
}

export function openFromClient(key: Uint8Array, frameText: string): unknown | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(frameText);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.enc !== true || typeof obj.data !== "string") return null;
  const opened = openSealed(key, b64ToBytes(obj.data));
  if (opened === null) return null;
  try {
    return JSON.parse(new TextDecoder().decode(opened)) as unknown;
  } catch {
    return null;
  }
}

export function clientHelloFrame(clientPubKeyB64: string): string {
  return JSON.stringify({ type: "e2e.hello", clientPubKey: clientPubKeyB64 });
}
