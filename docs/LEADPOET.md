# Leadpoet

[Leadpoet](https://leadpoet.com) is Bittensor subnet 71: B2B lead sourcing and outreach. With it
connected, BitBull can plan and run a lead-generation campaign: define the ideal customer,
request leads and read the evidence for each, watch accounts for buying signals, write email and
LinkedIn sequences, build the campaign and, only if you allowed it, launch it.

BitBull uses Leadpoet's own MCP server (`https://leadpoet.com/mcp`), the one Claude, ChatGPT and
Cursor connect to. The code is `server/src/leadpoet.ts`, the tests `server/src/leadpoet.test.ts`,
and how the agent runs a campaign is the `leadpoet` skill (`skills/leadpoet/SKILL.md`).

## Connect

1. **Settings → Integrations → Leadpoet.** Choose what BitBull may do (below) and press
   **Connect Leadpoet**.
2. Leadpoet opens in your browser. Sign in (or create an account) and approve.
3. The browser comes back to BitBull and says it is connected.
4. Open the project you will run campaigns from → project settings → tick **Leadpoet**. Its tools
   reach chats in that project only.

No key to request or paste. If the browser ends on a page that won't load after you approve, it
couldn't reach BitBull at the address shown in Settings: copy that tab's whole address and paste
it under "The browser ended on a page that wouldn't load?".

Connect from BitBull on the computer it runs on (`http://127.0.0.1:8787`, or the desktop app), or
over `https` if you reach it remotely. Other plain-http addresses are refused.

## What BitBull may do

You choose when connecting, and Leadpoet enforces it on every call. To change it, reconnect.

| Choice | The agent can |
|---|---|
| **Look only** | read credits, lead requests, the pipeline, campaigns and results |
| **Plan and prepare** (default) | also create lead requests (these **spend credits**), update the pipeline, watch accounts, write audiences and campaigns as drafts |
| **+ Allow sending** (off by default) | also send email and LinkedIn messages from your accounts and launch campaigns |

With sending off, BitBull prepares everything and you press send or launch in Leadpoet. That is
the recommended way to start. Turn sending on only when you trust the campaign and are at the
screen: the agent is told to show you the recipients and the message and wait for your yes, but
that is an instruction to a model, and the permission you grant is real.

Whatever you choose:

- **Credits.** A lead request costs 10 credits a company and a watched account 2 a week (Leadpoet's
  prices; see their pricing page). The agent shows the plan and the cost and waits for your yes.
- **Scheduled runs and Telegram.** Nobody is there to approve, so the agent only reads, analyses
  and drafts. A weekly "how is the campaign doing" schedule is a good fit; a schedule that sends
  is not something BitBull will do.
- **A record.** Every Leadpoet tool the agent calls is written to Activity by name.

## How it is wired

- **Sign-in:** OAuth 2.0 authorization code with PKCE, with BitBull registering itself with
  Leadpoet the first time (dynamic client registration). The callback is
  `/oauth/leadpoet/callback` on BitBull; it does nothing without the one-time `state` BitBull made
  when you pressed Connect.
- **The agent never holds the tokens.** The engines are given a local address on BitBull
  (`/mcp/leadpoet`, behind BitBull's internal token). BitBull adds the access token there and
  forwards to Leadpoet, renewing it when it is about to expire. Only MCP headers are passed on.
- **Where tokens are kept:** like a key typed into Settings, in the vault when it is on. They are
  redacted from the agent's output and the Activity log.
- **Where tokens are sent:** only to `LEADPOET_URL` (`.env` only, default `https://leadpoet.com`).
  Every sign-in address Leadpoet advertises must be on that same origin or it is refused.
- **Network:** in the sandbox, `leadpoet.com` is open only while Leadpoet is connected or a
  sign-in is under way; it is not on the static allowlist. While it is open the agent's shell can
  reach it too (without your sign-in). `docs/THREAT-MODEL.md` R11.

## Disconnect

**Disconnect** in Settings forgets the sign-in here. To end it on Leadpoet's side too, use
Leadpoet → Settings → Integrations → AI assistants. Campaigns already running in Leadpoet keep
running until you stop them there.

## Settings

| Key | Where | What |
|---|---|---|
| `LEADPOET_URL` | `.env` only | Leadpoet's address. Default `https://leadpoet.com`. |
| `LEADPOET_OAUTH` | written by Connect | The sign-in (tokens, expiry, scopes). Never type it. |

## API

All under the app token except the callback. None returns a token.

| Method | Path | |
|---|---|---|
| `GET` | `/api/leadpoet` | State: connected, access, sending, a sign-in waiting for approval |
| `POST` | `/api/leadpoet/connect` | Start a sign-in: `{ origin, access: "read" or "edit", send }` → the Leadpoet address to open |
| `POST` | `/api/leadpoet/finish` | Finish with the callback address pasted by hand: `{ url }` |
| `POST` | `/api/leadpoet/disconnect` | Forget the sign-in |
| `GET` | `/oauth/leadpoet/callback` | Where Leadpoet sends the browser back (needs the one-time `state`) |

## Not in this version

Leadpoet's REST API and API keys (access is by request to Leadpoet, and a key would have to be
given to the agent), Leadpoet webhooks into BitBull (they need a public https address), and
mining or validating on subnet 71.
