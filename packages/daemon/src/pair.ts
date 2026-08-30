import type { DaemonConfig } from "./config";
import { saveConfig } from "./config";

export function normalizeRelayBase(url: string): string {
  return url.replace(/\/+$/, "").replace(/\/(ws|api).*$/, "");
}

export function httpBase(relayUrl: string): string {
  const base = normalizeRelayBase(relayUrl);
  if (base.startsWith("wss://")) return "https://" + base.slice(6);
  if (base.startsWith("ws://")) return "http://" + base.slice(5);
  return base;
}

export interface PairOptions {
  config: DaemonConfig;
  relayBase: string;
  phoneBase: string;
  deviceName?: string;
  log: (message: string) => void;
}

export interface PairResult {
  clientName: string;
}

interface PairStatusResponse {
  status: "pending" | "claimed" | "expired";
  daemonToken?: string;
  clientPubKey?: string;
  clientId?: string;
  clientName?: string;
}

export interface FreshPairing {
  code: string;
  pairUrl: string;
  expiresAt: number;
}

// Asks the relay for a fresh single-use pairing code and builds the URL a
// phone should open. The PWA pre-fills (and claims) the code from this URL
// automatically, so scanning the QR is all a new device needs to do.
export async function requestPairing(options: {
  config: DaemonConfig;
  relayBase: string;
  phoneBase: string;
  deviceName?: string;
}): Promise<FreshPairing> {
  const { config, relayBase, phoneBase } = options;
  if (options.deviceName) {
    config.name = options.deviceName;
  }

  const startRes = await fetch(`${relayBase}/v1/pair/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      deviceId: config.deviceId,
      name: config.name,
      daemonPubKey: config.keys.publicKey,
    }),
  });
  if (!startRes.ok) {
    throw new Error(`pair/start failed: ${startRes.status} ${await startRes.text()}`);
  }
  const start = (await startRes.json()) as { pairingCode: string; expiresAt: number };
  return {
    code: start.pairingCode,
    expiresAt: start.expiresAt,
    pairUrl: `${phoneBase}/#/pair?relay=${encodeURIComponent(phoneBase)}&code=${start.pairingCode}`,
  };
}

// Polls the relay until the given pairing code is claimed, then records the
// new device (and fresh daemon token) in the config. Resolves with the client
// name; rejects when the code expires, the deadline passes, or the relay is
// unreachable.
export async function awaitPairingClaim(options: {
  config: DaemonConfig;
  relayBase: string;
  code: string;
  log?: (message: string) => void;
  onPaired?: (clientName: string) => void;
}): Promise<string> {
  const { config, relayBase, code } = options;
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const statusRes = await fetch(
      `${relayBase}/v1/pair/status?deviceId=${encodeURIComponent(config.deviceId)}&code=${encodeURIComponent(code)}`,
    );
    if (!statusRes.ok) {
      throw new Error(`pair/status failed: ${statusRes.status}`);
    }
    const status = (await statusRes.json()) as PairStatusResponse;
    if (status.status === "pending") continue;
    if (status.status === "expired") {
      throw new Error("pairing code expired - run the command again");
    }
    if (!status.daemonToken || !status.clientPubKey || !status.clientId) {
      throw new Error("relay returned an incomplete pairing result");
    }

    config.relayUrl = relayBase;
    config.daemonToken = status.daemonToken;
    config.pairedDevices = config.pairedDevices.filter((d) => d.clientId !== status.clientId);
    config.pairedDevices.push({
      clientId: status.clientId,
      name: status.clientName ?? "mobile device",
      clientPubKey: status.clientPubKey,
      pairedAt: new Date().toISOString(),
    });
    saveConfig(config);

    const clientName = status.clientName ?? "mobile device";
    options.onPaired?.(clientName);
    return clientName;
  }
  throw new Error("timed out waiting for a device to pair");
}

export async function pairWithRelay(options: PairOptions): Promise<PairResult> {
  const { config, relayBase, log } = options;

  log(`registering with relay ${relayBase} ...`);
  const fresh = await requestPairing({
    config,
    relayBase,
    phoneBase: options.phoneBase,
    deviceName: options.deviceName,
  });

  log("");
  log("Pair your phone:");
  log("  1. Scan this QR code with your phone camera (or open the URL below)");
  log("  2. The app pairs automatically");
  log("");
  log(`  ${fresh.pairUrl}`);
  log(`  Pairing code: ${fresh.code}`);
  log("");

  const qrcode = (await import("qrcode-terminal")).default;
  qrcode.generate(fresh.pairUrl, { small: true });

  log("Waiting for a device to pair (expires in 5 minutes) ...");
  const clientName = await awaitPairingClaim({ config, relayBase, code: fresh.code, log });
  log("");
  log(`Paired "${clientName}" successfully.`);
  return { clientName };
}

export function isPairedFor(config: DaemonConfig, relayBase: string): boolean {
  return Boolean(config.daemonToken) && normalizeRelayBase(config.relayUrl) === normalizeRelayBase(relayBase);
}
