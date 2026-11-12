## Who this is for

People changing BitBull's own code. To **use** BitBull, install it for your
[Windows PC](/guide/windows), [Mac](/guide/mac) or [Linux machine](/guide/server) instead: those
run it sandboxed.

## Run the code directly (fastest to edit)

Needs **Node 22.13 or later** (BitBull uses Node's built-in SQLite, so nothing is compiled).

```bash
git clone https://github.com/bitbull-tech/BitBull.git
cd BitBull
cp .env.example .env      # fill in APP_TOKEN, SAYGM_API_KEY, DITTO_API_KEY
npm run setup             # installs server + web dependencies
npm run dev               # API on :8787, UI with hot reload on http://localhost:5173
```

**Outside the sandbox the agent's shell is switched off**, so chats work but the agent can't run
commands. That's deliberate. (`ALLOW_HOST_SHELL=true` turns it back on, on your own machine, with
no walls around it. Don't.)

A production build without Docker: `npm run build && npm start` (UI and API together on :8787).

## Build and run your changes in the sandbox

Builds the images from your checkout instead of pulling the published ones:

```bash
COMPOSE_FILE=docker-compose.yml:docker-compose.dev.yml docker compose up -d --build
```

On Windows, `scripts\bitbull-wsl\deploy.ps1` does the same inside BitBull's WSL distro, and
`test-stack.ps1` runs a second, separate copy on port 8788 so your live BitBull isn't touched.

## Where to start reading

- [`CLAUDE.md`](https://github.com/bitbull-tech/BitBull/blob/main/CLAUDE.md) and
  [`docs/HANDOFF.md`](https://github.com/bitbull-tech/BitBull/blob/main/docs/HANDOFF.md): how the
  code is laid out and how to work on it
- [`docs/ARCHITECTURE.md`](https://github.com/bitbull-tech/BitBull/blob/main/docs/ARCHITECTURE.md):
  the design, and the two agent engines
- [API and internals](/guide/api): every endpoint, and how to add an engine
