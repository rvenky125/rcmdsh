import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { b64ToBytes, bytesToB64, generateKeyPair } from "rcmdsh-core";

export interface PairedDevice {
  clientId: string;
  name: string;
  clientPubKey: string;
  pairedAt: string;
}

export interface DaemonConfig {
  relayUrl: string;
  deviceId: string;
  name: string;
  keys: {
    publicKey: string;
    secretKey: string;
  };
  allowedShells: string[];
  daemonToken: string | null;
  pairedDevices: PairedDevice[];
}

export function getConfigDir(): string {
  return process.env.RCMDSH_HOME ?? path.join(os.homedir(), ".rcmdsh");
}

export function getConfigPath(): string {
  return path.join(getConfigDir(), "config.json");
}

function defaultAllowedShells(platform: NodeJS.Platform): string[] {
  switch (platform) {
    case "win32":
      return ["powershell", "cmd"];
    case "darwin":
      return ["zsh", "bash"];
    default:
      return ["bash", "sh"];
  }
}

export function defaultConfig(): DaemonConfig {
  const keys = generateKeyPair();
  return {
    relayUrl: "",
    deviceId: crypto.randomUUID(),
    name: os.hostname(),
    keys: {
      publicKey: bytesToB64(keys.publicKey),
      secretKey: bytesToB64(keys.secretKey),
    },
    allowedShells: defaultAllowedShells(process.platform),
    daemonToken: null,
    pairedDevices: [],
  };
}

export function loadConfig(): DaemonConfig {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    const config = defaultConfig();
    saveConfig(config);
    return config;
  }
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as Partial<DaemonConfig>;
  const defaults = defaultConfig();
  const config: DaemonConfig = {
    relayUrl: raw.relayUrl ?? defaults.relayUrl,
    deviceId: raw.deviceId ?? defaults.deviceId,
    name: raw.name ?? defaults.name,
    keys: raw.keys ?? defaults.keys,
    allowedShells: raw.allowedShells ?? defaults.allowedShells,
    daemonToken: raw.daemonToken ?? null,
    pairedDevices: raw.pairedDevices ?? [],
  };
  return config;
}

export function saveConfig(config: DaemonConfig): void {
  const dir = getConfigDir();
  fs.mkdirSync(dir, { recursive: true });
  const configPath = getConfigPath();
  const tmpPath = configPath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(tmpPath, configPath);
}

export function getKeyPair(config: DaemonConfig): { publicKey: Uint8Array; secretKey: Uint8Array } {
  return {
    publicKey: b64ToBytes(config.keys.publicKey),
    secretKey: b64ToBytes(config.keys.secretKey),
  };
}
