import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;

const envelopeFields = {
  v: z.literal(PROTOCOL_VERSION),
  msgId: z.string().min(1),
  ts: z.number(),
};

// ---- client <-> daemon application messages ----

export const ClientToDaemonMessage = z.discriminatedUnion("type", [
  z.object({ ...envelopeFields, type: z.literal("sessions.list") }),
  z.object({
    ...envelopeFields,
    type: z.literal("session.create"),
    shell: z.string().min(1),
    cols: z.number().int().min(2).max(500).default(80),
    rows: z.number().int().min(2).max(300).default(24),
    visible: z.boolean().optional(),
  }),
  z.object({
    ...envelopeFields,
    type: z.literal("session.input"),
    id: z.string().min(1),
    data: z.string().min(1),
  }),
  z.object({
    ...envelopeFields,
    type: z.literal("session.resize"),
    id: z.string().min(1),
    cols: z.number().int().min(2).max(500),
    rows: z.number().int().min(2).max(300),
  }),
  z.object({
    ...envelopeFields,
    type: z.literal("session.attach"),
    id: z.string().min(1),
    cols: z.number().int().min(2).max(500).optional(),
    rows: z.number().int().min(2).max(300).optional(),
  }),
  z.object({
    ...envelopeFields,
    type: z.literal("session.kill"),
    id: z.string().min(1),
  }),
]);

export const SessionInfo = z.object({
  id: z.string(),
  shell: z.string(),
  title: z.string(),
  createdAt: z.number(),
  alive: z.boolean(),
  origin: z.enum(["pty", "bridge"]).default("pty"),
  pid: z.number().nullable().default(null),
});

export const ShellInfo = z.object({
  id: z.string(),
  name: z.string(),
});

export const DaemonToClientMessage = z.discriminatedUnion("type", [
  z.object({
    ...envelopeFields,
    type: z.literal("sessions.list"),
    sessions: z.array(SessionInfo),
  }),
  z.object({
    ...envelopeFields,
    type: z.literal("capabilities"),
    shells: z.array(ShellInfo),
  }),
  z.object({
    ...envelopeFields,
    type: z.literal("session.output"),
    id: z.string(),
    data: z.string(),
  }),
  z.object({
    ...envelopeFields,
    type: z.literal("session.exit"),
    id: z.string(),
    exitCode: z.number().nullable(),
  }),
  z.object({
    ...envelopeFields,
    type: z.literal("error"),
    code: z.string(),
    message: z.string(),
  }),
]);

export type ClientToDaemonMessage = z.infer<typeof ClientToDaemonMessage>;
export type DaemonToClientMessage = z.infer<typeof DaemonToClientMessage>;
export type SessionInfo = z.infer<typeof SessionInfo>;
export type ShellInfo = z.infer<typeof ShellInfo>;

// ---- daemon <-> attach bridge messages ----
// Exchanged over a token-authenticated localhost websocket between the daemon's
// attach gateway and an `rcmdsh attach` client. Never routed through the relay
// and never end-to-end encrypted (both endpoints are on the same machine).

export const BridgeToDaemonMessage = z.discriminatedUnion("type", [
  z.object({
    ...envelopeFields,
    type: z.literal("bridge.hello"),
    token: z.string().min(1),
    shell: z.string().min(1),
    cols: z.number().int().min(2).max(500),
    rows: z.number().int().min(2).max(300),
    pid: z.number().int().nullable().default(null),
    bridgeId: z.string().min(1).optional(),
  }),
  z.object({
    ...envelopeFields,
    type: z.literal("bridge.output"),
    id: z.string().min(1),
    data: z.string().min(1),
  }),
  z.object({
    ...envelopeFields,
    type: z.literal("bridge.exit"),
    id: z.string().min(1),
    exitCode: z.number().nullable(),
  }),
  z.object({
    ...envelopeFields,
    type: z.literal("bridge.resize"),
    id: z.string().min(1),
    cols: z.number().int().min(2).max(500),
    rows: z.number().int().min(2).max(300),
  }),
]);

