import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getConfigPath, loadConfig, saveConfig, defaultConfig } from "../src/config";
import { allowedShellsForPlatform, shellsForPlatform } from "../src/pty/shells";

describe("config", () => {
  it("creates defaults, saves and reloads", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "rcmdsh-home-"));
    process.env.RCMDSH_HOME = home;
    try {
      expect(fs.existsSync(getConfigPath())).toBe(false);

      const first = loadConfig();
      expect(fs.existsSync(getConfigPath())).toBe(true);
      expect(first.deviceId).toBeTruthy();
      expect(first.keys.publicKey).toBeTruthy();
      expect(first.keys.secretKey).toBeTruthy();
      expect(first.allowedShells.length).toBeGreaterThan(0);

      first.relayUrl = "ws://relay.example:8787";
      first.allowedShells = ["powershell"];
      first.pairedDevices.push({
        clientId: "client-1",
        name: "pixel",
        clientPubKey: "AAA=",
        pairedAt: new Date().toISOString(),
      });
      saveConfig(first);

      const second = loadConfig();
      expect(second).toEqual(first);
    } finally {
      delete process.env.RCMDSH_HOME;
    }
  });

  it("default shells are valid for the platform", () => {
    const config = defaultConfig();
    const resolved = allowedShellsForPlatform(config.allowedShells);
    expect(resolved.length).toBe(config.allowedShells.length);
    expect(shellsForPlatform().length).toBeGreaterThan(0);
  });
});
