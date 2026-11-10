# Skills

Each folder here is one skill: `skills/<name>/SKILL.md` with `name` + `description`
frontmatter (same format as Claude Code / OpenCode skills).

On every server start (and on `POST /api/skills/sync`) the folder is:

1. mirrored into `<DATA_DIR>/workspace/.claude/skills`, which **both** engines load, and
2. backed up to Ditto as a memory (idempotent per content hash), so your skills are part
   of your long-term memory too.

Git is the source of truth; Ditto is the backup/searchable copy.

## What's here

| Skill | Purpose |
|---|---|
| `coding-workflow` | Explore → plan → implement → verify loop for code changes |
| `git-workflow` | Branching, commits, PRs, cloning into a project |
| `verify-changes` | Find and run the project's build/test/lint, report honestly |
| `code-review` | Verified, severity-ranked review of a diff or PR |
| `debug-systematically` | Reproduce → hypothesise → isolate → fix → prove |
| `repo-onboarding` | Map a repo and record it in `AGENTS.md` |
| `project-recall` | Catch up on a project from Ditto memory |
| `atlas-studio` | Generate video/images/3D via Atlas MCP and exported workflow APIs |
| `taostats-api` | Taostats v1 API (Bittensor data): auth, paging, RAO strings, old `/api/` → `/v1/` route map |
