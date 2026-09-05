#!/usr/bin/env node
import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { startRelay } from "rcmdsh-relay/dist/server";
import { loadConfig, saveConfig, getConfigDir } from "./config";
import { SHELL_CATALOG, allowedShellsForPlatform } from "./pty/shells";
import { ensureSpawnHelper } from "./pty/spawnEnv";
import { DaemonApp } from "./app";
import { runAttach } from "./attach/AttachClient";
import { Tui } from "./tui/Tui";
import { pairWithRelay, isPairedFor, normalizeRelayBase, httpBase, requestPairing, awaitPairingClaim } from "./pair";
import { detectLanIp, lanIpCandidates } from "./net";

const VERSION = "0.3.9";
const DEFAULT_HOSTED_RELAY = "https://rcmdsh.vendroid.dev";
const DEFAULT_PORT = 8787;

type Logger = (message: string) => void;

const program = new Command();
// The root program and subcommands both declare flags like --relay; without
// this, the root parser consumes `--relay <url>` even when it appears after a
// subcommand name (e.g. `rcmdsh start --relay ...`).
program.enablePositionalOptions();

program
  .name("rcmdsh")
  .description("Control your computer's shell from your phone. One command, one QR code.")
  .version(VERSION)
  .option("--relay <url>", "connect through a hosted relay instead of the built-in one")
  .option("--port <number>", "port for the built-in relay (LAN mode)", String(DEFAULT_PORT))
  .option("--name <name>", "name for this computer")
  .option("--lan <ip>", "override the LAN IP shown in the QR code")
  .option("--tui", "show the interactive session screen (default: plain logs that keep the QR code visible)")
  .action(async (options: { relay?: string; port: string; name?: string; lan?: string; tui?: boolean }) => {
    await runDefault(options);
  });

