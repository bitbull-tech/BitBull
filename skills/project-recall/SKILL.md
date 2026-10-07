---
name: project-recall
description: Use when the user asks to pick up, resume, summarise or "catch me up on" a project, person or past decision. Pulls the full picture from Ditto memory before answering.
---

# Project recall

1. Identify the subject (project, person, topic). If ambiguous, search broadly first.
2. Call `search_subjects` with the subject name; if a matching subject exists, call
   `search_memories_in_subjects` for it. Otherwise call `search_memories` with 2–3
   phrasings of the question.
3. Fetch full text (`fetch_memories`) only for the 3–8 most relevant ids.
4. Answer with:
   - **Where things stand** — current state in 2–4 sentences.
   - **Key decisions** — bullet list, each with its date if known.
   - **Open threads** — what was left undecided or in progress.
5. If memory contradicts itself, say which is newer and ask which is right; update the
   stale memory once the user confirms.
