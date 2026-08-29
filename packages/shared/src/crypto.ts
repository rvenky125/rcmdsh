import nacl from "tweetnacl";
import { utf8Bytes } from "./base64";

export interface KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export const E2E_SALT = "rcmdsh-e2e-v1";
export const E2E_INFO = "session-key";

export function generateKeyPair(): KeyPair {
  return nacl.box.keyPair();
}

export function generateEphemeralKeyPair(): KeyPair {
  return nacl.box.keyPair();
}

export function deriveSharedSecret(mySecret: Uint8Array, theirPublic: Uint8Array): Uint8Array {
  if (mySecret.length !== nacl.box.secretKeyLength) {
    throw new Error("invalid secret key length");
  }
  if (theirPublic.length !== nacl.box.publicKeyLength) {
    throw new Error("invalid public key length");
  }
  return nacl.box.before(theirPublic, mySecret);
}

export function deriveSessionKey(sharedSecret: Uint8Array, info: string = E2E_INFO): Uint8Array {
  return hkdfSha512(sharedSecret, utf8Bytes(E2E_SALT), utf8Bytes(info), 32);
}

export function hmacSha512(key: Uint8Array, data: Uint8Array): Uint8Array {
  const BLOCK = 128;
  const SHA512_LENGTH = 64;
  const normalized = key.length > BLOCK ? nacl.hash(key) : key;
  const padded = new Uint8Array(BLOCK);
  padded.set(normalized);

  const ipad = new Uint8Array(BLOCK + data.length);
  const opad = new Uint8Array(BLOCK + SHA512_LENGTH);
  for (let i = 0; i < BLOCK; i++) {
    ipad[i] = padded[i]! ^ 0x36;
    opad[i] = padded[i]! ^ 0x5c;
  }
  ipad.set(data, BLOCK);
  opad.set(nacl.hash(ipad), BLOCK);
  return nacl.hash(opad);
}

export function hkdfSha512(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Uint8Array {
  const prk = hmacSha512(salt, ikm);
  const blocks: Uint8Array[] = [];
  let t: Uint8Array = new Uint8Array(0);
  let counter = 1;
  let total = 0;
  while (total < length) {
    const input = new Uint8Array(t.length + info.length + 1);
    input.set(t, 0);
    input.set(info, t.length);
    input[input.length - 1] = counter;
    t = hmacSha512(prk, input);
    blocks.push(t);
    total += t.length;
    counter++;
  }
  const okm = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    okm.set(block, offset);
    offset += block.length;
  }
  return okm.subarray(0, length);
}

export function seal(key: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const boxed = nacl.secretbox(plaintext, nonce, key);
  const out = new Uint8Array(nonce.length + boxed.length);
  out.set(nonce, 0);
  out.set(boxed, nonce.length);
  return out;
}

export function openSealed(key: Uint8Array, sealed: Uint8Array): Uint8Array | null {
  if (sealed.length < nacl.box.nonceLength + nacl.secretbox.overheadLength) {
    return null;
  }
  const nonce = sealed.subarray(0, nacl.box.nonceLength);
  const boxed = sealed.subarray(nacl.box.nonceLength);
  return nacl.secretbox.open(boxed, nonce, key);
}

export function generateToken(): string {
  const bytes = nacl.randomBytes(24);
  return "rcm_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
