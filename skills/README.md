# Skills

Each folder here is one skill: `skills/<name>/SKILL.md` with `name` + `description`
frontmatter (same format as Claude Code / OpenCode skills).

On every server start (and on `POST /api/skills/sync`) the folder is:

1. mirrored into `<DATA_DIR>/workspace/.claude/skills`, which **both** engines load, and
2. backed up to Ditto as a memory (idempotent per content hash), so your skills are part
   of your long-term memory too.

Git is the source of truth; Ditto is the backup/searchable copy.
