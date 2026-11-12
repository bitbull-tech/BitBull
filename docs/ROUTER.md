# Ditto: Connect, Router and Review

## Connect Ditto

Settings → Integrations → Ditto → **Connect Ditto**. Approve in Ditto (the page shows a code; check
it matches), and BitBull sets itself up on your Ditto account (server/src/dittoConnect.ts):

| Endpoint | For | Memory | Tools |
| --- | --- | --- | --- |
| `bitbull` | chats | recall and record | every tool you have connected (`tools: ["*"]`) |
| `bitbull-review` | plan mode and QA Hound | off | none |

It creates each endpoint (or reuses one with that slug; the review endpoint's memory and tools are
switched off again every time), mints a key for each, and saves the keys like keys typed into
Settings: the vault when it is unlocked, else `settings.local.json`. Connecting again revokes the
endpoint keys an earlier Connect from this BitBull made, once the new ones are saved.

| Setting | Set to |
| --- | --- |
| `DITTO_API_KEY` | your account key from the sign-in (lasts three months; connect again to renew) |
| `DITTO_ROUTER_KEY` | the `bitbull` endpoint's key |
| `DITTO_ROUTER_REVIEW_KEY` | the `bitbull-review` endpoint's key |
| `DEFAULT_MODEL` | `ditto-router/bitbull`: the endpoint's own model (change it on developer.heyditto.ai) |
| `BACKGROUND_VIA`, `DITTO_ROUTER_MODEL` | `ditto-router`, `bitbull`: titles and compaction follow the endpoint's background routes |

SayGM stays: its models are in every picker next to Ditto's, and `DEFAULT_MODEL` can go back to one.

**Manage connections** opens Ditto's Connections (app.heyditto.ai/connections/apps). GitHub, Gmail,
Linear or an MCP server connected there becomes the agent's tools in BitBull within ten minutes
(the catalog is cached), or at once after any settings change.

Without Connect, set the same keys by hand: endpoint keys from developer.heyditto.ai → Endpoints →
your endpoint → **Create a key** (`ditto_inf_…`). These are runtime settings read by the server
(`.env` or Settings), not GitHub Actions secrets or build-time variables: the published image
carries no keys. `DITTO_ROUTER_BASE_URL` (default `https://router.heyditto.ai/v1`) is `.env`-only.

## Provider keys, kept in Ditto

Ditto is the key manager. Settings → Integrations → Ditto → **Provider keys**: pick GM, Engy,
Instant, OpenRouter, OpenAI, Anthropic, Google (or any provider Ditto lists), paste the key and
press **Save**. BitBull runs the Ditto CLI on the server (`heyditto keys set <provider>`, the key
on stdin) and keeps nothing: the key lives in your Ditto account, alongside the ones in the Ditto
app's Settings → Usage → Provider keys, and is never shown back. The provider checks it straight
away and the panel says whether it was accepted. Keys can be turned off, on, or removed there too,
and **Copy BitBull's SayGM key to Ditto** saves the `SAYGM_API_KEY` BitBull already has as your
`gm` key.

A provider can hold several keys: fill in **Name** to save a named one (`heyditto keys set gm
--label=work`), and saving under a name that exists replaces that key. Leave it empty for the
provider's original key. How many keys a provider may hold depends on the Ditto plan (one on
Free); past that, saving says so.

Endpoints Connect creates bill with `billingMode: both`: your own keys first, Ditto credits when
none of them serves the model. An endpoint that already existed keeps the billing you chose.

Saving needs a Connect approved for key access: Connect asks for Ditto's `keys` sign-in, and the
approval page says what it allows. A Connect made before that, or against a Ditto without it,
falls back to a plain login, and saving says so and offers **Reconnect Ditto**.

The CLI (server/src/providerKeys.ts) gets the Ditto account key and the proxy settings, none of
BitBull's other secrets, a fresh config folder per run, and no self-updates. It is the `heyditto`
in the image (Dockerfile); `DITTO_CLI` points at another one for host mode. Provider keys need a
CLI with `heyditto keys`, newer than the image's current pin.

## Models: Ditto Router next to SayGM

Ditto Router (`router.heyditto.ai/v1`) serves Anthropic Messages, OpenAI Responses and
chat.completions under one endpoint key, and translates between them. With a Router key:

- **Every model picker** lists the endpoint's models with a *Ditto Router* tag, as
  `ditto-router/<router id>`: chats (pick one per message), QA Hound reviewers, subagent models and
  `DEFAULT_MODEL`. `ditto-router/bitbull` is the endpoint itself, which routes to its own model.
- **OpenCode** speaks each Router model's native API: Claude models through `@ai-sdk/anthropic`,
  the rest through `@ai-sdk/openai-compatible` (engines/opencode.ts).
