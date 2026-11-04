# Branding and white-labelling

The UI reads its name, logo and every colour from one file. Drop a `brand.json` into the
data folder, reload the page, and the product is yours. Nothing is rebuilt, nothing is
deployed, and no code changes.

```
<DATA_DIR>/
  brand.json          name, tagline, logos, colour overrides
  brand/              the image files brand.json refers to
    logo.svg
    logo-dark.svg
    favicon.png
```

In the sandbox `DATA_DIR` is `/data` in the container, which is `~/bitbob-data` in the `bitbob`
WSL distro. Running locally it is `./data`. Settings → Appearance shows what is in force.

## The file

Everything is optional; leave out what you don't want to change.

```json
{
  "name": "Northwind Agent",
  "tagline": "Private AI for the archive team",
  "logo": "logo.svg",
  "logoDark": "logo-dark.svg",
  "icon": "favicon.png",
  "mark": "NW",
  "tokens": {
    "light": { "accent": "#1c7ed6", "bg": "#faf7ef" },
    "dark": { "accent": "#f3c249", "accent-text": "#15150f" }
  }
}
```

| Field | What it does |
|---|---|
| `name` | Window title, sign-in screen, sidebar |
| `tagline` | One line under the name |
| `logo` | Image file in `brand/`, used everywhere a mark appears |
| `logoDark` | Alternative for dark surfaces. The sidebar is dark in both themes, so it uses this one there |
| `icon` | Browser tab icon. Falls back to `logo` |
| `mark` | 1–3 characters drawn on a tinted tile instead of BitBob's hard-hat mark, when there is no logo image |
| `tokens.light` / `tokens.dark` | Any of the design tokens below |

Images must sit directly in `brand/` (no subfolders) and be `.svg`, `.png`, `.jpg`,
`.webp` or `.ico`.

## Tokens

These are the CSS variables the whole UI is built from — the same names as in
`web/src/index.css`. Override one and everything that uses it follows.

| Group | Tokens |
|---|---|
| Surfaces | `bg` `bg-tint-1` `bg-tint-2` `panel` `panel-2` `code-bg` |
| Ink | `text` `text-2` `muted` `line` `line-2` `hover` |
| Accent | `accent` `accent-2` `accent-soft` `accent-text` `user` `user-text` |
| Sidebar | `side` `side-2` `side-text` `side-text-2` `side-muted` `side-line` `side-hover` `side-accent` `side-accent-text` |
| States | `ok` `bad` `warn` |
| Shape | `radius` `radius-sm` `radius-lg` `shadow` `shadow-lg` |
| Type | `font` `display` `serif` `mono` |

Two things worth knowing:

- **`accent-text` is the colour drawn *on* the accent**, so change it with `accent`. A dark
  accent wants white text; a yellow one wants near-black.
- **The sidebar is dark in both themes.** It re-declares the surface tokens for its own
  subtree from the `side-*` set, so it stays readable whatever you do to `bg` and `panel`.

Fonts are names, not files: `"font": "'Public Sans', sans-serif"`. To use a webfont the
browser doesn't have, add its stylesheet `<link>` to `web/index.html` (that part does need
a rebuild) or install the family on the machines that use the UI.

## What is not allowed

The values become CSS custom properties in the browser, so they are checked on the way out
of the server and again on the way in to the page:

- Unknown token names are dropped.
- A value containing `;` `{` `}` `<` `>` `\` or `url(`, `@import`, `expression(`,
  `javascript:` is dropped. It cannot break out of its declaration, load a remote resource,
  or phone home.
- `logo`, `logoDark` and `icon` must be plain filenames of allowed image types that exist
  in `brand/`. No paths, no traversal, nothing outside that folder.
- Brand assets are served with `Content-Security-Policy: default-src 'none'; sandbox`, so
  an SVG someone put there cannot run script on the app's origin.

A bad `brand.json` is logged as a warning in Activity and ignored: the UI keeps the last
good brand, or the built-in one.

## Checking it

```bash
curl -s http://localhost:8787/api/brand | jq
```

That endpoint is public (the sign-in screen has to render before anyone has a token), so
treat the name and logo as visible to anyone who can reach the server.
