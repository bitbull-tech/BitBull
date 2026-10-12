---
name: coding-workflow
description: Use for any request to write, change, fix or refactor code. The default explore → plan → implement → verify loop, with minimal diffs and a todo list for multi-step work.
---

# Coding workflow

Work the way a careful senior engineer does in an unfamiliar codebase.

## 1. Explore before editing
- Find the relevant code first: `glob` for file names, `grep` for symbols and strings, then `read` the files you will touch and their callers.
- Read project conventions: `AGENTS.md`, `CLAUDE.md`, `README*`, `package.json` / `pyproject.toml` / `CMakeLists.txt`, lint and format configs.
- For broad searches across many files, hand the search to a subagent (explore / general) and keep only its conclusion.

## 2. Plan
- For anything beyond a one-file change, write a todo list (`todowrite` / TodoWrite) with concrete steps and keep it updated: exactly one item in progress, mark items done as soon as they are.
- If the request is ambiguous in a way that changes the implementation, ask one focused question before editing. Otherwise state your assumption and proceed.

## 3. Implement
- Make the smallest change that fully solves the problem. Match the surrounding style, naming and patterns; don't reformat untouched code.
- Prefer `edit` (exact replacement) over rewriting whole files. Never paste a file's contents back from memory.
- Don't add dependencies, abstractions or config without a reason you can state.
- Keep secrets out of code and logs.

## 4. Verify
- Follow the `verify-changes` skill: build, typecheck, lint and run the relevant tests. Run the code path you changed when practical.
- If something fails, fix it or report it plainly. Never claim tests pass without running them.

## 5. Report
- Summarise what changed and why in a few lines, list files touched, and say what you verified and what you couldn't.
- Mention follow-ups you noticed but didn't do.