- **Claude Agent SDK** runs any Router model the way `heyditto claude` runs Claude Code
  (`ANTHROPIC_BASE_URL` = the Router, `ANTHROPIC_AUTH_TOKEN` = the key, gateway hint headers on).
  Its subagents and background calls stay on the chat model's gateway.
- **One Router thread per chat**: every request carries `X-Ditto-Session-Id` (the chat for the
  Claude engine; the OpenCode session, through agent/opencode-plugin/ditto-router.js, for OpenCode).
- **Prices**: the Router's model list has none, so BitBull reads Ditto's model catalog with the
  account key. Turn costs and QA Hound budgets then cover Router models; without `DITTO_API_KEY`
  they can't, and the endpoint's own spend limit is the only cap.
- **When Ditto is unreachable** BitBull keeps the last model list, tools and prices it had and
  tries again after a minute, so turns don't wait on it.
- **Errors** name the gateway: a Router 401/402/403 points at the key, your Ditto credits and the
  endpoint's spend limit or provider keys, not at SayGM.

## Tools and memory: attached by BitBull, not injected by the Router

The `bitbull` endpoint's tools come from its MCP catalog (`GET /v1/mcp`): Ditto's built-ins
(`search_memories`, `save_memory`, …) as `ditto`, and each connected source as `ditto-<source>`
(`ditto-github`, …). BitBull attaches them to the agent as remote MCP servers (server/src/router.ts);
each call still runs on Ditto (`/v1/mcp/<server>`) with the credentials Ditto holds, behind the
endpoint's approval gate. When the catalog has `ditto`, it replaces the account-key memory server.

Every inference request says `X-Ditto-Tool-Surface: mcp`, so the Router adds no tools of its own.
Tools the Router injected would run on Ditto out of BitBull's sight; attached ones stay inside
BitBull's fences:

- **Plan mode** (and so QA Hound, which reviews possibly hostile code) gets no MCP servers at all,
  and its Router turns use the review endpoint: no memory recalled or recorded, no tools. The chat
  endpoint's own entry (`ditto-router/bitbull`) becomes the review endpoint's there. BitBull checks
  the review endpoint through its own key (its `/v1/models` entry) on every refresh, not only at
  Connect: if it has memory or tools on, or uses the chat key, or there is no review key, a plan
  turn on a Router model is refused rather than run where it could be remembered. Plan turns are
  not archived to Ditto by BitBull either.
- **Background work** (titles, summaries) runs on the review endpoint when it's ready, so it never
  reaches memory, plan chats included.
- **Approvals**: Ditto holds a gated call for you to approve in Ditto (the endpoint default). On an
  endpoint with `clientApprovals`, the client must ask, and BitBull has nobody to ask mid-turn, so
  those tools are refused.

**Memory**: the `bitbull` endpoint recalls memories into each chat turn and records it. BitBull's
own per-turn archive (`DITTO_ARCHIVE`) skips Router turns when the endpoint records them itself,
so nothing is saved twice; SayGM turns are archived as before, plan turns never.

**Known limit**: on the Claude Agent SDK engine the chat endpoint key is in the Claude CLI's
environment, as the SayGM key is today (docs/THREAT-MODEL.md R2), so a determined agent with a
shell could read it. Outside plan mode that reaches the same tools the agent already has, behind
the same Ditto approval gate; plan turns carry the review key, which reaches no tools. Tool output
the Claude engine sends to a recording endpoint is recorded as the model saw it.

## Background work

Settings → Configuration → **Background work** → *Ditto Router*, then a model from the Router's
live list, or the endpoint itself (`bitbull`, what Connect picks: the endpoint's background routes
choose the model). Without a key or a model it falls back to SayGM and the panel says so.

## The model advisor and the Router

When a Router key is set, each of the advisor's three picks says whether Ditto Router serves the
same model and at what price. **Use for background work** puts a pick on background work: as the
Router model when background work runs on the Router, otherwise as SayGM's small model.

## Ditto signup link and referral code

Before Connect, Settings → Integrations → Ditto shows **Create a Ditto account**. Set
`DITTO_REFERRAL_CODE` (`.env` or Settings) to the BitBull app developer's own Ditto referral code
(like `abcd-2345`) and the link becomes Ditto's `https://heyditto.ai/r/<code>`, so signups count
for them. The server builds it at runtime; empty or malformed gives a plain signup link.

## Ditto Review on a branch

Repositories → a clone with a GitHub origin → **Ditto review** next to any branch. BitBull finds the
branch's open pull request and comments `@ditto review` on it with your GitHub token; Ditto's GitHub
app (set up at developer.heyditto.ai → Review) reviews it and replies on the PR. A branch with no
open PR gets a link to open one.
