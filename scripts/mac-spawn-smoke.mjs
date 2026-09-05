#!/usr/bin/env node
// macOS-only smoke test for the node-pty spawn path (the one behind
// "spawn failed: posix_spawnp failed"). Runs on a macOS GitHub runner:
//  1. verifies node-pty's spawn-helper exists and is executable,
//  2. spawns the default mac shell through node-pty and echoes a marker,
//  3. exercises the daemon CLI (`shells`) against a temp home.
// Exits non-zero with a diagnostic on the first failure.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);

if (process.platform !== "darwin") {
  console.error(`mac-spawn-smoke: refusing to run on ${process.platform} (macOS only)`);
  process.exit(2);
}

let failures = 0;
async function check(label, fn) {
  try {
    const detail = await fn();
    console.log(`PASS  ${label}${detail ? ` (${detail})` : ""}`);
  } catch (err) {
    failures++;
    console.error(`FAIL  ${label}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function nodePtyDir() {
  return path.join(ROOT, "node_modules", "node-pty");
}

function helperCandidates() {
  return [
    path.join(nodePtyDir(), "build", "Release", "spawn-helper"),
    path.join(nodePtyDir(), "build", "Debug", "spawn-helper"),
    path.join(nodePtyDir(), "prebuilds", `darwin-${process.arch}`, "spawn-helper"),
  ];
}

function findHelper() {
  const candidates = helperCandidates();
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error(`missing; looked in:\n  ${candidates.join("\n  ")}`);
  try {
    fs.accessSync(found, fs.constants.X_OK);
  } catch {
    throw new Error(`present but not executable: ${found} (run: chmod +x "${found}")`);
  }
  return found;
}

await check("node runs on darwin", () => `${process.platform}-${process.arch} node ${process.version}`);

await check("spawn-helper exists and is executable", () => findHelper());

await check("spawn-helper executes", () => {
  const probe = spawnSync(findHelper(), [], { timeout: 5000 });
  if (probe.error) throw probe.error;
  return `exit ${probe.status}`;
});

await check("node-pty spawns zsh and echoes", async () => {
  const nodePty = require("node-pty");
  const marker = `mac_smoke_${Date.now()}`;
  const pty = nodePty.spawn("zsh", ["-l"], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: os.homedir(),
    env: process.env,
  });
  let output = "";
  pty.onData((d) => {
    output += d;
  });
  pty.write(`echo ${marker}\r\n`);
  const ok = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 20000);
    const tick = () => {
      if (output.includes(marker)) {
        clearTimeout(timer);
        resolve(true);
      } else {
        setTimeout(tick, 100);
      }
    };
    tick();
  });
  try {
    pty.kill();
  } catch {
    // already gone
  }
  if (!ok) throw new Error(`no echo of marker; got: ${JSON.stringify(output.slice(0, 200))}`);
  return marker;
});

await check("rcmdsh shells lists mac shells", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rcmdsh-mac-smoke-"));
  const out = execFileSync(
    "node",
    [path.join(ROOT, "packages", "daemon", "dist", "index.js"), "shells"],
    { env: { ...process.env, RCMDSH_HOME: home }, encoding: "utf8", timeout: 30000 },
  );
  if (!out.includes("zsh")) throw new Error(`zsh not listed:\n${out}`);
  return "zsh + bash allowed";
});

if (failures > 0) {
  console.error(`\nmac-spawn-smoke: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nmac-spawn-smoke: all checks passed");
