import { describe, expect, it } from "vitest";
import { b64ToUtf8, b64ToBytes, bytesToB64, utf8ToB64, utf8Bytes } from "../src/base64";

describe("base64", () => {
  it("round-trips ascii", () => {
    expect(b64ToUtf8(utf8ToB64("hello world"))).toBe("hello world");
  });

  it("round-trips unicode", () => {
    const text = "héllo — 中文 🚀";
    expect(b64ToUtf8(utf8ToB64(text))).toBe(text);
  });

  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    expect(b64ToBytes(bytesToB64(bytes))).toEqual(bytes);
  });

  it("handles large buffers", () => {
    const bytes = new Uint8Array(200_000).fill(7);
    expect(b64ToBytes(bytesToB64(bytes)).length).toBe(200_000);
  });

  it("utf8Bytes matches TextEncoder", () => {
    expect(utf8Bytes("abc")).toEqual(new TextEncoder().encode("abc"));
  });
});
