#!/usr/bin/env node
import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { startRelay } from "./server";

const VERSION = "0.1.1";

function bundledWebDist(): string | null {
  const bundled = path.join(__dirname, "..", "public");
  return fs.existsSync(bundled) ? bundled : null;
}

const program = new Command();

program
  .name("rcmdsh-relay")
  .description("rcmdsh relay server - bridges your phone and your computer")
  .version(VERSION)
  .option("-p, --port <number>", "port to listen on", "8787")
  .option("--host <address>", "address to bind", "0.0.0.0")
  .option("--db <path>", "sqlite database path", path.join(process.cwd(), "rcmdsh-relay.db"))
  .option("--web <dir>", "directory with the built web app to serve (defaults to the bundled app)")
  .option("--dev-token <token>", "register a shared dev token for insecure local development")
  .action(
    async (options: { port: string; host: string; db: string; web?: string; devToken?: string }) => {
      const webDist = options.web
        ? fs.existsSync(options.web)
          ? options.web
          : null
        : bundledWebDist();
      const handle = await startRelay({
        port: Number.parseInt(options.port, 10),
        host: options.host,
        dbPath: options.db,
        webDist,
        devToken: options.devToken,
        log: (message) => console.log(`[rcmdsh-relay] ${new Date().toISOString()} ${message}`),
      });
      const shutdown = async () => {
        console.log("[rcmdsh-relay] shutting down");
        await handle.close();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    },
  );

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
