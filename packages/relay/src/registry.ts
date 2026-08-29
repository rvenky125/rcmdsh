import Database from "better-sqlite3";
import crypto from "node:crypto";
import { generateToken } from "@rcmdsh/shared";

const PAIRING_TTL_MS = 5 * 60 * 1000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export interface DeviceRow {
  deviceId: string;
  name: string;
  daemonPubKey: string;
  createdAt: number;
}

export interface TokenInfo {
  role: "daemon" | "client";
  deviceId: string;
  clientId: string | null;
}

export interface ClaimResult {
  deviceId: string;
  daemonPubKey: string;
  clientId: string;
  clientName: string;
  clientToken: string;
}

export interface PairStatus {
  status: "pending" | "claimed" | "expired";
  daemonToken?: string;
  clientPubKey?: string;
  clientId?: string;
  clientName?: string;
}

interface PairingRow {
  code: string;
  device_id: string;
  status: "pending" | "claimed";
  client_pub_key: string | null;
  client_name: string | null;
  client_id: string | null;
  client_token: string | null;
  daemon_token: string | null;
  expires_at: number;
  attempts: number;
}

export function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

export function generatePairingCode(): string {
  const bytes = crypto.randomBytes(8);
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  return code;
}

export class Registry {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        device_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        daemon_pub_key TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tokens (
        token_hash TEXT NOT NULL,
        role TEXT NOT NULL,
        device_id TEXT NOT NULL,
        client_id TEXT,
        revoked INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (token_hash, role)
      );
      CREATE TABLE IF NOT EXISTS pairings (
        code TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        status TEXT NOT NULL,
        client_pub_key TEXT,
        client_name TEXT,
        client_id TEXT,
        client_token TEXT,
        daemon_token TEXT,
        expires_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  upsertDevice(deviceId: string, name: string, daemonPubKey: string): DeviceRow {
    const existing = this.getDevice(deviceId);
    if (existing) {
      this.db
        .prepare("UPDATE devices SET name = ?, daemon_pub_key = ? WHERE device_id = ?")
        .run(name, daemonPubKey, deviceId);
    } else {
      this.db
        .prepare("INSERT INTO devices (device_id, name, daemon_pub_key, created_at) VALUES (?, ?, ?, ?)")
        .run(deviceId, name, daemonPubKey, Date.now());
    }
    return this.getDevice(deviceId)!;
  }

  getDevice(deviceId: string): DeviceRow | null {
    const row = this.db
      .prepare<[string], { device_id: string; name: string; daemon_pub_key: string; created_at: number }>(
        "SELECT device_id, name, daemon_pub_key, created_at FROM devices WHERE device_id = ?",
      )
      .get(deviceId);
    if (!row) return null;
    return {
      deviceId: row.device_id,
      name: row.name,
      daemonPubKey: row.daemon_pub_key,
      createdAt: row.created_at,
    };
  }

  storeToken(token: string, role: "daemon" | "client", deviceId: string, clientId: string | null): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO tokens (token_hash, role, device_id, client_id, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(sha256Hex(token), role, deviceId, clientId, Date.now());
  }

  storeDaemonToken(token: string): void {
    this.storeToken(token, "daemon", "dev", null);
  }

  lookupToken(token: string, role: "daemon" | "client"): TokenInfo | null {
    const row = this.db
      .prepare<[string, string], { device_id: string; client_id: string | null }>(
        "SELECT device_id, client_id FROM tokens WHERE token_hash = ? AND role = ? AND revoked = 0",
      )
      .get(sha256Hex(token), role);
    if (!row) return null;
    return { role, deviceId: row.device_id, clientId: row.client_id };
  }

  debugTokens(): Array<{ role: string; deviceId: string }> {
    return this.db
      .prepare<[], { role: string; device_id: string }>("SELECT role, device_id FROM tokens")
      .all()
      .map((row) => ({ role: row.role, deviceId: row.device_id }));
  }

  revokeDeviceTokens(deviceId: string): void {
    this.db.prepare("UPDATE tokens SET revoked = 1 WHERE device_id = ?").run(deviceId);
  }

  createPairing(deviceId: string): { pairingCode: string; expiresAt: number } {
    const code = generatePairingCode();
    const expiresAt = Date.now() + PAIRING_TTL_MS;
    this.db
      .prepare("INSERT INTO pairings (code, device_id, status, expires_at) VALUES (?, ?, 'pending', ?)")
      .run(code, deviceId, expiresAt);
    return { pairingCode: code, expiresAt };
  }

  claimPairing(code: string, clientPubKey: string, clientName: string): ClaimResult | "expired" | "pending" | "conflict" | "too_many_attempts" {
    const row = this.db
      .prepare<[string], PairingRow>("SELECT * FROM pairings WHERE code = ?")
      .get(code);
    if (!row) return "expired";
    if (row.expires_at < Date.now()) return "expired";

    const bumpAttempts = () =>
      this.db.prepare("UPDATE pairings SET attempts = attempts + 1 WHERE code = ?").run(code);

    if (row.status === "claimed") {
      if (row.client_pub_key === clientPubKey && row.client_token) {
        return {
          deviceId: row.device_id,
          daemonPubKey: this.getDevice(row.device_id)?.daemonPubKey ?? "",
          clientId: row.client_id!,
          clientName: row.client_name!,
          clientToken: row.client_token,
        };
      }
      if (row.attempts >= 10) return "too_many_attempts";
      bumpAttempts();
      return "conflict";
    }

    if (row.attempts >= 10) return "too_many_attempts";
    bumpAttempts();

    const clientToken = generateToken();
    const daemonToken = generateToken();
    const clientId = crypto.randomUUID();
    this.db
      .prepare(
        `UPDATE pairings
         SET status = 'claimed', client_pub_key = ?, client_name = ?, client_id = ?, client_token = ?, daemon_token = ?
         WHERE code = ?`,
      )
      .run(clientPubKey, clientName, clientId, clientToken, daemonToken, code);

    this.storeToken(clientToken, "client", row.device_id, clientId);
    this.storeToken(daemonToken, "daemon", row.device_id, null);

    return {
      deviceId: row.device_id,
      daemonPubKey: this.getDevice(row.device_id)?.daemonPubKey ?? "",
      clientId,
      clientName,
      clientToken,
    };
  }

  pollPairing(deviceId: string, code: string): PairStatus {
    const row = this.db
      .prepare<[string, string], PairingRow>("SELECT * FROM pairings WHERE code = ? AND device_id = ?")
      .get(code, deviceId);
    if (!row) return { status: "expired" };
    if (row.expires_at < Date.now()) return { status: "expired" };
    if (row.status !== "claimed") return { status: "pending" };
    return {
      status: "claimed",
      daemonToken: row.daemon_token ?? undefined,
      clientPubKey: row.client_pub_key ?? undefined,
      clientId: row.client_id ?? undefined,
      clientName: row.client_name ?? undefined,
    };
  }

  cleanupExpired(): void {
    this.db.prepare("DELETE FROM pairings WHERE expires_at < ?").run(Date.now() - PAIRING_TTL_MS);
  }
}
