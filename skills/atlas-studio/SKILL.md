---
name: atlas-studio
description: Use when generating images, cinematic video, 3D models, rigging or animation through Atlas AI Studio (atlas.design), or when the user mentions Atlas, Higgsfield, Seedance, Grok Imagine or Tripo.
---

# Atlas AI Studio

Atlas is a node-graph studio. Two ways in from this agent:

## A. Atlas MCP tools (when the project has Atlas enabled)
Tools appear as `atlas_*` (OpenCode) or `mcp__atlas__*` (Claude engine). Start with `whoami` to confirm the workspace.
- **Projects**: list, inspect, create, clone, share Atlas projects.
- **Platform agent**: a one-shot turn that builds or edits a node graph from a natural-language request (e.g. "image → 3D → rig → UE5 export"). Turns are stateless and, in the current alpha, the agent can build graphs but can't run nodes.
- **Exported APIs**: export a project as an API, list, rename, enable or disable it.

## B. Running a workflow (exported API)
1. In Atlas, open the workflow → export as API, and save the JSON spec into the folder in `$ATLAS_WORKFLOWS_DIR` (shown in BitBull Settings → Configuration). The spec contains credentials: never print it, copy it into the project, or commit it.
2. List what's available: `node "$BITBULL_TOOLS/atlas-run.mjs" --list`
3. Inspect inputs: `node "$BITBULL_TOOLS/atlas-run.mjs" <name> --inspect`
4. Run: `node "$BITBULL_TOOLS/atlas-run.mjs" <name> --in prompt="..." --in duration=6 --file image=uploads/abc/photo.jpg --out experience/assets/shot-03`
   It uploads files, starts the async job, polls, and downloads every output into `--out`.

## Picking nodes (Release 0.38)
- **Cinematic video**: Higgsfield Cinema Studio 4.0 (4–30 s, 480p/720p, era/genre/lighting/lens/camera-movement controls, up to 30 image refs) for reconstructions; Grok Imagine Video 1.5 (1–15 s, up to 1080p, native audio, 1–7 reference images) for short clips; Seedance Reference to Video to combine image/video/audio references.
- **Photo → motion**: Simple Text + Image → Video (start/end frame control). Respect the likeness policy: under ground-only, animate scenes and objects, not real people's faces.
- **Restoration**: Upscale Video for low-res archival film (resolution only; it doesn't repair damage or colourise).
- **Images**: FLUX 3 Image (up to 4K, reference images, optional web grounding).
- **3D**: Image → 3D (Tripo 3.5 texturing), then Atlas Pre-Rig Humanoid Mesh → Rig Finalize → Apply Mixamo Animation for characters; exports UE5-ready meshes and GLB.

## Cost
Atlas charges credits per node run (see the Node Prices page). Quote the expected cost and get the user's go-ahead before batches; draft at low resolution first.
