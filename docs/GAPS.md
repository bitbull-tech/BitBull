# GM Agent vs leading coding agents: gaps

Compared against Claude Code, OpenAI Codex (CLI + cloud), Cursor (agent + background agents),
Gemini CLI and stock OpenCode, as of October 2026. "Have" means working in this repo today.

## What GM Agent already has

| Capability | GM Agent |
|---|---|
| Any model, switch mid-chat | Yes: every SayGM model, routed to its native API |
| Agent loop with file edit, shell, search, web fetch/search | Yes (OpenCode or Claude Agent SDK engine) |
| Plan mode (read-only investigation) | Yes |
| To-do tracking in the UI | Yes |
| Skills | Yes: `skills/`, shared by both engines, backed up to Ditto |
| Subagents in parallel (review, challenge, debug, test, subtasks) | **New**: `subagents/`, per-agent model choice, live progress in the UI |
| MCP tools | Yes: Ditto, Atlas, any HTTP MCP via the integration registry |
| Long-term memory across sessions and models | Yes: Ditto (stronger than most: cross-tool, searchable) |
| Projects with instructions and their own workspace | Yes |
| Upload files and whole folders into a workspace | **New**: Files dialog and folder drag-and-drop |
| GitHub access (clone, push, gh CLI) | **New**: `GITHUB_TOKEN`, fine-grained or classic |
| Sandbox | Yes: hardened container, egress allowlist, locked-down WSL distro |
| Own web UI, reachable by URL + API | Yes |

## Gaps, highest value first

1. **Checkpoints, diff view and undo.** Claude Code (rewind) and Cursor (checkpoints) snapshot files every turn and show reviewable diffs. GM shows tool calls but not a diff, and can't roll a turn back. OpenCode already snapshots and has a revert API, so this is mostly UI work.
2. **Isolated workspaces for parallel builds.** Codex cloud tasks, Cursor background agents and Claude Code with git worktrees run several attempts in separate checkouts and let you compare and merge. GM's subagents share one workspace (the `worker` brief tells them to keep to their own files). Next step: a "parallel build" that gives each run its own git worktree, optionally a different model each (best-of-N), with a compare-and-merge view.
3. **Approvals.** Other agents can ask before risky actions (install, delete, push, network). GM runs fully autonomous inside the sandbox and has the `question` tool off. Needed before giving it real credentials: an approve/deny card in the UI for configurable actions (git push, rm -rf, package installs).
4. **Hooks.** Claude Code runs your scripts before/after tool calls and at the end of a turn (format, lint, block dangerous commands, notify). GM has none.
5. **Browser for testing what it builds.** Claude Code and Cursor can drive a browser to check a web UI. Adding the Playwright MCP plus Chromium to the image would let the agent test the games and pages it builds and screenshot them.
6. **Background and scheduled runs with notifications.** Codex, Cursor and Claude Code run tasks while you're away and notify you. GM turns only run while a browser tab is streaming them (they do finish server-side, but there's no queue, schedule or notification).
7. **Pull-request workflow.** With the token and `gh` the agent can open PRs, but there's no PR-review bot on GitHub (Claude Code GitHub Actions, Codex review) and no CI-status awareness in the UI.
8. **Composer conveniences.** @-mention files, slash commands for saved prompts, paste screenshots straight to vision models, a context-usage meter and a manual /compact.
9. **Code intelligence after edits.** OpenCode supports LSP diagnostics (`ENABLE_LSP`, off by default). Turning it on per project gives the "edit, see type errors, fix" loop Cursor and Claude Code have.
10. **Spend controls.** A per-chat and per-day budget, and a cheap default model for subagents. SayGM makes per-model routing easy; the cap is missing.
11. **Secrets isolation.** The agent's shell runs in the same container as the server's keys. Leading cloud agents run tools in a separate sandbox with no secrets. Planned: per-project tool container.
12. **Multi-user.** One shared token today. Needed before opening it to others: accounts, per-user projects, audit log.
13. **IDE integration.** Claude Code, Codex and Gemini CLI plug into VS Code and JetBrains. GM is web-only. Lowest priority for the heritage platform; useful for the games.

## Suggested next three

1. Checkpoints with a diff view and one-click undo (gap 1).
2. Parallel builds in git worktrees with a compare view (gap 2), which uses the subagents and folder uploads just added.
3. Approvals for push, delete and installs (gap 3), so the GitHub token can be given to the agent with confidence.
