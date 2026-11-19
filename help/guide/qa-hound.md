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
shown finding is at or above the blocking severity, otherwise comment. It approves only if you
also tick **Let QA Hound approve** (off by default, because the approval is given under your
GitHub account on the word of a model that has just read the code), and then only when the run is
complete, the verdict is "use", no finding at or above the blocking severity was even held back,
and every check BitBull runs itself passes:

- **Quotes.** Each finding quotes the lines it is about, and BitBull looks for the quote in the
  file. A finding whose quote isn't there is held back; more than the odd slip and the whole list
  isn't relied on. (This one runs on every QA Hound run, not only for pull requests.)
- **Coverage.** The reviewers are told which files the pull request changes, and BitBull checks
  from the tool log that each one was opened by a reviewer.
- **Commit.** The working copy that was reviewed is at the pull request's commit, with nothing
  uncommitted. If it isn't, Sync the copy and run again.
- **Planted defects.** Two known defects (an SQL injection and an ownership check the wrong way
  round) are added to a scratch copy of a few of the target's files, and each reviewer model
  reviews that copy in a short side test. A model that misses one doesn't get to approve. It works
  for TypeScript, JavaScript, Python, Go, Rust, Java, Kotlin, C#, C and C++, Swift, PHP, Ruby,
  PowerShell and shell scripts; with none of those in the target there is no approval. The scratch
  copy (`.hound-work/` in the workspace) is removed when the test ends.
- **Secrets.** The changed files are scanned for text shaped like a key or password. A hit is
  reported by file and line, never by showing it.
- **CI.** The project's own automated checks (GitHub check runs and commit statuses) exist, have
  finished and passed on that exact commit. BitBull reads their result; it doesn't run the
  project's build or tests itself, because that would mean executing code it is still reviewing.
  Your GitHub token needs read access to checks and commit statuses. A project with no automated
  checks at all can use a **clean-machine test** instead (below): if it passed at that commit and
  one of its commands was your test command, it stands in. It never stands in for a check that
  failed, is still running or couldn't be read.
- **Clean machine** (only when you tick it). The clean-machine test passed at the pull request's
  commit and Cathedral's verify of the room's receipts passed.
- **People.** A change that touches sign-in or key handling, CI, containers or install scripts
  always goes to a person: QA Hound comments on it and never approves it.
- **Agreement.** Two reviewers, from different model families, each recommend "use" on their own
  (before reading the other) and still do after the challenge round. The model that writes the
  verdict weighs them: it can come out lower than they did, never higher.
- **Benchmark.** Both reviewer models have passed BitBull's benchmark: three short read-only
  reviews of code with twelve seeded defects (path traversal, a missing `await` on a permission
  check, a token whose signature is never checked, and so on) and files with nothing wrong in
  them. A model passes with ten or more found and no more than two false alarms. Run it from the
  QA Hound window (**Run the benchmark**, next to each chosen reviewer once approving is ticked);
  it costs what three short reviews cost, the result is kept, and it is asked for again when the
  benchmark changes. The cases are in this public repo, so a pass means "reads code carefully
  enough to find these", not "finds every bug".

In a chat, each row of the findings table says whether the code it quotes was found in the file
(**quote found** or **quote not in the file**), checked against the workspace as it is now.

The review lists each check and its result. The checks lower the chance of a missed problem; they
don't remove it, and a review by models is not a review by a person.
A partial run says so in the heading. On your own PR, which GitHub won't let you approve or block,
it comments and says what it would have done.

