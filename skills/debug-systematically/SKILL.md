---
name: debug-systematically
description: Use when something is broken, crashing, hanging, returning wrong results or failing tests and the cause isn't obvious.
---

# Debug systematically

1. **Reproduce.** Get an exact, repeatable failing case: command, input, environment. Capture the full error and stack trace. If you can't reproduce it, gather logs before guessing.
2. **Read the evidence.** Read the stack trace bottom-up to the first frame in project code. Check logs around the timestamp. Note what changed recently (`git log -p --since=...`).
3. **Form hypotheses.** List 2–4 plausible causes, ranked by likelihood × ease of checking.
4. **Test one at a time.** Add targeted logging or a minimal script that isolates the suspect. Bisect when a regression has a known-good point (`git bisect`). Change one variable per experiment.
5. **Fix the cause, not the symptom.** No blanket try/catch, sleeps or retries to hide a bug unless the root cause is genuinely external.
6. **Prove it.** Re-run the reproduction, then the related tests. Add a regression test when the project has tests.
7. **Clean up** temporary logging and scripts.
8. **Explain** in two or three sentences: what broke, why, and how the fix addresses it.

Stop and report after three failed hypotheses rather than thrashing. Say what you ruled out and what you'd check next.