async function runDefault(options: {
  relay?: string;
  port: string;
  name?: string;
  lan?: string;
  tui?: boolean;
}): Promise<void> {
  const log = makeLogger();
  const spawnCheck = ensureSpawnHelper({ log });
  if (!spawnCheck.ok) {
    log(`warning: ${spawnCheck.message} (sessions may fail to spawn)`);
  }
  const config = loadConfig();
  if (options.name) {
    config.name = options.name;
    saveConfig(config);
  }

  let daemonBase: string;
  let phoneBase: string;

  if (options.relay) {
    daemonBase = normalizeRelayBase(options.relay);
    phoneBase = daemonBase;
    log(`using hosted relay ${daemonBase}`);
  } else {
    const port = Number.parseInt(options.port, 10);
    daemonBase = `http://127.0.0.1:${port}`;
    const chosenIp = options.lan ?? detectLanIp();
    if (chosenIp) {
      phoneBase = `http://${chosenIp}:${port}`;
    } else {
      phoneBase = daemonBase;
      log("warning: could not detect a LAN IP - the QR uses localhost (only works on this machine)");
    }
    await ensureLocalRelay(port, log);
    const others = lanIpCandidates().filter((ip) => ip !== chosenIp);
    if (others.length > 0 && phoneBase !== daemonBase) {
      log(`other LAN addresses: ${others.join(", ")}  (pick one with --lan <ip> if the QR does not work)`);
    }
  }

  if (isPairedFor(config, daemonBase)) {
    const names = config.pairedDevices.map((d) => d.name).join(", ");
    log(`already paired with: ${names || "a device"}`);
  } else {
    try {
      await pairWithRelay({ config, relayBase: daemonBase, phoneBase, log });
    } catch (err) {
      log(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }

  const pairingCode = await printPairQr(config, daemonBase, phoneBase, log);
  if (pairingCode) {
    void awaitPairingClaim({ config, relayBase: daemonBase, code: pairingCode, log })
      .then((name) => log(`paired "${name}" - it can now control this computer`))
      .catch(() => {
        // code expired or nobody scanned it; restarting shows a fresh one
      });
  }
  log("connection started - sessions run in the background on this computer");
  log("press Ctrl+C here to stop");
  startDaemonLoop(config, log, { tui: options.tui });
}

async function ensureLocalRelay(port: number, log: Logger): Promise<void> {
  const base = `http://127.0.0.1:${port}`;
  try {
    const res = await fetch(`${base}/health`);
    if (res.ok) {
      log(`relay already running on port ${port} - reusing it`);
      return;
    }
  } catch {
    // not running - start it below
  }
  const bundledWeb = path.join(__dirname, "..", "public");
  const webDist = fs.existsSync(bundledWeb) ? bundledWeb : null;
  try {
    await startRelay({
      port,
      host: "0.0.0.0",
      dbPath: path.join(getConfigDir(), "relay.db"),
      webDist,
      log: (message) => log(`relay: ${message}`),
    });
    log(`built-in relay started on port ${port} (data: ${path.join(getConfigDir(), "relay.db")})`);
  } catch (err) {
    log(`could not start the built-in relay on port ${port}: ${err instanceof Error ? err.message : String(err)}`);
    log("is another program using the port? try a different one: rcmdsh --port 8788");
    process.exit(1);
  }
}

function startDaemonLoop(
  config: ReturnType<typeof loadConfig>,
  log: Logger,
  options: { tui?: boolean; insecure?: boolean } = {},
): void {
  const token = config.daemonToken;
  if (!token) {
    log("not paired yet - pairing did not complete");
    process.exit(1);
  }
  log(`device "${config.name}" (${config.deviceId})`);
  const app = new DaemonApp({ config, token, insecure: options.insecure ?? false, log });
  const tui = options.tui && process.stdout.isTTY ? new Tui({ deviceName: config.name, hooks: app.tuiHooks() }) : null;
  void app.start().catch((err: unknown) => {
    log(`daemon failed to start: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
  log("tip: run `rcmdsh attach` in any terminal window to share it with your phone");
  if (tui) {
    app.setLocalOutputListener((id, data) => tui.handleSessionOutput(id, data));
    app.setSessionsChangedListener(() => tui.refresh());
    tui.start();
    log("press q to hide this screen and keep the daemon running");
  } else if (options.tui) {
    log("(interactive session screen needs a real terminal - showing plain logs)");
  }
  const shutdown = () => {
    tui?.stop();
    log("shutting down, closing sessions...");
    app.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function makeLogger(): Logger {
  return (message: string) => console.log(`[rcmdsh] ${message}`);
}

// Prints a QR that pairs a phone: the URL carries a fresh single-use pairing
// code, and the PWA claims it automatically when opened. Returns the code so
// the caller can poll for the claim in the background, or null when the relay
// could not be reached (a plain app-URL QR is printed as a fallback).
async function printPairQr(
  config: ReturnType<typeof loadConfig>,
  relayBase: string,
  phoneBase: string,
  log: Logger,
): Promise<string | null> {
  const qrcode = (await import("qrcode-terminal")).default;
  try {
    const fresh = await requestPairing({ config, relayBase, phoneBase });
    log("");
    log("Scan to connect your phone (pairing happens automatically):");
    log(`  ${fresh.pairUrl}`);
    log(`  Pairing code: ${fresh.code}`);
    log("");
    qrcode.generate(fresh.pairUrl, { small: true });
    return fresh.code;
  } catch (err) {
    log(`could not create a pairing code: ${err instanceof Error ? err.message : String(err)}`);
    log(`open ${phoneBase} on your phone to pair manually:`);
    qrcode.generate(phoneBase, { small: true });
    return null;
  }
}

program
  .command("connect")
  .description("connect through a hosted relay (works from anywhere, not just your WiFi)")
  .option("--relay <url>", `hosted relay URL (default: ${DEFAULT_HOSTED_RELAY})`)
  .option("--name <name>", "name for this computer")
  .option("--tui", "show the interactive session screen (default: plain logs that keep the QR code visible)")
  .action(async (options: { relay?: string; name?: string; tui?: boolean }) => {
    const log = makeLogger();
    const config = loadConfig();
    if (options.name) {
      config.name = options.name;
      saveConfig(config);
    }
    const base = normalizeRelayBase(options.relay ?? DEFAULT_HOSTED_RELAY);
    log(`using hosted relay ${base}`);

    if (isPairedFor(config, base)) {
      log(`already paired with: ${config.pairedDevices.map((d) => d.name).join(", ") || "a device"}`);
    } else {
      try {
        await pairWithRelay({ config, relayBase: base, phoneBase: base, log });
      } catch (err) {
        log(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    }
    const pairingCode = await printPairQr(config, base, base, log);
    if (pairingCode) {
      void awaitPairingClaim({ config, relayBase: base, code: pairingCode, log })
        .then((name) => log(`paired "${name}" - it can now control this computer`))
        .catch(() => {
          // code expired or nobody scanned it; restarting shows a fresh one
        });
    }
    log("connection started - sessions run in the background on this computer");
    log("press Ctrl+C here to stop");
    startDaemonLoop(config, log, { tui: options.tui });
  });

program
  .command("serve")
  .description("run the relay server only (same as rcmdsh-relay / the docker image)")
  .option("-p, --port <number>", "port to listen on", String(DEFAULT_PORT))
  .option("--host <address>", "address to bind", "0.0.0.0")
  .option("--db <path>", "sqlite database path", path.join(process.cwd(), "rcmdsh-relay.db"))
  .option("--web <dir>", "directory with the built web app to serve")
  .action(async (options: { port: string; host: string; db: string; web?: string }) => {
    const bundledWeb = path.join(__dirname, "..", "public");
    const webDist = options.web
      ? fs.existsSync(options.web)
        ? options.web
        : null
      : fs.existsSync(bundledWeb)
        ? bundledWeb
        : null;
    const handle = await startRelay({
      port: Number.parseInt(options.port, 10),
      host: options.host,
      dbPath: options.db,
      webDist,
      log: (message) => console.log(`[rcmdsh-relay] ${new Date().toISOString()} ${message}`),
    });
    const shutdown = async () => {
      await handle.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

program
  .command("pair")
  .description("pair a phone without starting the daemon (advanced)")
  .option("--relay <url>", "relay URL to register with")
  .option("--name <name>", "name for this computer")
  .action(async (options: { relay?: string; name?: string }) => {
    const log = makeLogger();
    const config = loadConfig();
    if (options.name) {
      config.name = options.name;
    }
    const base = options.relay ? normalizeRelayBase(options.relay) : config.relayUrl;
    if (!base) {
      log("no relay URL - pass --relay <url> (use the LAN IP, e.g. http://192.168.1.20:8787)");
      process.exit(1);
    }
    try {
      await pairWithRelay({ config, relayBase: httpBase(base), phoneBase: httpBase(base), log });
    } catch (err) {
      log(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    log("now run: rcmdsh start");
  });

program
  .command("start")
  .description("start the daemon against the configured relay (advanced)")
  .option("--relay <url>", "relay URL (overrides config)")
  .option("--insecure-dev-token <token>", "use a shared dev token instead of pairing (development only)")
  .option("--tui", "show the interactive session screen (default: plain logs)")
  .action(async (options: { relay?: string; insecureDevToken?: string; tui?: boolean }) => {
    const log = makeLogger();
    const config = loadConfig();
    if (options.relay) {
      config.relayUrl = normalizeRelayBase(options.relay);
      saveConfig(config);
    }
    if (!config.relayUrl) {
      log("no relay configured - run `rcmdsh` (no arguments) for the guided setup");
      process.exit(1);
    }
    const insecure = Boolean(options.insecureDevToken);
    const token = options.insecureDevToken ?? config.daemonToken;
    if (!token) {
      log("not paired yet - run `rcmdsh` (no arguments) for the guided setup");
      process.exit(1);
    }
    log(`device "${config.name}" (${config.deviceId})`);
    log(`relay: ${config.relayUrl}${insecure ? " (INSECURE dev mode)" : ""}`);
    startDaemonLoop({ ...config, daemonToken: token }, log, { insecure, tui: options.tui });
  });

program
  .command("shells")
  .description("list shells available on this platform and which are allowed remotely")
  .action(() => {
    const config = loadConfig();
    const allowed = new Set(config.allowedShells);
    for (const shell of SHELL_CATALOG) {
      const supported = shell.platforms.includes(process.platform);
      const mark = supported ? (allowed.has(shell.id) ? "[allowed]" : "[   ]") : "[n/a ]";
      console.log(`${mark} ${shell.id.padEnd(12)} ${shell.name}`);
    }
    console.log("");
    console.log(
      `Active shells for this platform: ${allowedShellsForPlatform(config.allowedShells).map((s) => s.id).join(", ") || "none"}`,
    );
    console.log(`Config: ${getConfigDir()}`);
  });

program
  .command("attach")
  .description("share the shell in this terminal window with your phone (run it in any visible prompt)")
  .option("--shell <id>", "shell to spawn (default: first allowed shell)")
  .option("--daemon <url>", `attach gateway url (default: ws://127.0.0.1:<attachPort>/bridge)`)
  .option("--token <token>", "attach token (default: RCMDSH_ATTACH_TOKEN env or the config value)")
  .action(async (options: { shell?: string; daemon?: string; token?: string }) => {
    const log = makeLogger();
    const config = loadConfig();
    const port = Number.parseInt(process.env.RCMDSH_ATTACH_PORT ?? String(config.attachPort), 10);
    const token = options.token ?? process.env.RCMDSH_ATTACH_TOKEN ?? config.attachToken;
    const gatewayUrl = options.daemon ?? `ws://127.0.0.1:${port}/bridge`;
    await runAttach({ gatewayUrl, token, shellId: options.shell ?? null, log });
  });

program
  .command("open")
  .description("open the control app in a browser on this computer")
  .action(() => {
    const config = loadConfig();
    const url = config.relayUrl || `http://127.0.0.1:${DEFAULT_PORT}`;
    const opener =
      process.platform === "win32"
        ? { file: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", "start", "", url] }
        : process.platform === "darwin"
          ? { file: "open", args: [url] }
          : { file: "xdg-open", args: [url] };
    try {
      const child = spawn(opener.file, opener.args, { detached: true, stdio: "ignore" });
      child.unref();
      console.log(`opening ${url}`);
    } catch (err) {
      console.error(`could not open a browser: ${err instanceof Error ? err.message : String(err)}`);
      console.log(`open ${url} manually`);
    }
  });

program
  .command("status")
  .description("show daemon configuration summary")
  .action(() => {
    const config = loadConfig();
    console.log(`Device:   ${config.name} (${config.deviceId})`);
    console.log(`Relay:    ${config.relayUrl || "(not set)"}`);
    console.log(`Paired:   ${config.daemonToken ? "yes" : "no"}`);
    console.log(`Shells:   ${config.allowedShells.join(", ") || "(none)"}`);
    console.log(
      `Devices:  ${config.pairedDevices.map((d) => `${d.name} (${d.clientId.slice(0, 8)})`).join(", ") || "(none)"}`,
    );
  });

program
  .command("devices")
  .description("list or revoke paired phones")
  .option("--revoke <clientId>", "revoke a paired device by client id")
  .action((options: { revoke?: string }) => {
    const config = loadConfig();
    if (options.revoke) {
      const before = config.pairedDevices.length;
      config.pairedDevices = config.pairedDevices.filter((d) => d.clientId !== options.revoke);
      if (config.pairedDevices.length === before) {
        console.error(`No paired device with id ${options.revoke}`);
        process.exit(1);
      }
      saveConfig(config);
      console.log(`Revoked device ${options.revoke}. Restart the relay to drop its live session.`);
      return;
    }
    if (config.pairedDevices.length === 0) {
      console.log("No phones paired yet. Run `rcmdsh` (no arguments) to pair one.");
      return;
    }
    for (const device of config.pairedDevices) {
      console.log(`${device.clientId}  ${device.name}  paired ${device.pairedAt}`);
    }
  });

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
