## Who this is for

A Linux desktop, a home server, or a cloud server (VPS). BitBull runs as three Docker containers,
using ready-made images, so nothing is compiled on the machine.

## Before you start

- **Docker Engine** with the **Compose** plugin. Check with `docker compose version`; if it's
  missing, follow Docker's guide for your distribution:
  [docs.docker.com/engine/install](https://docs.docker.com/engine/install/)
- **Git**: `sudo apt install git` on Ubuntu and Debian
- Your three keys ([see Getting started](/guide/getting-started#before-you-start-three-keys))

Or paste this into an AI agent running on the machine:

```text
Set up BitBull for me. Fetch https://www.bitbull.tech/get-started.md and follow it.
```

## Install

Run these on the machine itself (or in an SSH session to it). The first two lines download BitBull
into a new `BitBull` folder wherever you are and move into it; run everything after that from that
folder. If the folder already exists, run `cd BitBull && git pull` instead.

```bash
git clone https://github.com/bitbull-tech/BitBull.git
cd BitBull
cp .env.example .env
nano .env                 # fill in SAYGM_API_KEY, DITTO_API_KEY and APP_TOKEN
docker compose up -d
```

Make the `APP_TOKEN` with `openssl rand -hex 32`. Check it's running:

```bash
curl -s http://localhost:8787/api/health      # → {"ok":true,...}
```

Then open **http://localhost:8787** on that machine and sign in with your `APP_TOKEN`.

## Reaching a server from your own computer

BitBull only answers on the server itself (`127.0.0.1:8787`) and is never opened to the internet
by default. The agent can run commands, so keep it that way and pick one of these:

**Easiest: an SSH tunnel.** On your own computer:

```bash
ssh -L 8787:localhost:8787 you@your-server
```

then open http://localhost:8787 in your browser while the tunnel is open.

**Always on: HTTPS in front of it.** Put a reverse proxy on the server that adds HTTPS and points
at `127.0.0.1:8787`, for example [Caddy](https://caddyserver.com) with a two-line `Caddyfile`:

```text
bitbull.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

or a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/),
which needs no open ports at all. Use a long `APP_TOKEN`: it's the only thing between the internet
and your agent.

## Everyday commands

| To | Run |
|---|---|
| Update to the latest version | `git pull && docker compose pull && docker compose up -d` |
| Pin a version | set `BITBULL_TAG=1.2.3` in `.env`, then `docker compose up -d` |
| Follow the logs | `docker compose logs -f bitbull-agent` |
| See every outbound request | `docker compose logs -f egress` |
| Stop BitBull | `docker compose down` |

Everything BitBull stores is in `./data` (or `BITBULL_DATA_DIR`); back that folder up.

Optional limits in `.env`: `BITBULL_CPUS` (default 4), `BITBULL_MEMORY` (default `6g`),
`BITBULL_PORT` (default 8787).
