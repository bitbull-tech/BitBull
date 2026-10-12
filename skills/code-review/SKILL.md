---
name: code-review
description: Use when asked to review code, a diff, a branch or a pull request, or before committing a large change. Produces verified findings ranked by severity.
---

# Code review

## Scope
- Diff against the base: `git diff <base>...HEAD` (or `git diff` for uncommitted work, `gh pr diff <n>` for a PR).
- Read enough surrounding code to understand each change; reviews based on the diff alone miss most real bugs.

## Look for, in priority order
1. **Correctness**: logic errors, off-by-one, null/undefined paths, wrong async handling, race conditions, error paths that swallow failures.
2. **Security**: injection (SQL, shell, path traversal), secrets in code/logs, missing auth checks, unsafe deserialisation, SSRF, overly broad CORS/permissions.
3. **Data safety**: migrations that lose data, destructive operations without guards.
4. **Behaviour changes** callers don't expect; API contract breaks.
5. **Tests**: is the new behaviour covered? Do tests assert the right thing?
6. **Maintainability**: duplication, unclear names, dead code. Only raise style issues the project's own conventions call for.

## Verify before reporting
For each candidate finding, check it's real: trace the code path, or write a quick reproduction. Drop anything you can't substantiate.

## Output
A ranked list. For each: file:line, one-sentence problem, a concrete failure scenario (inputs → wrong result), and a suggested fix. End with an overall verdict (ship / ship with fixes / needs rework). Don't pad with praise or nitpicks.
