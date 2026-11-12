# BitBull help

The user guide and reference pages shown under **Help** in the sidebar, served at `/help/<file>`.
The agent reads this folder too (`/app/help/` in the container, through the `bitbull-guide`
skill), so it answers "how do I…" questions from the same pages you see. **Ask BitBull** in the
Help window opens a new chat with your question.

| What | Where | Made from |
| --- | --- | --- |
| The guide (16 pages) | `guide/<slug>.md`, listed in `guide/index.json` | The README's sections plus the hand-written install pages in the website repo (`content/guide-src/`), by the website's `scripts/sync-guide.py` |
| System map | `system-map.html` | Written by hand; the website keeps a copy in `content/system-map.html` |

## Regenerating the guide

The guide is generated, so edit its sources (this repo's `README.md`, or the website's
`content/guide-src/*.md`), then run the generator once for each place it is shown, from the
website repo:

```
python scripts/sync-guide.py ../BitBull/README.md content/guide            # the website
python scripts/sync-guide.py ../BitBull/README.md ../BitBull/help/guide    # Help in the app
```

Commit both repos. Links between guide pages are written `/guide/<slug>`; Help keeps those inside
the window and sends anything else to the browser.

## Adding a reference page

1. Add a self-contained `.html` file here. BitBull's pages refuse inline scripts
   (`script-src 'self'`), so a page must work with HTML and CSS alone; inline `<style>` is fine.
2. Add it to `REFERENCE` in `web/src/HelpDialog.tsx`, and mention it in
   `skills/bitbull-guide/SKILL.md` if the agent should use it.
