## Moving your Claude.ai projects and chats in
Two routes, both safe to re-run.

**Everything at once**: the account export. On claude.ai go to Settings → Privacy → **Export
data**; Anthropic emails a manifest with links to several zips (`projects-000.zip`,
`conversations-000.zip`, `memories-000.zip`, `frames-000.zip`, `light_metadata-000.zip`).
Download them all into one folder, then:

```powershell
node tools\import-claude-export.mjs "$env:USERPROFILE\Downloads\claude-export" --dry-run   # what would happen
node tools\import-claude-export.mjs "$env:USERPROFILE\Downloads\claude-export"
```

Every project becomes a BitBull project (description, instructions, its docs under
`uploads/claude-import/docs/`, and Claude's memory of the project under
`uploads/claude-import/memory/`); the account-level memory files and your artifacts go to the
general workspace's `uploads/claude-import/`; every conversation becomes a chat with its original
dates and messages. The export doesn't record which project a chat belonged to, so chats arrive
unfiled unless `--project "<name>"` files them all under one; `--since 2026-01-01` skips older
ones; `--projects-only` / `--conversations-only`; `--no-artifacts`. Attachments keep their
extracted text; images are named only. Imported chats have no engine session yet, so the first
message you send in one hands the whole history to the agent as context.

**One project, with Claude's memory files**: ask Claude, in that project, to "export this
project for BitBull". It writes a folder with `project.json`, `docs/` and `memory/` (Claude's
memory files for the project, verbatim), and on the PC:

```powershell
node tools\import-project.mjs claude-export\my-project      # token read from .env
```

It creates the BitBull project (or reuses one with that name), uploads everything to
`uploads/claude-import/` with an `INDEX.md`, and prints the chat message that asks the agent
to seed Ditto from the memory files. Exports hold personal notes: keep them out of git
(`claude-export/` is ignored).
