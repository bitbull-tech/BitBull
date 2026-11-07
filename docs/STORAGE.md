# Storage: Hippius

Built, 14 Oct 2026. Everything you upload is mirrored, encrypted, to
[Hippius](https://hippius.com) (decentralised S3 on Bittensor), recorded locally, and
indexed in Ditto so you can find it again by what it is.

**Hippius holds the bytes, Ditto holds what they are.** Ditto is a memory store with no
blob storage, so it can't hold photos or film; Hippius has no idea what a file depicts. For
every stored file BitBull saves a short Ditto memory (project, filename, key, size, SHA-256), so
"find the photo of Grandad's squadron" searches Ditto and gets back a Hippius key.

## Why BitBull holds the only credential

The console only scopes a sub-token to a **bucket** (Object Read Only or Object Read &
Write, across all buckets or named ones), and there is no IAM, no STS/AssumeRole and no
usable bucket policy — one public-read statement is all `PutBucketPolicy` accepts.

The **Management API goes further** than the console: `POST /api/objectstore/sub-tokens/`
takes `scope_type` (`single_bucket` | `multi_bucket` | `global`), `bucket_names`,
`actions`, **`allowed_prefixes`**, `ip_allowlist` and an expiry, and the gateway validates
the scope (a bad one comes back as `502 s3-scope-sync-failed`). So prefix-scoped
credentials *are* possible — just not from the console UI.
`tools/hippius-setup.mjs --prefix` uses this.

BitBull still holds the only credential, for reasons that don't depend on that:

- Files are encrypted before upload, so a prefix-scoped key handed to someone else gives
  them ciphertext. Access without the encryption key is meaningless, and handing out the
  encryption key is forever.
- A sub-token can't be scoped per *person* without one token per person to issue, rotate
  and revoke — which is an access-control system, and BitBull already has the database for one.
- Sharing wants a link, not a credential (see below).

So: one sub-token, one bucket, prefixes per project, and **no user ever gets a Hippius
credential**. When multi-user arrives, a user's access is a row in BitBull's own database — the
storage layer doesn't change. Prefix-scoped sub-tokens stay available as defence in depth,
or for a tenant who genuinely needs to point their own S3 client at their own folder.

When you do need to hand someone a link, it will be a BitBull link (`/s/<token>`), not a
presigned URL. Not built yet, and deliberately: a BitBull link can be revoked the moment you
change your mind, has no 7-day ceiling, is logged, and can cover a whole folder. A Hippius
presigned URL is one object, dies after 7 days, can't be revoked early except by killing
the sub-token, and would hand over ciphertext anyway.

## The layout

```
hippius://bitbull-agent/
  <project-slug>-<id>/uploads/<chat>/photo.jpg     one prefix per project
  general/uploads/…                                chats outside a project
```

The prefix is a project's workspace folder, so it never contains a chat id or anything else
that moves. That's what a future per-user grant will be written in terms of.

## What happens on upload

```
you attach a file, or add one through Files
   │
   ▼
it lands in the workspace (the agent works on local files, as before)
   │
   └─ background queue, in BitBull's own process, never in the agent's shell
        ├─ AES-256-GCM, streamed, key from HIPPIUS_ENCRYPTION_KEY
        ├─ PUT to the bucket under <project>/<path>
        ├─ row in `stored_files` (key, plaintext size, sha256, status)
        └─ Ditto memory: what it is, where it is, its checksum
```

- **Encrypted before it leaves the machine.** Hippius encrypts at rest with per-bucket keys,
  but its docs don't say who can read a chunk on a storage miner, and these are family
  photographs. The object is `GMS1` + 12-byte nonce + ciphertext + 16-byte tag; a tampered
  or truncated object fails to decrypt rather than returning rubbish.
- **In the background, with retries** (2s, 15s, 60s). An upload never slows down the UI or a
  turn. Anything still pending after a restart is picked up again at boot.
- **The SHA-256 is of the plaintext**, so a restore that matches proves the whole round trip.
- **Never the agent's job.** `bitbull-guard` blanks `HIPPIUS_*` in the agent's shell and redacts
  the values from tool output. The agent cannot reach the bucket, by design.

## Restoring

Files → the "Backed up on Hippius" list → **Restore**. It pulls the object back, decrypts
it, writes it into the workspace and checks it against the stored checksum, saying plainly
whether it matched. A failed upload shows **Try again** with the error on hover.

## Settings

Either `.env` or the UI (Settings → Integrations → Hippius storage), with `.env` as the
base and the UI overriding it live — no restart, no deploy. Each row shows where its value
came from: `.env`, `set here` or `default`.

| Setting | |
|---|---|
| `HIPPIUS_ACCESS_KEY` / `HIPPIUS_SECRET_KEY` | The sub-token. Console → S3 Buckets → Sub Tokens → Object Read & Write, this bucket only |
| `HIPPIUS_BUCKET` | Default `bitbull-agent`. Create it in the console first |
| `HIPPIUS_ENCRYPTION_KEY` | 32 bytes, base64 or hex. **Keep a copy somewhere else** |
| `STORAGE_MIRROR` | `uploads` (default) or `off` |
| `HIPPIUS_S3_ENDPOINT` / `HIPPIUS_REGION` | `https://s3.hippius.com`, `decentralized` |
| `STORAGE_MAX_FILE_MB` | Skip anything larger (default 2048; a single PUT must fit in one request) |

`s3.hippius.com` is on the egress allowlist. Settings → Status shows the connection, the
number of files stored, and anything queued or failed.

### The encryption key

It is not like the other settings. Lose it and every stored file is permanently unreadable;
change it and everything already stored is orphaned (still there, no longer decryptable).
BitBull validates the length when you save it, but it cannot tell you that you've changed it to
the wrong 32 bytes. Generate one in Settings, write it down somewhere that isn't this
machine, and don't rotate it casually.

## Onboarding

The console section is called **Object Store** (the docs call it "S3 Buckets", which is not
what the navigation says). If you can't find it, or would rather not click through it, the
Management API does the whole thing:

```bash
# Hippius Console -> Settings -> account access token (NOT an S3 access key)
export HIPPIUS_CONSOLE_TOKEN=…
node tools/hippius-setup.mjs --doctor          # what exists, and what to do about it
node tools/hippius-setup.mjs                   # create the bucket + a scoped sub-token
```

It prints the access key and secret once for pasting into BitBull. With `--save` and
`BITBULL_APP_TOKEN` set it writes them into BitBull's settings directly and never prints the secret.
`--prefix general/` restricts the sub-token to one key prefix, and `--bitbull` points it at a
different BitBull (e.g. the test stack on 8788).

**Your seed phrase is not part of this.** It signs into the Hippius console, and that is
the only place it belongs — the API's mnemonic route is a challenge/signature flow for
their own front end, not something to script. Log in there once, take an access token, and
use that.

**Lost the secret for a key you already have?** There is no way to read it back: Hippius
shows it once, and `/objectstore/tokens/auth/` is validator-only. Either create a new
sub-token (run the tool with no flags) or rotate the old one, which mints a new secret and
revokes the old — anything still using it stops working:

```bash
node tools/hippius-setup.mjs --rotate <token-id-or-access-key>
```

Then, either way:

1. BitBull → Settings → Integrations → **Hippius storage**: check the access key and bucket.
2. **Encryption key → Generate**, copy it somewhere that isn't this machine, Save.
3. Settings → Status → "Hippius storage" should go green and name the bucket.
4. Attach a file to a chat, then open Files: it should show a green dot. Restore it to prove
   the round trip.

## Not supported by Hippius, so not used here

Versioning beyond `Enabled`, lifecycle rules (accepted but never applied, so nothing
expires on its own), CORS configuration, `DeleteBucketPolicy`, and IAM-style policies.
Multipart upload is supported and is the next thing to add if files start exceeding what a
single PUT can carry.
