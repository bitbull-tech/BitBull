## Bring your history with you

Switching to BitBull shouldn't mean starting from a blank page. BitBull can take in the
conversations you've had with **any** other agent (Claude Code, Codex, Cursor, Gemini CLI,
ChatGPT, or your own tools) and file them as ordinary BitBull chats, with their original titles
and timestamps. Open one, send a message, and the agent picks up with the whole history as
context.

Claude.ai has a ready-made importer: see [Bring your work in](/guide/import). For everything
else, there's one endpoint.

## The quickest way: let your current agent do it

Your existing agent knows where its own history lives. Paste this into it:

```text
Export our past conversations and import them into my BitBull at http://localhost:8787.
Follow https://www.bitbull.tech/guide/import-agents for the format. My APP_TOKEN is in
BitBull's .env; read it from there and don't print it.
```

## The endpoint

`POST /api/import/conversations`, with `Authorization: Bearer $APP_TOKEN`.

```json
{
  "source": "codex",
  "projectId": null,
  "conversations": [
    {
      "id": "2026-11-03-auth-refactor",
      "title": "Auth refactor",
      "createdAt": 1793750400000,
      "updatedAt": 1793757600000,
      "messages": [
        { "role": "user", "content": "Let's split the auth module…", "createdAt": 1793750400000 },
        { "role": "assistant", "content": "Here's a plan…", "createdAt": 1793750460000 }
      ]
    }
  ]
}
```

```bash
curl -s http://localhost:8787/api/import/conversations \
  -H "Authorization: Bearer $APP_TOKEN" -H 'content-type: application/json' \
  --data @conversations.json
# → {"imported": 1, "skipped": 0, "messages": 2}
```

| Field | Rules |
|---|---|
| `source` | Where the chats came from: lowercase letters, digits, `.` and `-`, up to 40 characters (`codex`, `cursor`, `claude-code`) |
| `projectId` | Optional. File the chats under a BitBull project (ids from `GET /api/projects`); leave out for the general workspace |
| `conversations[].id` | Your stable id for the conversation: letters, digits, `_`, `.`, `-`, up to 80 characters |
| `title` | Optional, up to 200 characters |
| `createdAt`, `updatedAt` | Unix time in **milliseconds** |
| `messages[]` | `role` is `user` or `assistant`; `content` is text, up to 400,000 characters |
| Limits | 50 conversations and 64 MB per request, 5,000 messages per conversation. Send big histories in batches |

## Good to know

- **Safe to re-run.** Each chat is stored as `<source>-<id>`, so sending the same conversation again
  is skipped, not duplicated.
- **Text only.** Messages come in as text. Tool calls and attachments aren't recreated; include
  anything important (a diff, a file's contents) in the message text.
- **No engine session yet.** The first message you send in an imported chat hands its whole history
  to the agent as context, the same as a chat moved between engines.
