import fs from "node:fs";
import path from "node:path";

export interface SpawnEnvCheck {
  ok: boolean;
  helperPath: string | null;
  message: string | null;
}

export function spawnHelperCandidates(
  packageDir: string,
  platform: NodeJS.Platform,
  arch: string,
): string[] {
  return [
    path.join(packageDir, "build", "Release", "spawn-helper"),
    path.join(packageDir, "build", "Debug", "spawn-helper"),
    path.join(packageDir, "prebuilds", `${platform}-${arch}`, "spawn-helper"),
  ];
}

export function nodePtyPackageDir(): string | null {
  try {
    return path.dirname(require.resolve("node-pty/package.json"));
  } catch {
    return null;
  }
}

// macOS-only: node-pty launches every session through a small spawn-helper
// binary. If that file is missing (bad install) or lost its executable bit
// (copied node_modules, some sync tools), every spawn fails with the cryptic
// "posix_spawnp failed" - note a missing *shell* does NOT cause this, it
// would just exit immediately. Detect the helper problem at startup,
// self-heal the exec bit when possible, and otherwise explain exactly what
// to do.
export function ensureSpawnHelper(
  options: {
    platform?: NodeJS.Platform;
    arch?: string;
    packageDir?: string | null;
    log?: (message: string) => void;
  } = {},
): SpawnEnvCheck {
  const platform = options.platform ?? process.platform;
  const log = options.log ?? (() => {});
  if (platform !== "darwin") return { ok: true, helperPath: null, message: null };
  const packageDir = options.packageDir ?? nodePtyPackageDir();
  const arch = options.arch ?? process.arch;
  if (!packageDir) {
    return {
      ok: false,
      helperPath: null,
      message: "could not locate the node-pty package - reinstall with: npm install -g rcmdsh",
    };
  }
  const candidates = spawnHelperCandidates(packageDir, platform, arch);
  const helperPath = candidates.find((p) => fs.existsSync(p)) ?? null;
  if (!helperPath) {
    return {
      ok: false,
      helperPath: null,
      message:
        "node-pty's spawn-helper is missing - reinstall node-pty " +
        "(global/npx install: delete ~/.npm/_npx and run again, or run: npm rebuild node-pty)",
    };
  }
  try {
    fs.accessSync(helperPath, fs.constants.X_OK);
    return { ok: true, helperPath, message: null };
  } catch {
    try {
      fs.chmodSync(helperPath, 0o755);
      fs.accessSync(helperPath, fs.constants.X_OK);
      log(`fixed spawn-helper permissions (${helperPath})`);
      return { ok: true, helperPath, message: null };
    } catch {
      return {
        ok: false,
        helperPath,
        message: `node-pty's spawn-helper is not executable - run: chmod +x "${helperPath}"`,
      };
    }
  }
}

// Turns a raw node-pty spawn throw into something actionable. On macOS the
// notorious "posix_spawnp failed" means the helper process itself could not
// start (see ensureSpawnHelper), not that the shell is missing.
export function describeSpawnError(
  err: unknown,
  shellCommand: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const base = err instanceof Error ? err.message : String(err);
  if (platform === "darwin" && /posix_spawnp failed/.test(base)) {
    return (
      `${base} the shell "${shellCommand}" never launched - node-pty's ` +
      `spawn-helper could not start (it ships without the executable bit; ` +
      `reinstall rcmdsh or run: chmod +x <node-pty>/prebuilds/darwin-<arch>/spawn-helper)`
    );
  }
  return `${base} could not launch shell "${shellCommand}" - is it installed and on PATH?`;
}
