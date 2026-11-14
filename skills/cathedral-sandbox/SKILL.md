---
name: cathedral-sandbox
description: Use when the user asks to run code in a Cathedral sealed sandbox, or agrees to it when you suggest it for untrusted code, unvetted dependencies or long jobs they want off their computer. Runs everything through the helper tools/cathedral.mjs, which enforces the spend limit and a closed network.
---

# Cathedral sealed sandboxes

A Cathedral sandbox is an isolated room on an AMD SEV-SNP machine, away from the user's computer. It costs money by the second until deleted, and everything you put in it leaves this machine.

## Rules

- Use Cathedral only when the user asks for it, or agrees after you suggest it.
- Run every Cathedral call through the helper: `node "$BITBULL_TOOLS/cathedral.mjs" <command> ...`. Never call the API with curl or code.
- Before `create`, tell the user the size, the hourly rate, the lifetime, the spend limit and whether it has internet. Wait for a yes.
- Use `--internet` only if the user asked for internet in this task. The default is a closed network (`deny_all`).
- Never move the user's secrets or private files into a sandbox unless the user names them.
- Delete only sandboxes this task created, by id. Never delete another one without the user's yes.
- Never print, repeat or store the Cathedral key. The helper reads it from its environment.

## Names for every step

Every command that changes something needs `--task <tag>` and `--op <name>`.

- Run `new-task` once per task and keep the tag in your replies. Losing it is harmless: run `new-task` again.
- Pick a new `--op` name for each step (`create`, `exec1`, `putreadme`). Use only `a-z` and `0-9`.
- Running the same command again with the same `--task`, `--op` and arguments never runs it twice: Cathedral treats it as the same operation. Reusing an op name with different arguments is an error.

## Steps

1. `new-task` prints the tag.
2. `account` shows the key's scopes, cap and what is left. `catalog` shows sizes, rates and network modes.
3. `quote --size sealed-1x2 --lifetime 300` prints the hold (`hold_usd`) at today's rate.
4. Tell the user and wait for a yes. Then `create --task T --op create --size sealed-1x2 --lifetime 300 --max-spend <hold_usd>`. The helper refuses a spend above the user's limit or above what the key has left. It refuses a key with no cap unless the user turned that on.
5. Work: `exec <id> --task T --op exec1 --cmd '<shell string>'` (up to 45 s), or `exec-bg <id> --task T --op bg1 --timeout 600 --cmd '...'` then `exec-wait <id> --exec <exec_id>` for longer jobs (at most 1800 s). `put <id> --task T --op putfile --src local --path /root/x` and `get <id> --path /root/x --out local` move files (200 MiB at most).
6. `delete <id> --task T --op del` when done. It waits until the sandbox is deleted and prints the final receipt head.
7. `receipts <id>` and `verify <id>` show the receipt chain.

## When something goes wrong

- A command that gave up after retries can be run again with the same names: same key, same body, so it still runs at most once. After a restart, `list --task T` finds the task's sandboxes, and `create ... --resume` with the same arguments resumes a create.
- `put` is never retried automatically. If its answer is lost it says "upload outcome unknown". Run it again with `--check` to read the path back. If the path holds different bytes or is missing, the upload may still have landed and been changed since: ask the user before uploading again over it. Re-sending is a new `put` under a new `--op`.
- `lost` from `exec-wait` means the outcome is unknown: the command may or may not have run.
- If a create says the key has no cap, or a spend is above the limit, tell the user. Do not look for a way around it.
- The room limit (`sealed_room_limit_reached`) means the account already has its live rooms. Tell the user; do not delete other sandboxes to make room.
- Sold out or unavailable: say so plainly and offer to try later.

## What receipts mean

Say what they prove and what they do not, as `verify` prints it.

- Proved by the check: each Cathedral receipt is signed and linked to the one before, and room receipts are signed by the key the host named.
- Not checked here: the AMD SEV-SNP report and AMD's certificate chain, the approved build, completeness of room receipts, and receipts cut from the end of the chain.
- For an independent check offline, Cathedral publishes a dependency-free verifier at https://cathedral.computer/console/verify-receipts.mjs. Pin its key from https://cathedral.computer/customer-receipt-trusted-keys.json, not from the API answer.
