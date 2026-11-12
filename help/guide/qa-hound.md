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
`challenger`, `debugger`, `tester` and `worker`, defined in
[`subagents/`](https://github.com/bitbull-tech/BitBull/blob/main/subagents/README.md). Their progress shows live under each reply. Give them
a different model for a second opinion, e.g. `SUBAGENT_MODEL_REVIEWER=gpt-5.5`.

## Repositories
**Repos** (top bar), the branch icon on a project, or right-click a project → **Repositories**
lists every git clone in that workspace: current branch, what's uncommitted, ahead/behind its
upstream, last commit, remote, branches (local, and remote on request), stashes, and a summary
of the uncommitted changes. **Browse files** opens the Files view at that clone. The view only
reads; every other button (explain changes, fetch and compare, pull, review and propose a
commit, new branch, switch, compare) puts a request in the chat for the agent, so git actions
run in the sandbox where you can see them and the reviewer can check them.