**Running the code, away from your computer.** With [Cathedral](#cathedral-confidential-sandboxes)
on for the project, the QA Hound window has two more ticks. **Run it in a confidential sandbox**
gives the reviewers one room holding a copy of the target (its exact commit when it is in a git
repo), network closed, where they may run the code and its tests; everywhere else they stay
read-only. **Clean-machine test** is run by BitBull itself, with no model involved: your install,
build and test commands on the repo's exact commit in a fresh room, network closed apart from any
hosts you list for the install. The result is a certificate saved with the verdict and in
`.bitbull/certificates/` in the workspace: the commit, each command with its exit code and the
hashes of what it printed, the room's receipts and how to check them yourself. You approve each
room first. The commands are the ones you type, so the test is as good as they are.

## Cathedral: confidential sandboxes
For running and checking code, repos and files you don't trust or were given, somewhere that
isn't your computer. A Cathedral sandbox is a small rented room on an AMD SEV-SNP machine: it has
none of your keys, none of your workspace and, unless you say otherwise, no network. It is billed
by the second until it is deleted.

**Set it up.** Get a key from [cathedral.computer](https://cathedral.computer) and give it a
spending cap of its own there. Paste it in Settings → Integrations → Cathedral, then tick
**Cathedral** in the settings of each project that should have it. It is off everywhere until you
do both.

**What BitBull does with it.**

- **BitBull holds the key; the agent never does.** The agent gets tools (quote, create, run a
  command, upload, download, receipts, delete) and BitBull makes every call.
- **You approve every sandbox.** A card shows the size, hourly rate, lifetime, spend cap and
  whether it has internet, and waits for you. Stopping the chat closes the card. Scheduled runs
  and Telegram messages can't create one.
- **A spend limit per sandbox**: `CATHEDRAL_MAX_SPEND_USD` in `.env` (default 0.50, at most
  25.00). BitBull refuses a sandbox that could cost more, and refuses a key with no cap of its own
  unless you set `CATHEDRAL_ALLOW_UNCAPPED_KEY=on`. Both live in `.env` only, where the agent
  can't change them.
- **Only named files go up.** One file at a time, by its path in the project's workspace, each
  logged in Activity with its size and SHA-256. Anything that looks like a key, password or wallet
  is refused by name (`.env`, `.ssh`, `*.pem`, `coldkey`, `wallet*.json` and the rest of the list
  the linked-folder copy uses), as is anything under `.git`. A commit that contains such a file
  isn't sent at all, and a folder copy leaves out whatever git ignores.
- **Only its own rooms.** A project can run commands in, read from and delete only the sandboxes
  it created.

**What "confidential" covers.** Inside the room, the code runs in memory encrypted by AMD
SEV-SNP, and each receipt is signed by a key the machine's attestation report commits to. It does
not cover the way in: commands and files pass Cathedral's API in plaintext on their way to the
room, so never send secrets. **Verify** reports Cathedral's own checks on the receipts; the AMD
report, AMD's certificate chain and the approved build are checked only by Cathedral's offline
verifier (`ctcli receipt verify`), which you run yourself.

**Limits to know.** Sandboxes are tracked in memory: if BitBull restarts while one is running,
BitBull no longer knows it, and it runs until its lifetime ends (the spend cap still holds), so
delete it from Cathedral's side if you want it gone sooner. The name filter is cautious: a repo
with source files named like secrets (`mnemonic.py`, a `credentials/` folder, a test `.pem`) is
refused whole. QA Hound uses the same rooms for **Run it in a confidential sandbox** and the
**clean-machine test**: see QA Hound. The agent's side is in
`skills/cathedral-sandbox/SKILL.md`; the risks are R13 in
[docs/THREAT-MODEL.md](https://github.com/bitbull-tech/BitBull/blob/main/docs/THREAT-MODEL.md).

## The Dog Pound: a model for each job
A project can have a **Dog Pound**: a team of dogs, each running on the model you choose for its
job. You talk to the Alpha Dog as you would to any chat; it plans the work, hands tasks to the
others and reports back.

| Dog | Job | Can it change files? |
|---|---|---|
| **Alpha Dog** (black suit) | Plans, splits the work up, hands it out, reports to you. It is the chat itself | yes |
| **Code Dog** (blue hoodie) | Writes the change | yes |
| **Review Dog** (judge's wig) | Scrutinises the change | no: read-only |
| **Test Dog** (hi-vis) | Writes and runs tests | yes |
| **Dig Dog** (deerstalker) | Researches: code, docs, the web | no: read-only |

**Set it up.** **Call the BitBull Pound** when you create a project (or on its home screen), or
**Dog Pound** in the top bar of a project, or right-click the project. Tick **Use a Dog Pound in this project**
and tick the dogs you want, each with a model from its drop-down; an unticked dog isn't in the
pound, and its model is remembered for when you tick it again. The Alpha Dog is always in: it
starts on your default model.
**Mixed makers** fills them in with a different maker for planning, coding and reviewing, which
is the point: models from one maker tend to miss the same things, and the window warns when the
Code Dog and the Review Dog share one. The Review Dog's QA Hound benchmark result is shown when
it has one. New chats in the project start on the Alpha Dog's model.

**How the work flows.** The Alpha Dog's model decides what to hand out. The review is not its to
skip: with **Review every Code Dog's work** on (the default), BitBull itself sends each piece of
the Code Dog's work to the Review Dog and hands both reports back together. If the review finds
something, the Alpha Dog sends the fix back to the Code Dog. A strip above the message box shows
which dogs this chat has put to work, on which model, for how long and at what cost; click one to
open its chat. **Each dog works in a chat of its own** (on by default) lists those chats in the
sidebar as "Code Dog · …"; off, you see only the Alpha Dog's chat and the others' are kept in
the Archive.

**What it is under the hood.** Each dog is a turn of its own that BitBull starts on OpenCode,
which serves every model, so "Claude plans, GPT codes, Gemini reviews" works whichever engine the
Alpha Dog's chat is on. (Subagents, below, run inside the chat's own engine and share one model
setting for the whole install.) The read-only dogs run in plan mode, enforced by the engine: no
edits, no shell, no MCP tools. The others work in the project's workspace with its usual limits.
A dog can't hand work on. Reports come back to the Alpha Dog fenced as another model's account,
not as instructions.

**Limits.** Each dog is a model run and costs what that model costs; a coding task with a review
is two. One chat can have four dogs working at once. A dog stops at its time limit (25 minutes
for the Code Dog, 20 for the Test Dog, 12 for the others) and when you stop the chat. Two dogs
given the same files will tread on each other: the Alpha Dog is told not to, but nothing locks
files. If BitBull restarts mid-task the task is lost (the dog's chat stays). "Build an agent
team" and `TEAM.md` still work as before and are not yet joined up with the pound.

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
