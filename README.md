# rcmdsh

Control any command prompt on your computer from your phone. One command on your computer, one QR scan on your phone — that's the whole setup.

```
Phone (PWA) --wss-->  Relay Server  <--wss--  Your Computer
```

Both sides dial **out** to the relay, so there's no port forwarding, no VPN, no SSH keys. Phone ↔ computer traffic is **end-to-end encrypted** — the relay only forwards ciphertext.

## Quick start (30 seconds)

On your computer (Windows / macOS / Linux):

```bash
npx rcmdsh
```

That single command:

1. starts a small relay server on your machine,
2. prints a **QR code** (using your LAN IP),
3. waits for your phone.

Scan the QR with your phone (same WiFi) → tap **Pair** → pick a shell (PowerShell, cmd, bash, zsh) → you're in a live terminal.

Run it again any time — it reuses the relay and remembers your phone.

## Use it from anywhere (not just your WiFi)

```bash
npx rcmdsh connect
```

This connects your computer through a **hosted relay** instead of the built-in one. Scan the QR, and your phone can reach your computer from cellular, the office, anywhere.

To use your own hosted relay:

```bash
npx rcmdsh connect --relay https://my-relay.example.com
```

> Hosting your own public relay? Deploy the server (below), then change `DEFAULT_HOSTED_RELAY` in `packages/daemon/src/index.ts` before publishing your fork, or just pass `--relay` each time.

## Self-hosting the relay server

The relay is a tiny bridge that pairs devices and routes encrypted frames. Run it two ways:

**Docker (recommended)**

```bash
docker run -d -p 8787:8787 -v rcmdsh-data:/data ghcr.io/YOURNAME/rcmdsh-relay
```

or from a clone of this repo:

```bash
docker compose up -d
```

**npx**

```bash
npx rcmdsh-relay --port 8787
```

Put it behind TLS (Caddy/nginx/Cloudflare) for anything public-facing. Phones and computers then use `https://your-domain:8787` as the relay URL.

## Commands

| Command | What it does |
|---|---|
| `rcmdsh` | guided setup: relay + daemon + QR (LAN mode) |
| `rcmdsh --port 8788` | same, different port |
| `rcmdsh --lan 192.168.1.20` | force a specific LAN IP in the QR |
| `rcmdsh --no-tui` | run without the interactive session screen |
| `rcmdsh connect [--relay url]` | pair + run through a hosted relay |
| `rcmdsh serve` | run the relay server only |
| `rcmdsh pair` | pair only, don't start the daemon (advanced) |
| `rcmdsh start` | daemon only, against the configured relay (advanced) |
| `rcmdsh attach [--shell <id>]` | share the shell in this terminal window with your phone |
| `rcmdsh open` | open the control app in a browser on this computer |
| `rcmdsh devices [--revoke <id>]` | list / revoke paired phones |
| `rcmdsh status` / `shells` | inspect config / shell allowlist |

## Seeing and controlling sessions on your computer

Sessions are not invisible background processes anymore — three ways to work with them locally:

- **Visible windows (default).** Opening a session from the phone spawns a real terminal window on your computer. You see everything, can type in it, and the phone drives the same session. Turn off the "open a window on the computer" toggle in the app for a hidden background session.
- **Attach to an existing prompt.** Run `rcmdsh attach` in any cmd/PowerShell/bash window — it instantly appears in the phone's session list, stays fully visible locally, and both the local keyboard and the phone can drive it. Note: `attach` shares a *new* shell inside that window — start your CLIs (python, npm, ...) inside it and they are shared too; a process that is already running in the window cannot be adopted retroactively (a Windows limitation).
- **Interactive session screen.** While the daemon runs, its own console shows a live session list: `↑/↓` select, `a`/`Enter` attach locally (`Ctrl+B` then `d` to detach), `n` new session, `x` kill, `q` hide the screen (daemon keeps running). Disable with `--no-tui`.
- **Browser.** The same web app your phone uses works on the computer: `rcmdsh open` (or `http://localhost:8787` in LAN mode) shows the full session list and terminals.

## Security model

- Pairing is a **single-use code, valid 5 minutes**. The QR just carries that code.
- Tokens are stored **hashed (SHA-256)**; the relay never sees plaintext tokens after issue.
- App traffic is **end-to-end encrypted** (X25519 key agreement + XSalsa20-Poly1305 via NaCl). Keys are exchanged during pairing; the relay only forwards opaque ciphertext.
- The daemon **allowlists** which shells may be opened remotely (defaults: PowerShell + cmd on Windows, bash/zsh on unix). Edit `allowedShells` in `~/.rcmdsh/config.json`.
- `rcmdsh attach` windows connect to a local gateway bound to **127.0.0.1 only**, authenticated with a token stored in the (0600) config file — paired phones never talk to it.
- Revoke a phone: `rcmdsh devices --revoke <clientId>`.

## How it works

```
┌───────────────┐        wss        ┌──────────────┐        wss        ┌────────────────┐
│  Phone (PWA)  │ <---------------- │  Relay       │ <---------------- │  Your Computer │
│  xterm.js     │   device token    │  auth+routing│   daemon token    │  node-pty      │
└───────────────┘                   └──────────────┘                   └────────────────┘
        └────────────── end-to-end encrypted (relay sees ciphertext) ──────────────┘
```

- **Daemon** owns real PTYs (`node-pty`: ConPTY on Windows, forkpty on unix). Sessions survive phone disconnects; scrollback (last 128 KB) replays on reconnect.
- **Relay** authenticates both sides and routes frames. Serves the PWA.
- **PWA** is installable (Add to Home Screen), with a mobile toolbar (Esc/Tab/Ctrl/arrows/^C/^D), auto-fit resize, and reconnect with scrollback replay.

## Development

```bash
git clone <this repo> && cd rcmdsh
npm install --include=dev     # NODE_ENV=production machines: --include=dev is required
npm run build                 # builds shared → daemon → relay → web, bundles web into both CLIs
npm test                      # unit tests
npm run typecheck

# try the one-command flow locally:
set RCMDSH_HOME=.dev-home && node packages/daemon/dist/index.js

# scripted end-to-end test (relay + daemon + WebSocket client):
node scripts/run-e2e.mjs
```

Repo layout:

```
packages/
  shared/   rcmdsh-core   — protocol (zod), NaCl crypto, framing
  daemon/   rcmdsh         — CLI, node-pty sessions, pairing, embedded relay
  relay/    rcmdsh-relay   — Fastify + WebSocket bridge, SQLite registry, PWA hosting
  web/      PWA            — React + xterm.js + vite-plugin-pwa
```

## Deploy notes

- **systemd**: `ExecStart=/usr/bin/rcmdsh connect --relay https://your-relay`, `Restart=always`
- **Windows**: `schtasks /create /tn rcmdsh /tr "rcmdsh connect --relay https://your-relay" /sc ONLOGON`
- **Docker publish**: push a tag `v*` — `.github/workflows/docker.yml` builds multi-arch and publishes to GHCR.

## Supported platforms

| Component | Windows | macOS | Linux |
|---|---|---|---|
| Daemon | PowerShell, cmd | bash, zsh, sh | bash, zsh, sh |
| node-pty | ConPTY (Win 10 1809+) | forkpty | forkpty |
| PWA | any modern browser | any modern browser | any modern browser |

## License

MIT
