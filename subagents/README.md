# Subagents

Specialist agents the main agent can start in parallel, like Claude Code's Task tool.
Each file is one agent: YAML front matter, then its system prompt. Both engines load them
(OpenCode as `mode: subagent` agents via its `task` tool, the Claude Agent SDK as `agents`).

Front matter:

| key | meaning |
|---|---|
| `name` | id the main agent uses (`reviewer`, `debugger`…) |
| `description` | when to use it; the main agent reads this to decide |
| `access` | `read` (no file edits) or `write` |
| `model` | `inherit` (same as the chat) or a SayGM model id. Override per agent with `SUBAGENT_MODEL_<NAME>` or for all with `SUBAGENT_MODEL` |

A different model family for `reviewer` and `challenger` (e.g. GPT reviewing Claude's work)
catches more than self-review. Set it in `.env`, e.g. `SUBAGENT_MODEL_REVIEWER=gpt-5.5`.
