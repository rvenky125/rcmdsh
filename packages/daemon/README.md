# rcmdsh

Control your computer's shell from your phone. One command, one QR code.

```bash
npx rcmdsh
```

- Starts a relay on your computer and prints a QR code
- Scan it with your phone (same WiFi) → tap **Pair** → pick a shell → live terminal
- Works with PowerShell, cmd, bash, zsh

**From anywhere** (cellular, office WiFi):

```bash
npx rcmdsh connect
```

End-to-end encrypted — the relay only forwards ciphertext. Sessions survive phone disconnects; scrollback replays on reconnect.

Full docs, self-hosting (npx / Docker), and source: https://github.com/rvenky125/rcmdsh

## Commands

| Command | What it does |
|---|---|
| `rcmdsh` | guided setup: relay + daemon + QR (LAN mode) |
| `rcmdsh connect [--relay url]` | pair + run through a hosted relay |
| `rcmdsh serve` | run the relay server only |
| `rcmdsh devices` | list / revoke paired phones |

MIT License.
