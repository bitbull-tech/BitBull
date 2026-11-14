## QA Hound
**QA Hound** — unleash multiple LLMs on your designated repo, folder or file to review, challenge
each other and summarise a verdict and recommendations.

The **QA Hound** button (top bar, in any chat) points up to two *other* models at a repo, folder or
file in the workspace. Each reviews it on its own in the sandbox, read-only, across the areas you tick
(attack vectors, correctness, code quality, performance, user experience) and writes a report with
evidence; then each reads the other's report and has to agree, refute or admit it can't tell,
with evidence; then the chat's own model, the primary handler, weighs both rounds, checks any
disputed point itself, and replies in the chat with a per-reviewer summary, a ranked table of
verified issues and an overall recommendation (use as is / fix first / don't use). The
reviewers' chats are in the sidebar as "QA Hound · …" and in the activity log, so their working
is inspectable and exportable. Different model families catch different things; two reviewers
from one family mostly share blind spots. `POST /api/swarm` starts one from outside (the code and
API keep the name *swarm*).

**Limits and filters** (QA Hound dialog): a hard **budget** for the whole run and a **time limit**
(the reviewers stop at 75% of the budget and 80% of the time, the rest is kept for the verdict, which
stops at the limit; a run that hits a cap ends with what it has, marked partial), a **minimum
severity** and a **minimum confidence**: the verdict scores every finding 0–100 for how sure it is,
after checking, that it is real, and anything under the thresholds is listed as held back with the
reason. **Only these paths / Never these** scope the review with globs. **Post the verdict on the
pull request** puts it on the open PR of the target repo's current branch: request changes when a
shown finding is at or above the blocking severity, approve when none is, comment when the run was
partial (and comment, saying so, on your own PR, which GitHub won't let you approve).

## Subagents
The agent can start specialists in parallel, like Claude Code's Task tool: `reviewer`,
`challenger`, `debugger`, `tester`, `worker` and `specialist`, defined in
[`subagents/`](https://github.com/bitbull-tech/BitBull/blob/main/subagents/README.md). Their progress shows live under each reply. Give them
a different model for a second opinion, e.g. `SUBAGENT_MODEL_REVIEWER=gpt-5.5`.

Each has a **contract**: what it owns, what its brief must contain, what it returns, when it
stops to ask you (its report then starts with `ESCALATE:` and BitBull puts the question to you),
and when it is done. That keeps their work from overlapping and their handoffs predictable.

**Agent teams.** Choose **Build an agent team** on a project's home screen (or just ask). BitBull
asks a few questions, recommends one use case, and designs a team of three to five roles with a
workflow, review checkpoints, the points where it must ask you (publishing, sending, deleting,
spending), a short test plan and a 7-day launch plan. Once you approve it, it is saved as
`TEAM.md` in the project, and from then on work you ask for there runs through the team. Each
role runs on one of the subagents above, so it keeps their limits: read-only roles can't change
anything. The `team-architect` skill holds the method.

## Repositories
**Repos** (top bar), the branch icon on a project, or right-click a project → **Repositories**
lists every git clone in that workspace: current branch, what's uncommitted, ahead/behind its
upstream, last commit, remote, branches (local, and remote on request), stashes, and a summary
of the uncommitted changes. **Browse files** opens the Files view at that clone. Three buttons
act directly: **Sync from origin** fetches and fast-forwards a copy; **Change remote…** points a
copy at a new origin (a repo in a linked folder as `links/<folder>/<repo>`, `owner/name` on
GitHub, or an https address with no sign-in in it), fetches, and can rename the folder to match;
and **Add a repository** makes a working copy of a repo in one of your linked folders, which then
follows that folder, so Sync brings in what you commit on your PC (its GitHub origin is kept as
the remote `upstream`). A GitHub repository is cloned by the agent in the chat, because private
ones need your token. Every other button (explain changes, fetch and compare, review and propose
a commit, new branch, switch, compare) puts a request in the chat for the agent, so git actions
run in the sandbox where you can see them and the reviewer can check them. A failed fetch now
says why (renamed or private repository, not on the network allowlist) instead of the command.
