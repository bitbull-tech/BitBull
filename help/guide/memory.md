## Ditto: identity, threads, review
**Identity.** Give BitBull its own Ditto agent account instead of your personal key: once, on
your PC, `npx -y --package @heyditto/cli heyditto init --name BitBull --json`, open the
`claimURL` it prints and claim the account as yourself, then put the key it stored
(`~/.config/heyditto/cli/config.json`, or `%APPDATA%\heyditto\cli` on Windows) into `.env` as
`DITTO_API_KEY` (or into the vault via Settings). From then on everything BitBull saves shows in
your graph as the **BitBull** agent thread, labelled as such, and the key in BitBull's config is
BitBull's: revoke it without touching your own. The name is fixed at `init`, so pick it then.

**Threads.** Each BitBull chat is archived into its own Ditto session thread, titled like the chat
(`<project> · <chat title>`), via the `X-Ditto-Session-Id` / `-Name` headers, instead of Ditto's
time-based grouping. The agent's own `save_memory` calls still go through the engine's MCP
connection and are grouped by Ditto; the archive is the per-chat record.

**Main Agent.** The agent is told to ask your Ditto Main Agent (`send_message_to_agent`) for
questions that need judgement across your whole memory rather than one fact.

**Ditto Review.** The `ditto_review` tool on BitBull's own MCP runs Ditto's CLI *on the server*
(with the Ditto key, which the agent's shell never sees) against a clone in the workspace:
working, staged or since-base changes, quick/standard/deep profile, findings back as JSON.
The repo's GitHub origin has to be enabled for Ditto Review in your Ditto workspace and the key
needs review access; until then the tool returns the service's refusal. `verify-changes` and
`git-workflow` ask for it before a commit or PR. The CLI is in the image (`@heyditto/cli`).

**Provider keys.** Settings → Integrations → Ditto → Provider keys saves a GM, Engy, Instant,
OpenRouter, OpenAI, Anthropic or Google key to your Ditto account through the same CLI
(`heyditto keys set`); BitBull keeps none of them, and your Ditto endpoints bill to them before
Ditto credits. See docs/ROUTER.md.

## Ditto sync per project
Right-click a project → **Enable Ditto sync** (also a checkbox in Project settings). A ◆ next to
the project shows it is on. Enabling it starts a seed run in its own chat ("Ditto sync ·
<project>"): the agent reads the project's imported Claude material (`uploads/claude-import/`:
docs and memory files, keeping "you said" apart from "Claude found") and the workspace docs, and
saves every durable fact, decision and preference to Ditto, merging with what is already there.
From then on, every chat in that project is told that Ditto is the project's record: search it
before answering about the project, and save durable facts at the end of a turn. **Sync to Ditto
now** re-runs the seed (safe: it merges). This is the right way to bring imported projects into
memory, since a chat can only read its own project's workspace.

## Ditto Router and Ditto Review
Ditto Router is a second model gateway **next to SayGM, not instead of it**. Settings →
Integrations → Ditto → **Connect Ditto**: one sign-in creates two Ditto Router endpoints (chats
with memory and your connected apps; a review one with neither, for plan mode and QA Hound) and
saves their keys. The endpoint's models join every model picker next to SayGM's, tagged *Ditto
Router*, and run natively on both engines. Your default model and where background work runs stay
as you set them: choose a Ditto Router model per chat, or make one the default in Configuration.
Its tools are attached as MCP servers inside BitBull's fences (**Ditto tools for the agent**, on
after Connect, off for a key pasted by hand), and **Manage connections** opens Ditto's Connections. Ask Ditto Review to review any branch's pull
request from Repositories. See [docs/ROUTER.md](https://github.com/bitbull-tech/BitBull/blob/main/docs/ROUTER.md).
