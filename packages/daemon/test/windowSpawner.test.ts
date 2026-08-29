import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAttachWindowCommand } from "../src/attach/windowSpawner";

const existingFile = path.join(process.cwd(), "package.json");
const base = {
  shellId: "cmd",
  attachToken: "tok-123",
  attachPort: 8790,
  bridgeId: "bridge-1",
  entryScript: existingFile,
};

describe("buildAttachWindowCommand", () => {
  it("returns null when the daemon entry script does not exist", () => {
    const command = buildAttachWindowCommand({ ...base, entryScript: "Z:/definitely/missing.js" });
    expect(command).toBeNull();
  });

  it("includes the shell and bridge id in the attach arguments", () => {
    const command = buildAttachWindowCommand(base);
    expect(command).not.toBeNull();
    const flat = command!.args.join(" ");
    expect(flat).toContain("attach");
    expect(flat).toContain("--shell");
    expect(flat).toContain("cmd");
    expect(flat).toContain("--bridge-id");
    expect(flat).toContain("bridge-1");
    expect(flat).toContain(existingFile);
  });

  it("omits --bridge-id when not provided", () => {
    const command = buildAttachWindowCommand({ ...base, bridgeId: undefined });
    expect(command).not.toBeNull();
    expect(command!.args.join(" ")).not.toContain("--bridge-id");
  });

  it("quotes the entry script so paths with spaces survive", () => {
    const command = buildAttachWindowCommand(base);
    expect(command).not.toBeNull();
    const flat = command!.args.join(" ");
    expect(flat).toContain(`"${existingFile}"`);
  });

  if (process.platform === "win32") {
    it("uses cmd start on windows", () => {
      const command = buildAttachWindowCommand(base);
      expect(command!.file).toBe(process.env.ComSpec ?? "cmd.exe");
      expect(command!.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
      expect(command!.args[3].startsWith("start")).toBe(true);
    });
  }

  if (process.platform === "darwin") {
    it("uses osascript on macos", () => {
      const command = buildAttachWindowCommand(base);
      expect(command!.file).toBe("osascript");
      expect(command!.args[0]).toBe("-e");
      expect(command!.args[1]).toContain('tell application "Terminal"');
    });
  }
});
