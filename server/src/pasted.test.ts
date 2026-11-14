/**
 * Long pasted text travels as an attachment: the model must still get the words, the owner must
 * be able to open it again, and searching chats must find it.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "bitbull-pasted-"));
process.env.DITTO_ARCHIVE = "off";
process.env.DITTO_API_KEY = "";
process.env.SQLITE_JOURNAL = "DELETE";
const { messages, sessions } = await import("./db.js");
const { engines } = await import("./agent.js");
const { collectTurn, startTurn } = await import("./turns.js");
const P = await import("./pasted.js");
type AgentEvent = import("./engines/types.js").AgentEvent;

test("which attachments are pasted text", () => {
  assert.ok(P.isPastedPath("uploads/ab12cd34/pasted-text.txt"));
  assert.ok(P.isPastedPath("uploads/ab12cd34/pasted-text-3.txt"));
  assert.ok(!P.isPastedPath("uploads/ab12cd34/notes.txt"));
  assert.ok(!P.isPastedPath("uploads/ab12cd34/sub/pasted-text.txt"));
  assert.ok(!P.isPastedPath("links/x/pasted-text.txt"));
  assert.ok(P.isPastedName("pasted-text-12.txt") && !P.isPastedName("my-pasted-text.txt"));
});

test("the model gets the pasted words in its prompt; the chat keeps only the short message", async () => {
  const s = sessions.create({ engine: "opencode", model: "m" });
  const pasted = "ERROR 1234 in module alpha\n".repeat(200) + "the needle is a zebra-crossing\n~~~~ a fence inside the paste ~~~~\n";
  const rel = `uploads/${s.id.slice(0, 8)}/pasted-text.txt`;
  P.rememberPasted(s.id, rel, pasted);
  assert.equal(P.pastedContent(s.id, rel), pasted);
  assert.equal(P.pastedContent(s.id, "uploads/other/pasted-text.txt"), undefined);
  assert.equal(P.pastedContent("another-chat", rel), undefined, "one chat can't read another's paste");

  let got = "";
  engines.opencode = {
    id: "opencode",
    label: "Fake",
    async *run(input: { prompt: string }) {
      got = input.prompt;
      yield { type: "text", delta: "read it" } as AgentEvent;
      yield { type: "done", engineSessionId: "e" } as AgentEvent;
    },
  } as unknown as (typeof engines)["opencode"];
  await collectTurn(startTurn(s, { prompt: "What went wrong here?", model: "m", attachments: [rel] }).turnId);
  assert.ok(got.startsWith("What went wrong here?"));
  assert.ok(got.includes("the needle is a zebra-crossing"), "the pasted text is in the prompt");
  assert.ok(got.includes("~~~~~\n"), "fenced with a fence longer than any in the paste");
  const saved = messages.list(s.id).find((m) => m.role === "user")!;
  assert.ok(!saved.content.includes("zebra-crossing"), "the conversation shows the message, not the paste");

  // found by searching chats, in the paste and in messages; LIKE wildcards are literal
  const hit = P.searchChats("ZEBRA-crossing");
  assert.deepEqual(hit.map((h) => [h.sessionId, h.where]), [[s.id, "pasted"]]);
  assert.match(hit[0].snippet, /needle is a zebra-crossing/);
  assert.deepEqual(P.searchChats("went wrong").map((h) => h.where), ["message"]);
  assert.deepEqual(P.searchChats("100%_sure"), []);
  assert.deepEqual(P.searchChats("z"), [], "one letter is not a search");
});

test("a very long paste is pointed to rather than put in the prompt, and a deleted chat takes its paste with it", () => {
  const s = sessions.create({ engine: "opencode", model: "m" });
  const rel = `uploads/${s.id.slice(0, 8)}/pasted-text.txt`;
  P.rememberPasted(s.id, rel, "x".repeat(P.PASTE_INLINE_CHARS + 10));
  const note = P.pastedNote(s.id, [rel, "uploads/zz/other.pdf"]);
  assert.match(note, /too long to include here; read it from uploads\//);
  assert.ok(note.length < 400);
  assert.equal(P.pastedNote(s.id, ["uploads/zz/other.pdf"]), "");
  sessions.delete(s.id);
  assert.equal(P.pastedContent(s.id, rel), undefined);
});
