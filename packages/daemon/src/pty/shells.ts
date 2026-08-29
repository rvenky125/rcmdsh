export interface ShellDef {
  id: string;
  name: string;
  command: string;
  args: string[];
  platforms: NodeJS.Platform[];
}

export const SHELL_CATALOG: ShellDef[] = [
  { id: "powershell", name: "PowerShell", command: "powershell.exe", args: ["-NoLogo"], platforms: ["win32"] },
  { id: "cmd", name: "Command Prompt", command: "cmd.exe", args: [], platforms: ["win32"] },
  { id: "pwsh", name: "PowerShell Core", command: "pwsh", args: ["-NoLogo"], platforms: ["win32", "linux", "darwin"] },
  { id: "bash", name: "Bash", command: "bash", args: ["-l"], platforms: ["linux", "darwin"] },
  { id: "zsh", name: "Zsh", command: "zsh", args: ["-l"], platforms: ["darwin", "linux"] },
  { id: "sh", name: "sh", command: "sh", args: [], platforms: ["linux", "darwin"] },
];

export function shellsForPlatform(platform: NodeJS.Platform = process.platform): ShellDef[] {
  return SHELL_CATALOG.filter((shell) => shell.platforms.includes(platform));
}

export function getShellDef(id: string, platform: NodeJS.Platform = process.platform): ShellDef | null {
  return shellsForPlatform(platform).find((shell) => shell.id === id) ?? null;
}

export function allowedShellsForPlatform(allowedIds: string[], platform: NodeJS.Platform = process.platform): ShellDef[] {
  const available = shellsForPlatform(platform);
  return allowedIds
    .map((id) => available.find((shell) => shell.id === id))
    .filter((shell): shell is ShellDef => shell !== null);
}
