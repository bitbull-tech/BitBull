import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "bitbull-voice-"));
process.env.APP_TOKEN = "test-token";
// a real Piper to speak with, when one is around (CI: set BITBULL_TEST_PIPER to its folder)
if (process.env.BITBULL_TEST_PIPER) process.env.PIPER_DIR = process.env.BITBULL_TEST_PIPER;

const { VOICES, checkWav, cleanTranscript, speak, speakableText, sttModel, voiceAvailable } = await import("./voice.js");
type ModelInfo = import("./models.js").ModelInfo;

function wav(seconds: number, rate = 16000): Buffer {
  const data = Buffer.alloc(Math.round(seconds * rate) * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

test("recordings are checked before they go anywhere", () => {
  assert.equal(checkWav(wav(2)).seconds, 2);
  assert.throws(() => checkWav(Buffer.from("not audio at all, not even close to a wav header")), /Not a WAV/);
  assert.throws(() => checkWav(wav(121)), /longer than 120s/);
});

test("transcripts lose the wrapping models like to add", () => {
  assert.equal(cleanTranscript('  "Open the egress log."  '), "Open the egress log.");
  assert.equal(cleanTranscript("Transcription: what's on today?"), "what's on today?");
  assert.equal(cleanTranscript("[no speech]"), "");
  assert.equal(cleanTranscript("Silence."), "");
  assert.equal(speakableText("a\u0007b\n\n  c"), "a b c");
});

test("the listening model is the cheapest Gemini flash unless one is chosen", () => {
  const m = (id: string, api: ModelInfo["api"], input: number): ModelInfo => ({ id, name: id, family: "google", api, price: { input, output: input * 4 } });
  const models = [m("gemini-3.8-pro", "google", 2), m("gemini-3.5-flash", "google", 0.3), m("gemini-3.8-flash", "google", 0.1), m("gemini-flash-image", "google", 0.01), m("gpt-flash", "chat", 0.01)];
  assert.equal(sttModel(models)?.id, "gemini-3.8-flash");
  assert.equal(sttModel([m("claude", "anthropic", 1)]), null);
});

test("every voice is in the catalogue once, from allowed recordings", () => {
  assert.equal(new Set(VOICES.map((v) => v.id)).size, VOICES.length);
  for (const v of VOICES) assert.match(v.licence, /^CC BY/);
});

test("Piper speaks, when it is here", { skip: !process.env.BITBULL_TEST_PIPER || !existsSync(process.env.BITBULL_TEST_PIPER) }, async () => {
  for (const v of [VOICES[0], VOICES[4]]) {
    assert.ok(voiceAvailable(v));
    const out = await speak("Hello, I am BitBull.", v.id, 1.2);
    assert.equal(out.toString("ascii", 0, 4), "RIFF");
    assert.ok(checkWav(out).seconds > 0.5);
  }
  await assert.rejects(() => speak("   ", VOICES[0].id), /Nothing to say/);
});