export const DaemonToBridgeMessage = z.discriminatedUnion("type", [
  z.object({
    ...envelopeFields,
    type: z.literal("bridge.welcome"),
    id: z.string().min(1),
    shell: z.string().min(1),
  }),
  z.object({
    ...envelopeFields,
    type: z.literal("bridge.input"),
    id: z.string().min(1),
    data: z.string().min(1),
  }),
  z.object({
    ...envelopeFields,
    type: z.literal("bridge.resize"),
    id: z.string().min(1),
    cols: z.number().int().min(2).max(500),
    rows: z.number().int().min(2).max(300),
  }),
  z.object({
    ...envelopeFields,
    type: z.literal("bridge.kill"),
    id: z.string().min(1),
  }),
  z.object({
    ...envelopeFields,
    type: z.literal("bridge.error"),
    code: z.string(),
    message: z.string(),
  }),
]);

export type BridgeToDaemonMessage = z.infer<typeof BridgeToDaemonMessage>;
export type DaemonToBridgeMessage = z.infer<typeof DaemonToBridgeMessage>;

export function parseBridgeToDaemon(value: unknown): ParseResult<BridgeToDaemonMessage> {
  const parsed = BridgeToDaemonMessage.safeParse(value);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: formatIssues(parsed.error) };
}

export function parseDaemonToBridge(value: unknown): ParseResult<DaemonToBridgeMessage> {
  const parsed = DaemonToBridgeMessage.safeParse(value);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: formatIssues(parsed.error) };
}

// ---- relay control messages (terminated at the relay, never end-to-end encrypted) ----

export const RelayHello = z.object({
  type: z.literal("relay.hello"),
  role: z.enum(["daemon", "client"]),
  token: z.string().min(1),
});

export const RelayWelcome = z.object({
  type: z.literal("relay.welcome"),
  deviceId: z.string(),
  clientId: z.string().optional(),
  name: z.string().optional(),
});

export const RelayReject = z.object({
  type: z.literal("relay.reject"),
  code: z.string(),
  message: z.string(),
});

export const RelayStatus = z.object({
  type: z.literal("relay.status"),
  daemonOnline: z.boolean(),
});

export const RelayError = z.object({
  type: z.literal("relay.error"),
  code: z.string(),
  message: z.string(),
});

// Envelope the relay uses to carry app frames between a client and the daemon.
// The relay sees the envelope but never the (encrypted) frame contents.
export const RelayRoute = z.object({
  type: z.literal("relay.route"),
  from: z.string().optional(),
  to: z.string().optional(),
  frame: z.string().min(1),
});

export type RelayHello = z.infer<typeof RelayHello>;
export type RelayWelcome = z.infer<typeof RelayWelcome>;
export type RelayReject = z.infer<typeof RelayReject>;
export type RelayStatus = z.infer<typeof RelayStatus>;
export type RelayError = z.infer<typeof RelayError>;
export type RelayRoute = z.infer<typeof RelayRoute>;

// ---- end-to-end encryption framing ----

export const EncryptedFrame = z.object({
  v: z.literal(PROTOCOL_VERSION),
  enc: z.literal(true),
  msgId: z.string(),
  ts: z.number(),
  data: z.string().min(1),
});

export type EncryptedFrame = z.infer<typeof EncryptedFrame>;

export const E2EHello = z.object({
  type: z.literal("e2e.hello"),
  clientPubKey: z.string().min(1),
});

export type E2EHello = z.infer<typeof E2EHello>;

export function randomId(): string {
  if (typeof globalThis.crypto !== "undefined" && "randomUUID" in globalThis.crypto) {
    return globalThis.crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function frame<T extends Record<string, unknown>>(
  fields: T,
): { v: typeof PROTOCOL_VERSION; msgId: string; ts: number } & T {
  return {
    v: PROTOCOL_VERSION,
    msgId: randomId(),
    ts: Date.now(),
    ...fields,
  };
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseJson(text: string): ParseResult<unknown> {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: "invalid JSON" };
  }
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
}

export function parseClientToDaemon(value: unknown): ParseResult<ClientToDaemonMessage> {
  const parsed = ClientToDaemonMessage.safeParse(value);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: formatIssues(parsed.error) };
}

export function parseDaemonToClient(value: unknown): ParseResult<DaemonToClientMessage> {
  const parsed = DaemonToClientMessage.safeParse(value);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: formatIssues(parsed.error) };
}
