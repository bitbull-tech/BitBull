# BitBull help

Help pages for BitBull, shown under **Help** in the sidebar and served at `/help/<file>`. The
agent can read this folder too (`/app/help/` in the container), so it can answer questions about
how BitBull works from the same pages you see.

| Page | What it covers |
| --- | --- |
| [system-map.html](system-map.html) | How BitBull fits together: what runs where, a message start to finish, what keeps it safe, services and keys, where things live |

The full guide is online at https://www.bitbull.tech/guide/getting-started; the README in the
repo root is its source.

## Adding a page

1. Add a self-contained `.html` (or `.md`) file here. BitBull's pages refuse inline scripts
   (`script-src 'self'`), so a page must work with HTML and CSS alone; inline `<style>` is fine.
2. Add it to the table above and to `HELP_PAGES` in `web/src/HelpDialog.tsx`.
3. If the website should have it too, copy it into the website's `public/` folder.
