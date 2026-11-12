# Subagents

Specialist agents the main agent can start in parallel, like Claude Code's Task tool.
Each file is one agent: YAML front matter, then its system prompt. Both engines load them
(OpenCode as `mode: subagent` agents via its `task` tool, the Claude Agent SDK as `agents`).

Front matter:

| key | meaning |
|---|---|
| `name` | id the main agent uses (`reviewer`, `debugger`…) |
| `description` | when to use it; the main agent reads this to decide |
| `access` | `read`: reads files only, with no edits, no shell and no starting other agents (on both engines); or `write`: full tools |
| `model` | `inherit` (same as the chat) or a SayGM model id. Override per agent with `SUBAGENT_MODEL_<NAME>` or for all with `SUBAGENT_MODEL` |
| `owns` | optional: what it is responsible for, and what it must leave alone |
| `input` | optional: what its brief must contain (the main agent is told, so it briefs properly) |
| `output` | optional: the shape of its report (the main agent is told what comes back) |
| `escalate` | optional: when it stops and reports `ESCALATE:` with a decision for the owner, instead of deciding |
| `done` | optional: its success criteria |

The last five are the agent's **contract**: they are added to the end of its prompt as "Your
contract" (server/src/subagents.ts). Clear handoffs are what let several agents work as a team.

`specialist` is the read-only stand-in for any role in a project's agent team (`TEAM.md`, made
with the `team-architect` skill): the main agent pastes the role's section of TEAM.md into its
brief. Roles that edit files or run commands use `worker` the same way.

A different model family for `reviewer` and `challenger` (e.g. GPT reviewing Claude's work)
catches more than self-review. Set it in `.env`, e.g. `SUBAGENT_MODEL_REVIEWER=gpt-5.5`.
