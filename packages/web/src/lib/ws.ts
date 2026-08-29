import {
  b64ToBytes,
  bytesToB64,
  deriveSessionKey,
  deriveSharedSecret,
  frame,
  openSealed,
  parseDaemonToClient,
  seal,
  utf8Bytes,
  type ClientToDaemonMessage,
  type DaemonToClientMessage,
  type EncryptedFrame,
} from "rcmdsh-core";
import { clientKeyPairFrom, relayWsUrl, type PairingState } from "./store";

export interface ConnectionStatus {
  connected: boolean;
  daemonOnline: boolean;
}

export interface RelaySocketHandlers {
  onMessage: (message: DaemonToClientMessage) => void;
  onStatus: (status: ConnectionStatus) => void;
  onReady: () => void;
}

const MAX_BACKOFF_MS = 20_000;

export class RelaySocket {
  private ws: WebSocket | null = null;
  private sessionKey: Uint8Array | null = null;
  private daemonOnline = false;
  private ready = false;
  private closedByUser = false;
  private retryAttempts = 0;
  private retryTimer: number | null = null;

  constructor(
    private readonly pairing: PairingState,
    private readonly handlers: RelaySocketHandlers,
  ) {
    if (!pairing.insecure) {
      const pair = clientKeyPairFrom(pairing);
      const daemonPub = b64ToBytes(pairing.daemonPubKey);
      const shared = deriveSharedSecret(pair.secretKey, daemonPub);
      this.sessionKey = deriveSessionKey(shared);
    }
  }

  connect(): void {
    this.closedByUser = false;
    this.open();
  }

  close(): void {
    this.closedByUser = true;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.ready = false;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // already closed
      }
      this.ws = null;
    }
  }

  send(message: ClientToDaemonMessage): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (this.sessionKey) {
      const plaintext = utf8Bytes(JSON.stringify(message));
      const sealed = seal(this.sessionKey, plaintext);
      const encFrame: EncryptedFrame = {
        v: 1,
        enc: true,
        msgId: message.msgId,
        ts: message.ts,
        data: bytesToB64(sealed),
      };
      ws.send(JSON.stringify(encFrame));
    } else {
      ws.send(JSON.stringify(message));
    }
  }

  request(fields: Record<string, unknown>): void {
    this.send(frame(fields) as unknown as ClientToDaemonMessage);
  }

  private open(): void {
    if (this.closedByUser) return;
    const ws = new WebSocket(relayWsUrl(this.pairing.relay));
    this.ws = ws;

    ws.onopen = () => {
      ws.send(
        JSON.stringify(frame({ type: "relay.hello", role: "client", token: this.pairing.token })),
      );
    };

    ws.onmessage = (event) => {
      this.handleText(String(event.data));
    };

    ws.onclose = () => {
      const wasReady = this.ready;
      this.ready = false;
      this.ws = null;
      this.handlers.onStatus({ connected: false, daemonOnline: this.daemonOnline });
      if (wasReady) {
        this.handlers.onMessage({ v: 1, msgId: "local", ts: Date.now(), type: "error", code: "disconnected", message: "Connection lost, reconnecting..." });
      }
      this.scheduleRetry();
    };

    ws.onerror = () => {
      // close handler schedules the retry
    };
  }

  private handleText(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const msg = parsed as Record<string, unknown>;

    switch (msg["type"]) {
      case "relay.welcome": {
        this.markReady();
        this.announce();
        return;
      }
      case "relay.status": {
        const wasOnline = this.daemonOnline;
        this.daemonOnline = msg["daemonOnline"] === true;
        this.handlers.onStatus({ connected: true, daemonOnline: this.daemonOnline });
        if (this.daemonOnline && !wasOnline) {
          this.announce();
        }
        this.markReady();
        return;
      }
      case "relay.reject": {
        this.handlers.onMessage({
          v: 1,
          msgId: "local",
          ts: Date.now(),
          type: "error",
          code: String(msg["code"] ?? "rejected"),
          message: String(msg["message"] ?? "relay rejected the connection"),
        });
        return;
      }
      case "relay.error": {
        this.handlers.onMessage({
          v: 1,
          msgId: "local",
          ts: Date.now(),
          type: "error",
          code: String(msg["code"] ?? "error"),
          message: String(msg["message"] ?? "relay error"),
        });
        return;
      }
      default:
        break;
    }

    if (this.sessionKey) {
      if (msg["enc"] !== true) return;
      const encCheck = msg as unknown as EncryptedFrame;
      const opened = openSealed(this.sessionKey, b64ToBytes(encCheck.data));
      if (opened === null) return;
      try {
        parsed = JSON.parse(new TextDecoder().decode(opened)) as unknown;
      } catch {
        return;
      }
    }

    const appMessage = parseDaemonToClient(parsed);
    if (appMessage.ok) {
      this.handlers.onMessage(appMessage.value);
    }
  }

  private announce(): void {
    if (!this.pairing.insecure) {
      this.ws?.send(
        JSON.stringify({ type: "e2e.hello", clientPubKey: this.pairing.clientPubKey }),
      );
    }
    this.request({ type: "sessions.list" });
  }

  private markReady(): void {
    if (!this.ready) {
      this.ready = true;
      this.retryAttempts = 0;
      this.handlers.onStatus({ connected: true, daemonOnline: this.daemonOnline });
      this.handlers.onReady();
    }
  }

  private scheduleRetry(): void {
    if (this.closedByUser || this.retryTimer !== null) return;
    const backoff = Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.retryAttempts);
    const delay = Math.round(backoff * (0.7 + Math.random() * 0.6));
    this.retryAttempts++;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.open();
    }, delay);
  }
}
