---
name: git-workflow
description: Use when committing, branching, opening pull requests, resolving merge conflicts or cloning a repository into a project workspace.
---

# Git workflow

## Cloning
- Clone into the current project workspace: `git clone <url> <name>` and work inside that folder.
- After cloning, follow `repo-onboarding` before making changes.

## Before changing anything
- `git status` and `git branch --show-current`. Never work directly on `main`/`master` for non-trivial changes: `git switch -c <type>/<short-desc>` (feat/, fix/, chore/, docs/).
- Note uncommitted changes that aren't yours; don't sweep them into your commit.

## Committing
- Commit only when the user asks, or when the task explicitly includes it.
- Stage specific files (`git add <paths>`), not `git add -A`, unless every change is yours.
- Message: imperative summary under 72 characters, blank line, then the why. Example: `Fix SSE stream closing early on tool errors`.
- Run the checks from `verify-changes` before committing.

## Pull requests
- Use `gh` if it's installed and authenticated (`gh auth status`). `gh pr create --title ... --body ...` with: what changed, why, how it was tested, and anything reviewers should look at.
- If `gh` isn't available, push the branch and give the user the compare URL.

## Never without explicit permission
- `git push --force`, `git reset --hard`, `git clean -fd`, rewriting published history, deleting branches, or changing git config.
- Committing files that look like secrets (`.env`, keys, tokens, `*.pem`). If one is staged, unstage it and tell the user.

## Conflicts
- Read both sides, resolve to preserve both intents, run the tests, and explain each non-obvious resolution.

## Before a PR
Run the `verify-changes` skill, then `ditto_review` (BitBull's MCP tool, mode `base` with the
branch's base, e.g. `main`) for an independent review of everything on the branch; address or
answer its findings in the PR description.
