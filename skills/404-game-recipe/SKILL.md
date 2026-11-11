---
name: 404-game-recipe
description: Use when the user wants 3D objects or a 3D game built with 404 (Bittensor subnet 17), mentions the 404 game recipe or the 404 game jam, or asks for game assets as Three.js code. Covers cloning the public recipe, generating and verifying assets, the jam gate, and submitting an entry.
---

# 404: 3D as code

404 makes every 3D object a JavaScript module that returns a Three.js `Group`: no mesh files, no
downloads, so you can read, edit and place assets like any other code. There is **no 404 key and
no 404 MCP**. Everything comes from public repositories:

- [404-Repo/404-game-recipe](https://github.com/404-Repo/404-game-recipe): the method, the
  harness (verifier, wrapper, playtest, jam gate) and an example game.
- [404-Repo/404-game-jam](https://github.com/404-Repo/404-game-jam): jam rules and where entries
  land (one pull request per entry).
- [404-Repo/404-active-competition](https://github.com/404-Repo/404-active-competition): the live
  generation competition; `leader.json` names the current best open model.

## Set up (once per project)

```bash
git clone https://github.com/404-Repo/404-game-recipe
cd 404-game-recipe
npm install          # puppeteer uses the image's Chromium (PUPPETEER_EXECUTABLE_PATH); nothing is downloaded
npm run selftest     # proves the verifier actually catches broken assets
```

Read, in this order: `docs/traps.md` (silent failures, read first), `404.md` (making assets) or
`GAME.md` (making a game), `docs/asset-contract.md`, `docs/verify-loop.md`, `docs/style-lock.md`.
The recipe is the authority: where this skill and its files differ, follow the files.

## Making an asset

1. **Lock the style first** for the whole set: one style sentence, the palette as hex, real sizes
   (template in `docs/style-lock.md`; write yours in the project, not in the clone).
2. **A reference image per object.** Picture beats description by a wide margin. Use Atlas (the
   `atlas-studio` skill) when it is configured, a photo the owner gives you, or, failing both,
   describe the object as *form, not function*: shape, parts, proportion, count.
3. **Three independent attempts** per object, different construction strategies: primitives;
   profiles (`ExtrudeGeometry`/`LatheGeometry`); a different part breakdown. Each to the contract.
   - Optional, open model: if `FOUR04_MODEL_URL` is set, the owner's RunPod pod serves 404's
     competition-winning model (OpenAI-compatible, key in `FOUR04_MODEL_KEY`). One request per
     reference image ("Write a Three.js module reproducing this object as `export default function
     generate(THREE)`. Code only."), **always stream**, three or more samples at temperature 0.6,
     then `node harness/wrap.mjs <out.js> <real height m> -o assets/<name>.js`. The pod bills by the
     hour: tell the owner when you're done so they can stop it.
4. **Verify by looking:** `node harness/verify.mjs <assets dir>` renders every asset from four
   sides. Open the renders, compare with the reference, keep the best attempt, send the rest back.

## Making a game

Follow `GAME.md`: the prompt there, a harsh blind critic loop with sub-agents, every object from
the steps above. Write a gate for *your* game (`docs/gates.md`); `harness/playtest.mjs` only
exercises games you walk or drive forward through.

## The jam gate and submitting

- `node harness/jam.mjs https://<owner>.github.io/<game>/game/ --commit=<sha>` checks the live game
  on a phone viewport over 4G with a real tap: ready in time, under 10 MB, starts and moves, under
  900 draw calls and 1.5M triangles, no 404s, no console errors. It needs the deployed site; ask
  for network access to that host if it is blocked.
- Hard rule: **every 3D object is Three.js code written through the recipe**. No downloaded or
  hand-made meshes, no vertex arrays or base64 smuggled in (`harness/ship.mjs` flags them).
  Textures, skies, sound and music may be files, declared in the entry.
- Submit: fork 404-Repo/404-game-jam, add `entries/<slug>.json` from `entries/_template.json`, open
  a pull request with the verdict block pasted unedited. This goes through the owner's GitHub
  account: confirm with them before opening it.
- Never copy assets or code from 404's reference games into an entry; reading them is fine.
