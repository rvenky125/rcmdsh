import os from "node:os";

export function lanIpCandidates(): string[] {
  const candidates: string[] = [];
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const net of nets ?? []) {
      if (net.family === "IPv4" && !net.internal) {
        candidates.push(net.address);
      }
    }
  }
  return candidates.sort((a, b) => privateScore(a) - privateScore(b));
}

export function detectLanIp(): string | null {
  return lanIpCandidates()[0] ?? null;
}

function privateScore(ip: string): number {
  if (ip.startsWith("192.168.")) return 0;
  if (ip.startsWith("10.")) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
  return 3;
}
