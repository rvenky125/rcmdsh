import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describeSpawnError, ensureSpawnHelper, spawnHelperCandidates } from "../src/pty/spawnEnv";

describe("spawnEnv", () => {
  it("is a no-op off macOS", () => {
    const check = ensureSpawnHelper({ platform: "win32" });
    expect(check.ok).toBe(true);
  });

  it("finds a helper in a fake node-pty layout", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "node-pty-"));
    const dir = path.join(root, "prebuilds", "darwin-arm64");
    fs.mkdirSync(dir, { recursive: true });
    const helper = path.join(dir, "spawn-helper");
    fs.writeFileSync(helper, "#!/bin/sh\n");
    fs.chmodSync(helper, 0o755);
    const check = ensureSpawnHelper({ platform: "darwin", arch: "arm64", packageDir: root });
    expect(check).toMatchObject({ ok: true, helperPath: helper });
  });

  it("reports a missing helper with a fix", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "node-pty-empty-"));
    const check = ensureSpawnHelper({ platform: "darwin", arch: "arm64", packageDir: root });
    expect(check.ok).toBe(false);
    expect(check.message).toMatch(/spawn-helper is missing/);
  });

  it("lists the same lookup order node-pty uses", () => {
    expect(spawnHelperCandidates("/pkg", "darwin", "arm64")).toEqual([
      path.join("/pkg", "build", "Release", "spawn-helper"),
      path.join("/pkg", "build", "Debug", "spawn-helper"),
      path.join("/pkg", "prebuilds", "darwin-arm64", "spawn-helper"),
    ]);
  });

  it("explains posix_spawnp failures on macOS", () => {
    const message = describeSpawnError(new Error("posix_spawnp failed."), "zsh", "darwin");
    expect(message).toMatch(/spawn-helper could not start/);
    expect(message).toMatch(/zsh/);
  });

  it("falls back to a shell-on-PATH hint otherwise", () => {
    const message = describeSpawnError(new Error("boom"), "bash", "linux");
    expect(message).toMatch(/is it installed and on PATH/);
  });
});
