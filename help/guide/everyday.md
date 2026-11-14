## Help and the user guide
The **?** button at the bottom of the sidebar opens **Help**: this guide, page by page, and the
system map, with a help chat beside it. Ask how to do something under **Ask BitBull** and the
answer appears there, taken from the guide (the `bitbull-guide` skill reads the same pages from
`help/`), with a link to the page it came from. Help remembers where you were: close it to try a
suggestion and the page, your question and the conversation are there when you open it again.
**Open as a chat** carries the conversation on in the main window, and you can also just ask in
any chat: "how do I link a folder?" works the same way.

## Schedules
**Schedules** (top bar) runs a prompt on its own at set times: every weekday at 08:00, every two
hours, Mondays and Thursdays at 18:30. Each schedule is a dedicated agent with its own chat
(⏰ and its name), where every run lands, so each run can build on the last and you can read or
reply to any of them. Put it in a project and it works with that project's files, instructions
and `TEAM.md`, so a team can run on a timetable.

Nobody is watching a scheduled run, and it is told so: anything that publishes, sends, deletes,
spends or can't be undone is prepared and listed under **Waiting for your approval** in its chat,
for you to approve there. A run never starts while the previous one is still going, the shortest
interval is 15 minutes, and times follow your timezone across daylight-saving changes. Runs
happen while BitBull is running; a run missed while it was off happens once when it starts again.
**Run now** starts one straight away. A cheap, fast model is usually enough.

## Telegram
Message BitBull from your phone, and get scheduled results there, through a Telegram bot that is
yours alone. It is private and personal: the bot answers one Telegram account, yours, in its
one-to-one chat. Everyone else, and every group, is ignored without a reply.

1. In Telegram, open [@BotFather](https://t.me/BotFather), send `/newbot` and follow it. It
   gives you a token that looks like `123456789:AA…`.
2. In BitBull: **Settings → Integrations → Telegram**. Paste the token in **Bot token** and save.
3. Press **Pair my Telegram**, then open your bot from the button shown and press **Start** (or
   send the bot the one-time code). The bot now answers you and nobody else.

Nothing has to reach your computer from the internet: BitBull calls out to Telegram, so there is
no port to open and no tunnel.

Send the bot any text and BitBull runs it and replies. `/new` starts a fresh chat, `/stop` stops
what it is doing, `/help` lists these. The conversation is the **Telegram** chat in BitBull's
sidebar, so you can read it or carry on from either side. On a schedule, tick **Send each
result to my Telegram** to get every run's summary on your phone.

Nobody is at the BitBull screen when a message comes in by phone, so anything that publishes,
sends, deletes or spends is prepared and left for your approval in BitBull, and requests that
need a click there (network access, for one) wait for you. Text only for now: no photos, voice
notes or files.

Two things to know. Bot chats are not end-to-end encrypted, so Telegram can read what passes
through: don't send secrets that way. And whoever can use your Telegram account can talk to your
BitBull, so turn on Telegram's two-step verification. How pairing is protected, the network
opening it needs, and how to switch it off are in [docs/TELEGRAM.md](https://github.com/bitbull-tech/BitBull/blob/main/docs/TELEGRAM.md).

## Leadpoet: lead generation
[Leadpoet](https://leadpoet.com) is Bittensor subnet 71: it finds companies and contacts that
fit your ideal customer, with the evidence for each, and writes and sends email and LinkedIn
outreach. Connected, BitBull can plan and run a campaign with it: write the customer profile,
request leads, review them, draft the sequences, build the campaign and report on replies.

1. **Settings → Integrations → Leadpoet → Connect Leadpoet.** Sign in with your Leadpoet account
   and approve; there is no key to paste.
2. In the project you run campaigns from, open project settings and tick **Leadpoet**.
3. Ask: "Plan a campaign to get us ten meetings with heads of logistics at UK retailers."

You choose what BitBull may do when you connect: look only, plan and prepare (the default), or
also send. With sending off, BitBull drafts everything and you press send in Leadpoet. Lead
requests spend Leadpoet credits, so the agent shows the plan and the cost and waits for your
yes; and in scheduled runs or over Telegram it only reads and drafts. Your Leadpoet sign-in
stays on the server and is never given to the agent. More in
[docs/LEADPOET.md](https://github.com/bitbull-tech/BitBull/blob/main/docs/LEADPOET.md).

## Usage
The bar-chart button at the bottom of the sidebar opens **Usage**: estimated spend per day (hover
a day to see which models it went on) and per model, with replies and tokens, over 7, 30 or 90
days. The figures are BitBull's own estimates from SayGM's live prices at the time of each
reply; your SayGM usage page is the bill. Your SayGM balance will show here once Sign in with
SayGM is available.

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

**To update.** In the BitBull app, open the launcher (from the menu-bar or tray icon) and press
**Update**: it gets the latest BitBull from GitHub and rebuilds. On a Mac it also brings the app
itself up to the latest release and restarts it when the update has finished. Your chats, files and settings
are never touched. The same from a terminal, in your BitBull folder:

| On | Run |
| --- | --- |
| Windows | `powershell -ExecutionPolicy Bypass -File scripts\bitbull-wsl\update.ps1` |
| Mac | `bash scripts/bitbull-mac/update.sh` |
| Linux and servers | `git pull` then `docker compose up -d --build` |

The launcher's **Version** row compares what is running with your copy of the code on this
computer, not with GitHub, so "same as your copy" can still be behind: **Update** is what fetches
anything newer. On a Mac, `bash scripts/bitbull-mac/app.sh` installs or updates just the app; if the app is open
it is asked to quit, replaced and reopened. **Quitting the app** (⌘Q, or Quit on its Dock or
menu-bar icon) closes only the app: BitBull keeps running, and clicking the Dock icon brings its
window back. On Windows a new app is on the
[releases page](https://github.com/bitbull-tech/BitBull/releases/latest).

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
