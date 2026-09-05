#!/usr/bin/env node
// node-pty's macOS spawn-helper arrives through npm install WITHOUT its
// executable bit (lands as -rw-r--r--), which makes EVERY shell spawn fail
// with "posix_spawnp failed". Re-apply the bit at install time.
// This must never fail the install: all errors are swallowed.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

try {
  if (process.platform !== "darwin") process.exit(0);
  const require = createRequire(import.meta.url);
  let base;
  try {
    base = path.dirname(require.resolve("node-pty/package.json"));
  } catch {
    process.exit(0);
  }
  const candidates = [
    path.join(base, "build", "Release", "spawn-helper"),
    path.join(base, "build", "Debug", "spawn-helper"),
    path.join(base, "prebuilds", `darwin-${process.arch}`, "spawn-helper"),
  ];
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      fs.chmodSync(candidate, 0o755);
      fs.accessSync(candidate, fs.constants.X_OK);
      console.log(`[rcmdsh] macOS spawn-helper ready (${candidate})`);
    } catch {
      // try the next candidate; never fail the install
    }
  }
} catch {
  // never fail the install
}
process.exit(0);
