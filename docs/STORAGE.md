# Storage: adding Hippius

Status: proposal, not built yet.

## The question

Should GM reach [Hippius](https://hippius.com) (decentralised storage on Bittensor) directly
from the container, or through Ditto?

## Recommendation

**Directly, from the GM server process, with Ditto as the index.**

- Ditto is a memory store: its MCP tools save, search and link *text* memories. It has no
  file or blob storage, so it can't hold photos, film or documents. Routing bytes through it
  isn't an option.
- Hippius has an S3-compatible API (`https://s3.hippius.com`, region `decentralized`,
  path-style addressing, SigV4). Multipart uploads to about 5 TiB, range reads and
  presigned GET/PUT URLs up to 7 days are supported. Versioning, CORS config, event
  notifications and Object Lock config are not.
- So the split is: **Hippius holds the bytes, Ditto holds what they are.** For every stored
  file, GM saves a short Ditto memory (project, filename, what it shows, source, Hippius key,
  SHA-256). Asking "find the photo of Grandad's squadron" searches Ditto and gets back the
  Hippius key.

## Design

```
upload (chat / Files dialog / agent output)
   │
   ▼
gm-agent server ── writes to the local workspace (the agent works on local files)
   │
   ├─ background: encrypt (AES-256-GCM, key in .env) → PUT to Hippius bucket
   │       key: <project-slug>/<path>   metadata: sha256, content-type, original name
   ├─ record in agent.db: local path ↔ Hippius key, sha256, size, uploaded_at
   └─ Ditto memory: "File <name> in <project>: <description>. Stored at hippius:<key>"
```

- **Server, not the agent's shell.** The upload is done by GM's Node process with the AWS S3
  SDK, so it can be retried, logged in Activity and shown in the Files dialog
  ("stored on Hippius ✓").
- **Scoped key.** Use a Hippius *sub-token* limited to GM's bucket ("Object Read & Write"),
  never the account master key. That bounds the damage if the container's environment ever
  leaks (the agent's shell can currently read it; see GAPS.md item 11).
- **Encrypt before upload.** Hippius encrypts at rest with per-bucket keys, but its docs don't
  say who can read data on the storage miners. Family photos and documents should be encrypted
  client-side, with the key only in `.env` and backed up separately.
- **Restore.** A "Restore from Hippius" action (and an agent tool) pulls files back into a
  workspace by key, verifying the SHA-256, so a fresh install or a parallel build can be
  rebuilt from storage.
- **Network.** Add `s3.hippius.com` to `egress/allowlist.txt`.

## Settings it will add

```
HIPPIUS_S3_ENDPOINT=https://s3.hippius.com
HIPPIUS_ACCESS_KEY=        # sub-token, GM bucket only, Object Read & Write
HIPPIUS_SECRET_KEY=
HIPPIUS_BUCKET=gm-agent
HIPPIUS_ENCRYPTION_KEY=    # 32 bytes, base64; keep a copy outside GM
STORAGE_MIRROR=uploads     # off | uploads | all (uploads + agent output)
```
