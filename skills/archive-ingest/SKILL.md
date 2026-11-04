---
name: archive-ingest
description: Use when the user uploads old photos, film/video, letters, service records, logbooks or other documents for a family or historical project. Catalogues each item, extracts what it says with source bindings, and never invents facts.
---

# Archive ingest

Turns a pile of uploads into a structured, source-bound catalogue that the
`heritage-experience` skill builds from. The model's job here is "what does this
item say", never "what happened to this person".

## 1. Inventory
- Run the ingest tool first: `node /app/tools/ingest.mjs <inbox> --out archive` (inbox = `uploads/`, `uploads/inbox/`, or a linked folder such as `/links/bitbob-capture`; the tool path is `tools/ingest.mjs` relative to BitBob's root, use `ls /app/tools` if unsure). It copies each new file into `archive/items/<id>/`, de-duplicates by content, reads EXIF dates, OCRs images and PDFs, and writes `archive/manifest.md` with a "needs a look" list. Re-run it whenever the inbox grows; it only processes new files.
- Read `archive/manifest.md`. Work from `archive/items/<id>/original.*` and `text.txt`; never change files in the inbox (linked folders are read-only anyway).
- For anything the tool couldn't read (HEIC, video, audio, flagged items), record path, type, size, and for media the dimensions/duration yourself.
- Tools if installed (check with `which`/`where`): `exiftool` (dates, camera, GPS), `ffprobe` (video duration, fps), `pdftotext`/`pdfinfo`, `tesseract` (OCR). If one is missing, say so and continue with what you can read directly (you can read images and PDFs yourself).
- For video, extract a contact sheet so it can be described: `ffmpeg -i in.mp4 -vf "fps=1/5,scale=320:-1,tile=4x4" sheet.jpg`.

## 2. Extract
For each item write `catalogue/<item-id>.json`:
```json
{
  "id": "doc-003",
  "source": "archive/items/item-0003/original.jpg",
  "sha256": "from manifest.json",
  "kind": "service-record | photo | letter | logbook | newspaper | film | other",
  "transcription": "verbatim text, [illegible] where unreadable",
  "fields": [
    { "name": "service_number", "value": "26182", "evidence": "line 2: 'No. 26182'", "confidence": "high" }
  ],
  "people": ["Thomas Quintus Horner"],
  "places": ["RAF Cranwell"],
  "dates": [{ "value": "1930-12-19", "evidence": "'passed out 19.12.30'" }],
  "visual": "for photos/film: what is visibly shown, no identification guesses",
  "notes": "damage, conflicting readings, questions for the user"
}
```
- `text.txt` is OCR: quote it as evidence only after checking it against the image. Old typewriting and handwriting are misread often; a wrong service number is worse than "[illegible]".
- Every field carries the exact evidence it came from. If two readings conflict (e.g. two OCR passes, or two documents disagree), keep both and flag it. Don't pick one silently.
- Never identify a person in a photo by face. Only attach a name when a caption, the user, or a document says who it is.

## 3. Index
Write `catalogue/index.md`: a table of items (id, kind, date, people, one-line summary) plus a "conflicts and questions" section for the user to resolve.

## 4. Confirm
Show the user the index and the open questions. Their corrections overwrite extracted fields (record `"corrected_by": "user"`). Save durable confirmed facts to Ditto memory with the project name.
