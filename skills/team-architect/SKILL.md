---
name: team-architect
description: Use when the owner wants to build, plan, change or review a team of AI agents for real work (research, writing, support, operations, coding, personal productivity), or asks "help me set up agents for X". Interviews them, recommends one use case, designs a 3-5 role team on BitBull's subagents, and writes it to TEAM.md once they approve. Also explains how to run an existing TEAM.md.
---

# Team architect

Help the owner build a small, real team of AI agents inside this BitBull project: clear roles,
clean handoffs, review built in, and the owner in charge of anything that matters. Be practical:
a narrow team that does one job well beats a big one that demos well.

## 1. Interview first (one message, then wait)

Ask at most five short questions together, with a suggested answer for each so they can just
say "yes":

1. What should the team produce first, and for whom? (one concrete deliverable)
2. What do they already do by hand today that this would replace, and how long does it take?
3. Their skills and the time they can give it each week.
4. What it may never do without asking (publish, send, delete, spend, change live systems).
5. What "it's working" would look like after a week.

If the workspace already has `TEAM.md`, read it and ask what they want to change instead.

## 2. Recommend one use case

Compare the candidates that fit their answers (for example research and writing, lead
generation, customer support, internal operations, a research assistant, personal productivity,
or coding work on a repo) in a short table: value to them, how easy it is to check the output,
data and tools it needs, risk. Recommend **one**, the one whose output is easiest to verify and
that saves the most of their time. Say why in two sentences.

## 3. Design the team: 3 to 5 roles

Each role is run by one of BitBull's subagents, so it inherits real limits:

| Role needs to | Run it with | Limits |
| --- | --- | --- |
| Read, research, analyse, plan, edit text it returns | `specialist` | read-only: no edits, no shell |
| Change files or run commands | `worker` | edits only the files in its brief |
| Check work | `reviewer` (code) or `specialist` as a QA checker (anything else) | read-only |
| Argue against a plan | `challenger` | read-only |
| Write and run tests | `tester` | edits tests only |

Rules: no two roles own the same output; at least one role checks another's work before anything
reaches the owner; the main agent (you) is the coordinator and assembles the final answer; the
owner is the last checkpoint. Don't invent roles for the sake of it.

For each role define, in one line each: **Owns** (and what it must leave alone), **Input**,
**Output** (a fixed format the next role can rely on), **Decision rules**, **Escalate when**,
**Done when**, and **Runs on** (the subagent).

## 4. Workflow, tools and checks

- **Workflow:** numbered steps from request to final output: who does what, what is handed on,
  where review happens, and feedback loops with a limit (for example "reviewer finds a
  high-severity issue: back to writer, at most twice, then escalate").
- **Approval points:** list every step that publishes, sends, deletes, spends money or can't be
  undone. At each one, stop and ask the owner. Never ask for passwords or keys in chat; point them
  to Settings.
- **Tools:** only what the use case needs, from what BitBull has: Ditto memory, the web (new sites
  are approved by the owner), GitHub, Taostats, Atlas, 404, Hippius, and the project's
  integrations. Say what each is for. Fewer is better.
- **QA plan:** five test tasks with the result a good team would give (save them in TEAM.md and
  rerun them after any change to roles, models or prompts); the failure modes to watch (made-up
  facts, scope creep, roles doing each other's work, loops); and how to tell it's helping: time
  saved per task, how often the owner had to rewrite the output, cost per task (Activity shows it).

## 5. Show the blueprint, then write it

Present the whole blueprint in chat: use case, roles, workflow, approval points, tools, QA plan
and a 7-day launch plan (day 1 set up and run one test task; days 2-3 run the five test tasks and
fix the worst failure; days 4-5 real work with every output reviewed; day 6 measure; day 7 keep,
change or stop). End with **START HERE FIRST**: the single thing to do next.

Ask "Shall I save this as the project's team?" A team belongs to a project: if this chat isn't in
one, suggest they create a project for it first (the **+** next to Projects in the sidebar) and
continue there, since a TEAM.md outside a project would apply to every chat that isn't in one.
Only after a yes:

1. Write `TEAM.md` at the workspace root in the format below.
2. Add one line near the top of `AGENTS.md` (create it if missing):
   `This project runs an agent team: read TEAM.md before starting work.`
3. Save a short memory to Ditto: the use case, the roles and where TEAM.md is.
4. Tell them how to use it: just ask for the work in this project's chats; the team runs itself.
   Suggest putting the use case in the project's instructions (project settings) too.

## TEAM.md format

```markdown
# Team: <name>
Use case: <one sentence>. First deliverable: <what>, for <whom>.
Owner approval needed before: <publishing, sending, deleting, spending, …>

## Roles
### <Role name>
- Runs on: specialist | worker | reviewer | challenger | tester
- Owns: …
- Input: …
- Output: …
- Decision rules: …
- Escalate when: …
- Done when: …

## Workflow
1. …

## Tools
- <tool>: <what for>

## Test tasks
1. <task> → <what a good result looks like>

## Measures
- …

## Launch plan
Day 1: …
```

## Running a team (when TEAM.md exists)

For a request in this project: read TEAM.md, follow its workflow step by step, and delegate each
role to its subagent with that role's section of TEAM.md pasted into the brief plus the task and
everything it needs (subagents see only their brief). Run independent roles in parallel. Pass each
role's output on unchanged. Respect every approval point: stop and ask the owner. A report that
starts with `ESCALATE:` goes to the owner as a plain question. Finish with the assembled result
and one line per role saying what it did.
