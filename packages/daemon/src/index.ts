#!/usr/bin/env node
import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { startRelay } from "@rcmdsh/relay/dist/server";
import { loadConfig, saveConfig, getConfigDir } from "./config";
import { SHELL_CATALOG, allowedShellsForPlatform } from "./pty/shells";
import { DaemonApp } from "./app";
import { pairWithRelay, isPairedFor, normalizeRelayBase, httpBase } from "./pair";
import { detectLanIp, lanIpCandidates } from "./net";

const VERSION = "0.1.1";
const DEFAULT_HOSTED_RELAY = "https://relay.rcmdsh.app";
const DEFAULT_PORT = 8787;

type Logger = (message: string) => void;

const program = new Command();

program
  .name("rcmdsh")
  .description("Control your computer's shell from your phone. One command, one QR code.")
  .version(VERSION)
  .option("--relay <url>", "connect through a hosted relay instead of the built-in one")
  .option("--port <number>", "port for the built-in relay (LAN mode)", String(DEFAULT_PORT))
  .option("--name <name>", "name for this computer")
  .option("--lan <ip>", "override the LAN IP shown in the QR code")
  .action(async (options: { relay?: string; port: string; name?: string; lan?: string }) => {
    await runDefault(options);
  });

async function runDefault(options: { relay?: string; port: string; name?: string; lan?: string }): Promise<void> {
  const log = makeLogger();
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

  await printQr(phoneBase, log, "Already paired? Scan to reopen the app (or open the URL):");

  log(`ready - open ${phoneBase} on your phone (press Ctrl+C here to stop)`);
  startDaemonLoop(config, log);
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

function startDaemonLoop(config: ReturnType<typeof loadConfig>, log: Logger): void {
  const token = config.daemonToken;
  if (!token) {
    log("not paired yet - pairing did not complete");
    process.exit(1);
  }
  log(`device "${config.name}" (${config.deviceId})`);
  const app = new DaemonApp({ config, token, insecure: false, log });
  app.start();
  log("daemon running. sessions stay alive while this window is open.");
  const shutdown = () => {
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

async function printQr(url: string, log: Logger, title: string): Promise<void> {
  log("");
  log(title);
  log(`  ${url}`);
  const qrcode = (await import("qrcode-terminal")).default;
  qrcode.generate(url, { small: true });
  log("");
}

program
  .command("connect")
  .description("connect through a hosted relay (works from anywhere, not just your WiFi)")
  .option("--relay <url>", `hosted relay URL (default: ${DEFAULT_HOSTED_RELAY})`)
  .option("--name <name>", "name for this computer")
  .action(async (options: { relay?: string; name?: string }) => {
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
    await printQr(base, log, "Open the app on your phone (scan or open the URL):");
    log(`ready - open ${base} on your phone (press Ctrl+C here to stop)`);
    startDaemonLoop(config, log);
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
  .action(async (options: { relay?: string; insecureDevToken?: string }) => {
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
    startDaemonLoop({ ...config, daemonToken: token }, log);
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
