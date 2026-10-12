---
name: heritage-experience
description: Use when building a historical or family-heritage experience (cinematic short, documentary sequence, interactive scene or game level) from a project's uploaded records, photos and film. Enforces the grounding rule and the likeness policy.
---

# Heritage experience

Builds experiences from the catalogue produced by `archive-ingest`. Run that
first if `catalogue/index.md` doesn't exist.

## Invariants (enforced by you, every time)
1. **Grounding.** No sentence, caption, title card or narration line about a named person is allowed unless every proper noun, date and place in it appears in a catalogued source. Keep a `bindings` list mapping each output element to catalogue ids. Anything unbound is cut, or rewritten as general period context that names no individual.
2. **Likeness policy.** Read it from the system prompt (ground-only or private-likeness) and follow it exactly. Under ground-only: real people appear only through their original images (Ken Burns, parallax, restoration of the scan). Generative video/3D is for the world around them: aircraft, ships, airfields, weather, period streets, crowds without identifiable real people.
3. **Never synthesise the voice of a named individual.** Narration is a neutral narrator, or the user's own recorded voice.
4. **Label** every generated asset as AI-generated in the experience's credits and file metadata, and keep a sources panel listing the catalogue items used.

## Pipeline
1. **Brief**: agree with the user the format (60–120 s cinematic, chaptered documentary, playable scene), audience (private family, wider share) and the story beats. Save it to `experience/brief.md`.
2. **Beat sheet**: `experience/beats.json`. Each beat has narration text, on-screen text, visual plan, and `bindings` (catalogue ids). Run the grounding check yourself and list any unbound element. Fix them before generating anything.
3. **Shot list**: per beat, choose the treatment:
   - *Archival*: original photo/scan with Ken Burns or parallax, or restored/upscaled original film.
   - *Reconstruction*: generated environment or craft (e.g. "Saro London flying boat taxiing into Gibraltar harbour at dusk, 1940"), via Atlas (`atlas-studio` skill). Era, lens and lighting controls belong here.
   - *3D asset*: vehicles, aircraft, props for interactive scenes via Atlas Image → 3D, or 404—GEN when configured.
4. **Generate** reconstruction shots and 3D assets; save outputs under `experience/assets/` with a sidecar `.json` recording prompt, model/node, references used and bindings.
5. **Assemble**: cinematic → an edit decision list (`experience/edl.json`) and, if `ffmpeg` is available, a rough cut with title cards. Interactive → a scene manifest for the game engine (GLB assets, positions, triggers, captions with bindings).
6. **Check & hand over**: re-run the grounding check over the final narration and captions, list every generated asset with its label, and show the sources panel.

## Cost
Before any batch of generations, estimate credits/cost and ask the user to confirm. Prefer short drafts (480p/720p, 4–6 s) until the user approves a look, then render finals.
