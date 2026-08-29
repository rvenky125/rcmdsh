export function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function utf8ToB64(text: string): string {
  return bytesToB64(new TextEncoder().encode(text));
}

export function b64ToUtf8(b64: string): string {
  return new TextDecoder().decode(b64ToBytes(b64));
}

export function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
