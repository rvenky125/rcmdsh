# @rcmdsh/relay

The relay server for [rcmdsh](https://github.com/rvenky125/rcmdsh) — pairs phones with computers and routes end-to-end-encrypted terminal traffic. It never sees shell contents.

## Run it

```bash
# npx
npx rcmdsh-relay --port 8787

# or Docker
docker run -d -p 8787:8787 -v rcmdsh-data:/data ghcr.io/rvenky125/rcmdsh-relay
```

Then point clients at it:

```bash
npx rcmdsh connect --relay https://your-server:8787
```

## Options

| Flag | Default | Description |
|---|---|---|
| `-p, --port` | `8787` | port to listen on |
| `--host` | `0.0.0.0` | bind address |
| `--db` | `./rcmdsh-relay.db` | SQLite database path (pairing registry) |
| `--web` | bundled app | directory with a built PWA to serve |
| `--dev-token` | — | insecure shared token for local development only |

Put it behind TLS (Caddy, nginx, Cloudflare) for anything public-facing.

MIT License.
