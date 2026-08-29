import { bytesToB64, b64ToBytes, generateKeyPair } from "@rcmdsh/shared";

export interface PairingState {
  relay: string;
  deviceId: string;
  deviceName: string;
  clientId: string;
  clientName: string;
  token: string;
  daemonPubKey: string;
  clientPubKey: string;
  clientSecretKey: string;
  insecure: boolean;
}

const STORAGE_KEY = "rcmdsh.pairing.v1";

export function loadPairing(): PairingState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PairingState;
    if (typeof parsed.relay !== "string" || typeof parsed.token !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function savePairing(state: PairingState): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function clearPairing(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function newClientKeyPair(): { publicKey: string; secretKey: string } {
  const pair = generateKeyPair();
  return {
    publicKey: bytesToB64(pair.publicKey),
    secretKey: bytesToB64(pair.secretKey),
  };
}

export function clientKeyPairFrom(state: PairingState): { publicKey: Uint8Array; secretKey: Uint8Array } {
  return {
    publicKey: b64ToBytes(state.clientPubKey),
    secretKey: b64ToBytes(state.clientSecretKey),
  };
}

export function relayWsUrl(relay: string): string {
  const base = relay.replace(/\/+$/, "");
  if (base.startsWith("https://")) return "wss://" + base.slice(8) + "/ws/client";
  if (base.startsWith("http://")) return "ws://" + base.slice(7) + "/ws/client";
  return base.replace(/^wss?:\/\//, (m) => m) + "/ws/client";
}
