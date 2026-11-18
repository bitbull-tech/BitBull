---
name: cathedral-sandbox
description: Use when the user asks to run or check code, a repo, files or a folder they don't trust or were given, in a Cathedral confidential sandbox away from their keys, workspace and network. Only in projects where the owner switched Cathedral on. Uses BitBull's cathedral_* tools; BitBull holds the key and asks the owner before every sandbox.
---

# Cathedral confidential sandboxes

A Cathedral confidential sandbox is a small room on an AMD SEV-SNP machine, away from the owner's computer. Its job here is one thing: running and checking code, repos, files and folders the owner doesn't trust or was given. It costs money by the second until deleted.

Confidential means the code runs in memory encrypted by AMD SEV-SNP, and each receipt proves it from the chip. Protection is what AMD SEV-SNP provides at the firmware version named in the receipt. It does not cover the way in: commands and files pass Cathedral's API in plaintext on their way to the room. Never send secrets, keys, tokens or private files.

## The tools

BitBull holds the Cathedral key and makes every call. You have tools, not a key:

- `cathedral_quote`: sizes, the hourly rate and the hold for a lifetime. Creates nothing.
- `cathedral_create`: asks the owner (a card with size, rate, lifetime, spend cap, internet on or off) and waits for their answer. Not available in scheduled runs or from Telegram.
- `cathedral_exec` (up to 45 s), `cathedral_exec_start` and `cathedral_exec_wait` (up to 30 min).
- `cathedral_upload`: one file from this project's workspace, named by its path, to `/work/...`. Never `.env` files or anything under `.git`. Every upload is logged for the owner with its path, size and SHA-256.
- `cathedral_download`: one file from `/work/...` back into the workspace.
- `cathedral_status`, `cathedral_list`, `cathedral_receipts`, `cathedral_verify`, `cathedral_delete`.

## Rules

- Use Cathedral only when the user asks for it, or agrees after you suggest it for untrusted code.
- Pass `internet: true` to create only if the user asked for internet in this task. The default is a closed network.
- Upload only the files the task needs, each by name. Never secrets.
- Give every create, exec and upload an `op` name (a-z, 0-9), new for each step. Calling again with the same op never runs it twice, so reuse it to retry.
- Delete the sandbox when you are done. You can only touch sandboxes this project created.
- If the owner says no, or a limit refuses the create, tell the user. Do not look for a way around it.

## When something goes wrong

- An upload whose answer was lost says "upload outcome unknown". Call `cathedral_upload` again with `check: true`: it only reads the path back and compares, and never uploads. Ask the user before sending again.
- `lost` from `cathedral_exec_wait` means the outcome is unknown: the command may or may not have run.
- The room limit (`sealed_room_limit_reached`), or sold out: say so plainly and offer to try later.

## What receipts mean

Say what they prove and what they do not, as `cathedral_verify` reports it.

- Room receipts are signed by a key held by the host's guest, which that host's AMD SEV-SNP attestation report commits to.
- `cathedral_verify` does not check the AMD report and AMD's certificate chain, the approved build, or receipts cut from the end of the chain. For that, the owner runs Cathedral's offline verifier (`ctcli receipt verify`) on the sandbox's evidence bundle.
