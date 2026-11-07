# Capture: getting undigitised documents, photos and books into BitBull

Decided with Tom, 28 Oct 2026. Phones (iPhone, Android, other people's) are the capture
devices. Files go into a **shared cloud folder now** (nothing to build, scanning starts this
week) and into **BitBull directly later** (a phone capture page with per-device tokens, the proper
home). Either way the pile lands in a project workspace as `archive/` via `tools/ingest.mjs`,
and the `archive-ingest` skill catalogues it from there.

## 1. Capturing well

| Material | Use | Why |
|---|---|---|
| Letters, records, loose pages | **Microsoft Lens** (iOS/Android, free) or **Adobe Scan**; on iPhone the scanner in Files/Notes also works | Edge detection, de-skew, multi-page PDF, far better than a raw camera photo |
| Bound books | **vFlat Scan** | Flattens the page curve; a cheap phone stand keeps every page the same |
| Photographs that will be restored or animated | A flatbed scanner on the PC, 600 dpi TIFF or top-quality JPEG; phone as a first pass only | Phone shots add glare, perspective and compression that restoration can't undo |
| Photo albums you can't take apart | Phone, in **Lens → Photo mode**, daylight, no flash | Good enough to catalogue; mark for a proper scan later |
| Film, tapes | Not a phone job: a transfer service or a film scanner | BitBull takes the resulting video files like any other upload |

Habits that save work later: one item per scan; back of a photo scanned too when it has
writing; a short note (who/where/when, if known) added as the file name or in the same
folder; keep the originals where they are, the scans are copies.

## 2. Now: one shared cloud folder

1. Pick the cloud you already pay for: **OneDrive** (works on iPhone, Android and the PC, and
   Lens saves straight into it), iCloud Drive (Apple-only) or Google Drive.
2. Make a folder, e.g. `BitBull Capture`, with one subfolder per person scanning or per batch
   (`Horner letters - Tom`, `Album 2 - Mum`). Share it with each helper **edit** rights on the
   subfolder they'll use, not the whole folder.
3. On each phone: install the cloud app and the scanner app; point the scanner's save location
   at that subfolder. Lens and Adobe Scan both offer OneDrive/Google Drive as a save target.
4. On the PC: the cloud app syncs the folder (set it to keep files on this device). Then in BitBull:
   folder button → **Link a folder from this PC…** → choose `BitBull Capture`. A live link follows
   the folder as it syncs, read-only, so the agent can't change or delete anyone's scans.
5. In a project chat: "Ingest /links/bitbull-capture into this project's archive". The agent runs
   `tools/ingest.mjs`, which copies each new file into `archive/items/`, de-duplicates, pulls
   dates from the image, OCRs it, and writes `archive/manifest.md`. Re-run as the folder grows;
   only new files are processed.

Trust in this route comes from the cloud account: a helper is one share you can revoke, the
cloud keeps version history if someone deletes by mistake, and the link into BitBull is read-only.
The cost is that the scans pass through Microsoft/Apple/Google and the PC must be on to sync.

## 3. Later: straight into BitBull from the phone

Builds on the client plan (docs/CLIENTS.md Phase 1 + 4A). Order of work:

1. **Per-device tokens** (CLIENTS Phase 1), with one addition: a token carries **scopes**.
   A phone gets `capture:<project id>` only: it can `POST /api/projects/:id/inbox` and nothing
   else, so a lost phone can add files to one inbox but never read a chat, change a setting or
   delete anything. Pairing by QR from the desktop; Settings → Devices lists them with
   last-seen and revoke.
2. **HTTPS in front of BitBull** via a Cloudflare Tunnel (no port opened on the router) with
   Cloudflare Access in front for anyone outside the house. BitBull itself still only listens on
   127.0.0.1; the tunnel connector is the only thing exposed.
3. **A capture page** (`/capture`, part of the same web bundle, installable as a PWA): camera
   or file picker, the phone's own document scanner where the browser offers it, a queue that
   survives a closed app, resumable chunked upload for big files, and a note field per batch.
   It needs the device token and nothing else.
4. **Inbox handling in BitBull**: `POST /api/projects/:id/inbox` writes to `uploads/inbox/<device>/`,
   records sha256 + device + time in the activity log, and the usual Hippius mirror picks it up
   (encrypted, indexed in Ditto). The inbox is untrusted input: ingest treats its contents as
   data, never instructions (the agent is already told this for linked folders).
5. Then **ingest** runs exactly as in route 1, on `uploads/inbox` instead of a link.

Why not phones → Hippius directly: an S3 upload needs a native app or an awkward web flow, and
the files would sit unencrypted in the bucket unless the phone held the encryption key, which
it shouldn't. BitBull in the middle keeps one encryption key, one audit trail and one index.

## 4. What ingest produces (`tools/ingest.mjs`)

```
archive/
  manifest.json      every item: id, sha256, kind, bytes, captured (EXIF), camera, size/pages,
                     where it was seen (all duplicates), text file, flags
  manifest.md        the same as a table, plus a "needs a look" list
  items/item-0001/
    original.jpg     the scan, copied (the inbox is never changed)
    text.txt         OCR / embedded text: evidence to check, not fact
```

`node tools/ingest.mjs <inbox> [--out archive] [--lang eng] [--no-ocr] [--dry-run]`. Safe to
re-run; duplicates (same content under another name or from another phone) are recorded once.
HEIC photos from iPhones aren't OCR'd until converted (set the phone's camera to "Most
compatible", or Lens saves JPEG/PDF anyway).

The `archive-ingest` skill then reads `manifest.md` and does the judgement work: what each
item says, with evidence, and what to ask the user. OCR text is a source to quote, never a
fact to state; the grounding rule from the heritage framework applies.
