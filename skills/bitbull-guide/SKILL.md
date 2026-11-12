---
name: bitbull-guide
description: Use when the user asks how to do something in BitBull itself, what a BitBull feature or setting does, how to install, update, link folders, set keys, use voice, QA Hound, Ditto or the browser extension, or why BitBull behaves a certain way. Answers from BitBull's own user guide instead of from memory.
---

# BitBull user guide

The guide the owner sees under **Help** is on disk at `/app/help/` (in a source checkout: the
repo's `help/` folder). Answer questions about using BitBull from it, not from general knowledge:
BitBull changes often and the guide is kept current with the build you are running in.

1. Read `/app/help/guide/index.json`: every page's `slug`, `title` and one-line `description`.
2. Pick the one or two pages that cover the question and read them
   (`/app/help/guide/<slug>.md`). For "how does it fit together", "where does my data live" or
   "what can reach the internet", also read `/app/help/system-map.html`.
3. Answer in plain steps the owner can follow in the UI, using the names the guide uses for
   buttons and settings (for example **Settings → Integrations → Ditto**). Quote commands exactly.
4. End with where it came from: the page title, and that it is under Help (or
   https://www.bitbull.tech/guide/<slug>).

Rules:

- If the guide does not cover it, say so plainly, then give your best answer marked as not from
  the guide. Do not invent settings, buttons or commands.
- The guide describes the product; `/app/agent-readme.md` describes what you, the agent, may
  touch. For "can you do X for me" read that as well.
- A how-to question is a question: explain, do not start changing settings or files unless asked.
- Never print keys or tokens while explaining where they are set.
