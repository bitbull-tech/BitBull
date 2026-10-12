---
name: repo-onboarding
description: Use when starting work in a repository or project folder for the first time, or when asked to explain how a codebase works. Builds a map of the code and records it in AGENTS.md.
---

# Repo onboarding

1. **Survey**: top-level tree (2 levels), languages, package managers, entry points, test layout, CI config, Docker/infra files.
2. **Read**: README, existing `AGENTS.md`/`CLAUDE.md`, the main entry point, and one representative module end to end.
3. **Run**: install dependencies and the test or build command once, so you know the baseline (what passes, what's already broken).
4. **Record**: create or update `AGENTS.md` at the repo root (both engines read it; `CLAUDE.md` can just say "See AGENTS.md"). Keep it under ~80 lines:
   - What the project is, in two sentences
   - How to install, build, run, test (exact commands)
   - Directory map with one line per important folder
   - Conventions (style, naming, error handling, commit format)
   - Gotchas discovered (env vars, slow tests, flaky areas)
5. **Save to memory**: one concise Ditto memory per durable fact the user would want later (e.g. "Roadwolf builds with CMake + raylib on Windows; run build.bat"), tagged with the project name.

Don't rewrite an existing AGENTS.md wholesale: add or correct sections and mention what you changed.
