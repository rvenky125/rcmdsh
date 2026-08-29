import { cpSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const webDist = path.join(root, "packages", "web", "dist");

for (const pkg of ["daemon", "relay"]) {
  const target = path.join(root, "packages", pkg, "public");
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(webDist, target, { recursive: true });
}

console.log("copied web dist -> packages/daemon/public, packages/relay/public");
