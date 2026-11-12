# Compatibility checks and update prompts

BitBull depends on two services it does not control: **SayGM** (models) and **Ditto** (memory,
Ditto Router models, tools, provider keys). When one of them changes what BitBull relies on, or
says it will, the owner is told in the UI, before chats start failing where possible.

A banner above the chat shows up to three notices, most serious first. Each can be dismissed on
that computer; it comes back only if the notice changes. Every new notice is also written to
Activity (source `compat`). `GET /api/compat` returns them; `?refresh=1` checks again now.
The server checks 20 seconds after it starts and every six hours (server/src/compat.ts).

## What is checked

| Check | What it catches | Level |
| --- | --- | --- |
| SayGM `/models` | The list is no longer `{ data: [{ id, api_shapes … }] }` | breaking |
| | Models no longer say which API they speak (`api_shapes`), so BitBull guesses from names | warn |
| | `DEFAULT_MODEL` or `SMALL_MODEL` is no longer offered | warn |
| | The SayGM key is rejected (401) | warn |
| Ditto Router `/models` (with a Router key) | The list, or the endpoint's own `ditto` block (memory and tool settings), is gone: plan mode and the "don't archive twice" rule depend on it | breaking |
| | A `ditto-router/…` default model is no longer on the endpoint | warn |
| | The endpoint key is rejected (401) | warn |
| Ditto Router `/mcp` (when Ditto tools are on) | The tool catalog is no longer `{ servers: […] }` | breaking |
| Ditto price catalog (with a Router key) | The account key has lapsed (a Connect sign-in lasts three months): **Reconnect Ditto** | warn |
| | The price list changed format, so costs and budgets can't cover Router models | warn |
| Any of the above | `Deprecation`, `Sunset` or `Warning` response headers | warn |
| `compat.json` on BitBull's `main` | Notices a maintainer has published (below) | as published |
| Latest commit on `main` | A newer BitBull than this build | info |

A gateway that is simply unreachable is not a notice: outages show in Activity and the status line.
The check for a newer build needs `build-info.json`, which the deploy scripts write; a plain
`docker compose build` reports "unknown" and skips it.

## Publishing a notice (maintainers)

When SayGM or Ditto announces a change, add an entry to `compat.json` in the repo root and push
to `main`. Every install picks it up within six hours:

```json
{
  "notices": [
    {
      "id": "saygm-2027-03-v2",
      "level": "breaking",
      "source": "saygm",
      "title": "SayGM switches off its v1 API on 1 March 2027",
      "detail": "BitBull builds from before 14 February 2027 will stop loading models. Update now.",
      "fixedIn": "2027-02-14T00:00:00Z"
    }
  ]
}
```

- `level`: `info`, `warn` or `breaking`. `source`: `saygm`, `ditto` or `bitbull`.
- `fixedIn` (optional, ISO date): the notice disappears on builds committed on or after that
  date, and until then carries a **How to update** button. Leave it out for a notice everyone
  should see until you remove it.
- At most 20 notices; title up to 140 characters, detail up to 600, plain text only.

A fork or white-labelled build publishes its own: set `COMPAT_NOTICES_URL` and `COMPAT_LATEST_URL`
in `.env` to its repo's `compat.json` and commits API URL (`off` disables either).

Notices are third-party data to the server: typed, trimmed, capped and shown as plain text. They
cannot change settings or run anything. They are fetched from `raw.githubusercontent.com` and
the latest commit from `api.github.com`, both already on the egress allowlist; nothing about the
install is sent beyond an ordinary request.

## When you add a dependency on a gateway

If new code reads a field from SayGM or Ditto that BitBull cannot work without, add a check for it
in `compat.ts` (a pure function over the response, tested in `compat.test.ts`) so its removal is
reported rather than discovered.
