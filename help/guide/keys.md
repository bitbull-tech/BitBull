## Keys and settings: `.env` or the UI
`.env` is the base. Keys and settings marked **Edit** in Settings can also be set from the UI:
the outside services (SayGM, Ditto, GitHub, Taostats, Atlas, 404, Hippius) under
**Integrations**, one card each with its live status; BitBull's own workings (default engine and
models, upload size, the vault, skills and subagents) under **Configuration**.
**Status** shows every service at a glance. They're saved on the server in `data/settings.local.json`
(mode 600, never in git), override `.env`, and apply immediately: no deploy or restart.
**Use .env** removes an override. Each value shows where it comes from: `.env`,
`set here` or `default`.

Access and sandbox settings (`APP_TOKEN`, `ALLOW_*`, `BITBULL_SANDBOX`, permissions, ports,
paths, proxy) and every service URL can only be changed in `.env` plus a deploy, so a browser
session can't lower the walls or redirect a key to another host. `settings.local.json` lives
in the data folder, which the agent's shell can write, so BitBull reads only the UI-editable keys
from it and ignores (and reports) anything else. The UI can't write your Windows `.env` (the
container can't see Windows, by design); copy a value there yourself if you want it to be the
long-term default.

BitBull's own credentials (SayGM, Ditto, Atlas, Hippius, `APP_TOKEN`) are blanked in every
shell the **OpenCode** engine starts, and any known key that turns up in a tool's output, a
reply, an export or the Ditto archive is replaced with `[REDACTED]`
([`agent/opencode-plugin/bitbull-guard.js`](https://github.com/bitbull-tech/BitBull/blob/main/agent/opencode-plugin/bitbull-guard.js) for OpenCode; the
server redacts again for both engines). Keys meant for the agent (`GITHUB_TOKEN`,
`TAOSTATS_API_KEY`, `FOUR04_MODEL_KEY`) stay available to it but are masked in output. The **Claude Agent SDK**
engine has no equivalent of bitbull-guard: its shell inherits the SayGM key, and only the server's
redaction stands between it and the chat. This all prevents accidental leaks; it isn't a hard
wall, because the shell runs as the same user as BitBull and can read the server's environment,
`APP_TOKEN` included, and with the token it can call BitBull's own API (approve its own domains,
change UI settings, read chats). That is GAPS.md item 11, the next structural fix: a separate
tool container with no secrets. Until then, treat BitBull as safe against a careless agent, not a
determined one, and use scoped keys where the service offers them.

The page itself is not a way round the proxy: a Content-Security-Policy lets the browser load
images, media and scripts only from BitBull, so a reply or brand file that points at
`https://evil/?<data>` is never fetched. Images in replies are shown as links.

## Keys: `.env` and the vault
`.env` is what the stack boots on; it never leaves the PC and is copied into the distro by
`deploy.ps1`. Keys you add later in **Settings → Config** go into the **vault**:
`vault.json` in BitBull's data folder, AES-256-GCM, encrypted with a key BitBull never stores.
The key is made once by the link helper on this PC and kept under `%LOCALAPPDATA%\BitBull\vault.key`,
protected with Windows DPAPI for your Windows user. When you open BitBull on this PC and click
**Unlock**, a Windows box from the link helper asks for your OK (any program on the PC can fake
a browser header, so handing the key out needs you present) and the page unlocks the vault on
the server (memory only); from a phone or another machine the vault stays locked and `.env`
applies. Why: `settings.local.json` is readable by the agent's shell (it shares the server's
user), so keys saved there were one prompt injection away from leaking; the vault file is
ciphertext to it. The first unlock moves any secrets still in `settings.local.json` into the
vault. Settings → Config shows the vault's state and a **Lock** / **Unlock from this PC**
button; rows show `vault` as their source. The vault is **at-rest** protection: while unlocked,
values live in server memory and engines are spawned without them in their environment — but
server and agent share a uid, so `/proc` is not a hard wall (see docs/THREAT-MODEL.md R1).
