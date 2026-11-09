# Ditto Router and Ditto Review

## Background work on Ditto Router (optional)

Ditto Router (`https://router.heyditto.ai/v1`) is Ditto's OpenAI-compatible inference service.
BitBull can use it for **background work only**: titles, compaction and the other housekeeping the
OpenCode engine does on its small model. Chats, subagents and QA Hound always stay on SayGM.

1. developer.heyditto.ai → Endpoints → your endpoint → **Create a key** (`ditto_inf_…`).
2. BitBull → Settings → Integrations → Ditto → **Router key**.
3. Settings → Configuration → **Background work**: pick *Ditto Router*, then pick a model from the
   list (the Router's live catalogue, cheapest first, prices per million tokens in / out).

What it changes: OpenCode's `small_model` becomes `ditto-router/<model>` (server/src/router.ts,
engines/opencode.ts). The Claude engine is unaffected (its small model must be on the same
gateway as its main model). Without a key or a model the setting falls back to SayGM and the panel
says so. The key lives in the vault like the other keys and is kept out of the agent's environment.

The endpoint's own settings on developer.heyditto.ai still apply: its spend limit, provider routing
(cheap / fast / balanced), model routes and background-request routes.

## The model advisor and the Router

When a Router key is set, each of the advisor's three picks says whether Ditto Router serves the
same model and at what price. **Use for background work** puts a pick on background work: as the
Router model when background work runs on the Router, otherwise as SayGM's small model.

## Ditto Review on a branch

Repositories → a clone with a GitHub origin → **Ditto review** next to any branch. BitBull finds the
branch's open pull request and comments `@ditto review` on it with your GitHub token; Ditto's GitHub
app (set up at developer.heyditto.ai → Review) reviews it and replies on the PR. A branch with no
open PR gets a link to open one.
