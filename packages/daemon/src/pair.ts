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

export async function pairWithRelay(options: PairOptions): Promise<PairResult> {
  const { config, relayBase, phoneBase, log } = options;
  if (options.deviceName) {
    config.name = options.deviceName;
  }

  log(`registering with relay ${relayBase} ...`);
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

  const pairUrl = `${phoneBase}/#/pair?relay=${encodeURIComponent(phoneBase)}&code=${start.pairingCode}`;
  log("");
  log("Pair your phone:");
  log("  1. Scan this QR code with your phone camera (or open the URL below)");
  log("  2. Tap \"Pair\" on the page");
  log("");
  log(`  ${pairUrl}`);
  log(`  Pairing code: ${start.pairingCode}`);
  log("");

  const qrcode = (await import("qrcode-terminal")).default;
  qrcode.generate(pairUrl, { small: true });

  log("Waiting for a device to pair (expires in 5 minutes) ...");

  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const statusRes = await fetch(
      `${relayBase}/v1/pair/status?deviceId=${encodeURIComponent(config.deviceId)}&code=${encodeURIComponent(start.pairingCode)}`,
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
    log("");
    log(`Paired "${clientName}" successfully.`);
    return { clientName };
  }
  throw new Error("timed out waiting for a device to pair");
}

export function isPairedFor(config: DaemonConfig, relayBase: string): boolean {
  return Boolean(config.daemonToken) && normalizeRelayBase(config.relayUrl) === normalizeRelayBase(relayBase);
}
