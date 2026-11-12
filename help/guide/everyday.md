## Help and the user guide
The **?** button at the bottom of the sidebar opens **Help**: this guide, page by page, and the
system map, with a help chat beside it. Ask how to do something under **Ask BitBull** and the
answer appears there, taken from the guide (the `bitbull-guide` skill reads the same pages from
`help/`), with a link to the page it came from. Help remembers where you were: close it to try a
suggestion and the page, your question and the conversation are there when you open it again.
**Open as a chat** carries the conversation on in the main window, and you can also just ask in
any chat: "how do I link a folder?" works the same way.

## Activity and errors
The **Activity** bar under the chat (collapsed by default) shows the latest event and a red
badge when something has failed. Expand it for recent activity (all, errors and warnings,
or this chat); **Full log** opens everything with search, filters and download. Errors also
pop up as alerts in the top-right corner and show as a badge in the sidebar. It records chat
turns (model, time, tokens, cost), every tool call and subagent, uploads, Ditto and SayGM
problems and server warnings. Stored in `data/logs/activity.jsonl`, secrets redacted.

To get the agent's view on something: tick entries in the log and choose **Explain**,
**Debug** or **Review with subagents**, or highlight text in the log or in a reply and use
the **Ask agent** buttons that appear. Either way the excerpt is put in the message box with
the request, so you can add your notes before sending.

## Updates and compatibility notices
BitBull depends on SayGM and Ditto, which change on their own schedule. A banner above the chat
tells you when one of them has changed something BitBull relies on, is retiring part of its API,
has stopped offering your default model, or no longer accepts a key (a Connect Ditto sign-in lasts
three months), and when a newer BitBull is out. Notices are also written to Activity, and can be
dismissed per computer. The server checks shortly after it starts and every six hours.

To update: pull the latest code and deploy it again. Your data folder is never touched.

```powershell
cd <your BitBull folder>
git pull
.\scripts\bitbull-wsl\deploy.ps1          # Windows
bash scripts/bitbull-mac/deploy.sh          # Mac
docker compose up -d --build                # Linux and servers
```

What is checked, and how maintainers publish a notice to every install: [docs/COMPAT.md](https://github.com/bitbull-tech/BitBull/blob/main/docs/COMPAT.md).

## Export a chat
One click: **Copy last** in the top bar copies your latest request and the agent's reply,
with its tool calls, that turn's activity log and a short description of how BitBull is set up,
as Markdown ready to paste into Claude, ChatGPT, Codex or another BitBull chat. **Copy for agent**
under any reply does the same for that exchange.

Under each reply, **Copy for agent: full · prompt + reply** copies that exchange either
way; **prompt + reply** is the short form (just the request, the answer and any error) for a
quick second opinion. The ▾ next to Copy last has the same two for the latest exchange, plus
**Copy whole chat**, **Copy conversation only**, **Download Markdown**
and **Download JSON** (everything, untruncated).

Keys and tokens are replaced with `[REDACTED]` in every export.

## Archive
Finished with a project or a chat but don't want to delete it? **Archive** it: the archive
button on a project row (or right-click → Archive project), or **⋯ → Archive** on a chat. It moves
into the collapsed **Archive** section at the bottom of the sidebar, a project with all its chats.
Nothing is deleted or changed; archived chats still open, still turn up in search, and
**Unarchive** puts them back where they were.

**Tidying in bulk:** **Select** (by the Chats heading, or **Select…** in a chat's right-click menu)
puts a tick box on every chat; then Archive, Move or Delete them together. Right-click any chat for
its menu. A chat that never got a message isn't listed and is cleared out after an hour.

## GitHub
Set `GITHUB_TOKEN` to a fine-grained token (`github_pat_…`, recommended, limited to the repos
the agent needs) or a classic one (`ghp_…`). git gets it through a credential helper and the
`gh` CLI through `GH_TOKEN`. Settings → Integrations shows who it signs in as.

See [docs/GAPS.md](https://github.com/bitbull-tech/BitBull/blob/main/docs/GAPS.md) for what's still missing compared with other coding agents, and [docs/STORAGE.md](https://github.com/bitbull-tech/BitBull/blob/main/docs/STORAGE.md) for the planned Hippius storage.

## 404: 3D as code
404 (Bittensor subnet 17) makes every 3D object a Three.js module. There is no 404 key or MCP: the
agent clones the public [404 game recipe](https://github.com/404-Repo/404-game-recipe), follows it
(the `404-game-recipe` skill), checks each object with the recipe's verifier and a game with its jam
gate (the image ships Chromium for that), and a jam entry goes in as a pull request from your GitHub
account, after asking you. Optional: 404's open model on your own RunPod GPU
(`FOUR04_MODEL_URL`, `FOUR04_MODEL_KEY` in Settings → Integrations → 404).

## Make it yours (white-labelling)
Name, tagline, logos and every colour come from `brand.json` in the data folder, with the
image files in `brand/` beside it. Edit it and reload the page — nothing is rebuilt or
deployed. `docs/brand.example.json` is a starting point and
[docs/BRANDING.md](https://github.com/bitbull-tech/BitBull/blob/main/docs/BRANDING.md) lists every token you can override. Settings →
Appearance shows what is in force.
