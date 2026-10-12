---
name: verify-changes
description: Use after making code changes, before saying work is done. Finds and runs the project's own build, typecheck, lint and test commands and reports the results honestly.
---

# Verify changes

## Find the project's commands
Look in this order and use what the project already defines:
- `AGENTS.md` / `CLAUDE.md` / `README` "test" or "development" sections
- `package.json` scripts (`test`, `typecheck`, `lint`, `build`), `Makefile`, `justfile`, `Taskfile`
- `pyproject.toml` / `tox.ini` / `pytest.ini`, `Cargo.toml`, `go.mod`, `CMakeLists.txt` + `ctest`
- CI config (`.github/workflows/*.yml`): the commands CI runs are the ones that matter

## Run, narrowest first
1. Typecheck / compile the changed package.
2. Tests closest to the change (single file or pattern), then the wider suite if it's fast.
3. Lint/format check on changed files only.
4. Exercise the actual path you changed: run the script, hit the endpoint, load the page. For UI work, screenshot or describe what you saw.

## If something fails
- Read the full error. Decide whether your change caused it (`git stash` and re-run to compare when unsure).
- Fix failures you caused. For pre-existing failures, don't "fix" them silently: report them.
- Never weaken or delete a test to make it pass unless the test itself is wrong, and say so if you do.

## Report
State exactly what ran and the result, e.g. "typecheck clean, 42/42 unit tests pass, did not run e2e (needs browser)". If you couldn't verify something, say what and why.
