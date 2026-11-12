## What you get

- Chat UI with streaming, tool-call view, browser tools, per-message model switching
- Turns run on the server, not in your tab: close it, sleep the laptop, come back, and the
  chat picks up where it left off
- Light and dark, with colour schemes for the background and sidebar (Settings → Appearance), and
  white-labelled from one `brand.json` — name, logo and every colour
- **QA Hound**: unleash multiple LLMs on a repo, folder or file to review it, challenge each other
  and summarise a verdict and recommendations
- Engine per chat: **OpenCode** (native for every model) or **Claude Agent SDK**
- Ditto MCP wired into the agent + every turn and skill archived to Ditto whenever you need it
- Skills in `/skills`, versioned in Git, shared by both engines
- Sandboxed Docker containers (the agent, an allowlist proxy, a localhost-only gateway) and one
  data folder; reachable by URL with a bearer token
- Import existing conversations, projects and data from your existing coding agents
  ([how](/guide/import-agents))
- `POST /api/v1/chat` for scripts and other agents
- **Which model for this?** (three picks with pros, cons and cost), a model picker with maker
  filters and your own response speeds, and an optional **Ditto Router** for background work
- **Voice**: talk to it and hear it answer, push-to-talk from anywhere, hands-free
- Show it a window or send it a web page with the browser extension, get every file a reply made
  with one click, archive and bulk-tidy chats
- A one-stop shop for **Bittensor** services: Taostats, Atlas, 404 (3D as code), Hippius storage,
  Ditto memory and Ditto Review
- A [system map](/system-map) of how all of it fits together

## Which install is right for you?

BitBull always runs the same way underneath: a few small **containers** (sealed-off mini
computers) on your own machine, with only BitBull's data folder inside them. What changes from
one computer to the next is how those containers get started.

| You have | Go to | Effort |
|---|---|---|
| A Windows 10 or 11 PC | [Install on Windows](/guide/windows) | About 20 minutes, one restart |
| A Mac (macOS 13 or later) | [Install on a Mac](/guide/mac) | About 15 minutes |
| A Linux PC, home server or cloud server | [Linux and servers](/guide/server) | About 10 minutes if Docker is installed |
| You want to change BitBull's own code | [Run from source](/guide/source) | Developers only |

**Not sure? Use the first row that matches your computer.** Every route ends the same way:
BitBull running at **http://localhost:8787** on that machine, sandboxed.

## The easiest way: let your AI agent install it

If you already use an AI coding agent (Claude Code, Codex, Cursor, Gemini CLI or similar), paste
this into it:

```text
Set up BitBull for me. Fetch https://www.bitbull.tech/get-started.md and follow it.
```

It checks your computer, installs what's missing (asking you first), downloads BitBull, sets up
your keys without printing them, starts everything and tells you when it's ready.

## Before you start: three keys

| Key | What it is | Where to get it |
|---|---|---|
| `SAYGM_API_KEY` | One key for every AI model | [saygm.com](https://saygm.com) |
| `DITTO_API_KEY` | BitBull's long-term memory | [heyditto.ai](https://heyditto.ai) |
| `APP_TOKEN` | The password for your BitBull | You make it up: each install page shows a one-line command that creates a strong one |

Everything else (GitHub, Taostats, Hippius storage, Atlas, Ditto Router) is
optional and can be added later in **Settings**. 404 needs no key at all. See [Keys and settings](/guide/keys).

## Why sandboxed?

BitBull's agent runs real commands: it builds code, installs packages and edits files. So it works
inside containers that can't see the rest of your computer, can only reach websites on an approved
list (it asks you before going anywhere new), and only answer to your own machine. Your folders
are only visible to it if you link them, and then read-only. The full picture is in
[How it is locked down](/guide/security).
