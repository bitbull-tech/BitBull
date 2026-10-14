# Storage: Hippius

Built, 14 Oct 2026. Everything you upload is mirrored, encrypted, to
[Hippius](https://hippius.com) (decentralised S3 on Bittensor), recorded locally, and
indexed in Ditto so you can find it again by what it is.

**Hippius holds the bytes, Ditto holds what they are.** Ditto is a memory store with no
blob storage, so it can't hold photos or film; Hippius has no idea what a file depicts. For
every stored file GM saves a short Ditto memory (project, filename, key, size, SHA-256), so
"find the photo of Grandad's squadron" searches Ditto and gets back a Hippius key.

## Why GM holds the only credential

This is the fact that decides the design: **Hippius sub-tokens scope to a bucket, not a
folder.** They are Object Read Only or Object Read & Write, across all buckets or named
ones. There is no IAM, no STS/AssumeRole and no prefix policy; bucket policies accept
exactly one statement (public-read) and nothing else.

So a per-folder credential does not exist, and folder isolation can only be enforced by
whoever holds the key. GM holds one sub-token, scoped to one bucket, and **no user ever
gets a Hippius credential**. When multi-user arrives, a user's access is a row in GM's own
database — the storage layer doesn't change at all.

When you do need to hand someone a link, it will be a GM link (`/s/<token>`), not a
presigned URL. Not built yet, and deliberately: a GM link can be revoked the moment you
change your mind, has no 7-day ceiling, is logged, and can cover a whole folder. A Hippius
presigned URL is one object, dies after 7 days, can't be revoked early except by killing
the sub-token, and would hand over ciphertext anyway.

## The layout

```
hippius://gm-agent/
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
   └─ background queue, in GM's own process, never in the agent's shell
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
- **Never the agent's job.** `gm-guard` blanks `HIPPIUS_*` in the agent's shell and redacts
  the values from tool output. The agent cannot reach the bucket, by design.

## Restoring

Files → the "Backed up on Hippius" list → **Restore**. It pulls the object back, decrypts
it, writes it into the workspace and checks it against the stored checksum, saying plainly
whether it matched. A failed upload shows **Try again** with the error on hover.

## Settings

Either `.env` or the UI (Settings → Configuration → Hippius storage), with `.env` as the
base and the UI overriding it live — no restart, no deploy. Each row shows where its value
came from: `.env`, `set here` or `default`.

| Setting | |
|---|---|
| `HIPPIUS_ACCESS_KEY` / `HIPPIUS_SECRET_KEY` | The sub-token. Console → S3 Buckets → Sub Tokens → Object Read & Write, this bucket only |
| `HIPPIUS_BUCKET` | Default `gm-agent`. Create it in the console first |
| `HIPPIUS_ENCRYPTION_KEY` | 32 bytes, base64 or hex. **Keep a copy somewhere else** |
| `STORAGE_MIRROR` | `uploads` (default) or `off` |
| `HIPPIUS_S3_ENDPOINT` / `HIPPIUS_REGION` | `https://s3.hippius.com`, `decentralized` |
| `STORAGE_MAX_FILE_MB` | Skip anything larger (default 2048; a single PUT must fit in one request) |

`s3.hippius.com` is on the egress allowlist. Settings → Status shows the connection, the
number of files stored, and anything queued or failed.

### The encryption key

It is not like the other settings. Lose it and every stored file is permanently unreadable;
change it and everything already stored is orphaned (still there, no longer decryptable).
GM validates the length when you save it, but it cannot tell you that you've changed it to
the wrong 32 bytes. Generate one in Settings, write it down somewhere that isn't this
machine, and don't rotate it casually.

## Onboarding checklist

1. Hippius console → create the bucket (`gm-agent`).
2. S3 Buckets → Sub Tokens → new token, **Object Read & Write**, limited to that bucket.
   Copy the secret: it is shown once.
3. GM → Settings → Configuration → Hippius storage → paste the access key and secret, set
   the bucket.
4. Generate an encryption key, save it, and **back it up somewhere else**.
5. Settings → Status → "Hippius storage" should go green and name the bucket.
6. Attach a file to a chat, then open Files: it should show a green dot. Restore it to prove
   the round trip.

## Not supported by Hippius, so not used here

Versioning beyond `Enabled`, lifecycle rules (accepted but never applied, so nothing
expires on its own), CORS configuration, `DeleteBucketPolicy`, and IAM-style policies.
Multipart upload is supported and is the next thing to add if files start exceeding what a
single PUT can carry.
