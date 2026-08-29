import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface SpawnAttachWindowOptions {
  shellId: string;
  attachToken: string;
  attachPort: number;
  bridgeId?: string;
  title?: string;
  entryScript?: string;
}

interface WindowCommand {
  file: string;
  args: string[];
}

// Builds the command that opens a visible terminal window running
// `rcmdsh attach`. Pure so it can be unit-tested.
export function buildAttachWindowCommand(options: SpawnAttachWindowOptions): WindowCommand | null {
  const entryScript = options.entryScript ?? path.join(__dirname, "..", "index.js");
  if (!fs.existsSync(entryScript)) return null;
  const title = options.title ?? "rcmdsh session";
  const attachArgs = ["attach", "--shell", options.shellId];
  if (options.bridgeId) {
    attachArgs.push("--bridge-id", options.bridgeId);
  }

  switch (process.platform) {
    case "win32": {
      const comspec = process.env.ComSpec ?? "cmd.exe";
      const q = (value: string) => `"${value}"`;
      const inner = [
        "start",
        q(title),
        q(process.execPath),
        q(entryScript),
        ...attachArgs,
      ].join(" ");
      return { file: comspec, args: ["/d", "/s", "/c", inner] };
    }
    case "darwin": {
      // The command line runs under the user's shell, so single-quote paths;
      // JSON escaping matches AppleScript string escaping for our character set.
      const shq = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
      const cmdLine = [
        process.execPath,
        shq(entryScript),
        ...attachArgs,
      ].join(" ");
      return {
        file: "osascript",
        args: [
          "-e",
          `tell application "Terminal" to do script ${JSON.stringify(cmdLine)}`,
        ],
      };
    }
    case "linux": {
      const candidates: Array<{ file: string; prefix: string[] }> = [
        { file: "x-terminal-emulator", prefix: ["-e"] },
        { file: "gnome-terminal", prefix: ["--"] },
        { file: "konsole", prefix: ["-e"] },
        { file: "xfce4-terminal", prefix: ["-x"] },
        { file: "alacritty", prefix: ["-e"] },
        { file: "xterm", prefix: ["-e"] },
      ];
      for (const candidate of candidates) {
        if (isExecutableOnPath(candidate.file)) {
          return {
            file: candidate.file,
            args: [...candidate.prefix, process.execPath, entryScript, ...attachArgs],
          };
        }
      }
      return null;
    }
    default:
      return null;
  }
}

// Best-effort: returns true if a window was spawned. The daemon falls back to
// a headless session when this fails.
export function spawnAttachWindow(options: SpawnAttachWindowOptions): boolean {
  const command = buildAttachWindowCommand(options);
  if (!command) return false;
  try {
    const child = spawn(command.file, command.args, {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        RCMDSH_ATTACH_TOKEN: options.attachToken,
        RCMDSH_ATTACH_PORT: String(options.attachPort),
      },
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function isExecutableOnPath(file: string): boolean {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, file);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      // keep looking
    }
  }
  return false;
}
