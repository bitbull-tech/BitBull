/**
 * Talking to BitBull: speech in, speech out.
 *
 * Listening: the browser records you (WAV, 16 kHz mono) and posts it here; a Gemini model on SayGM
 * turns it into text (Gemini takes audio directly; SayGM has no dedicated speech models). The text
 * then goes to the chat's own model like anything you type.
 *
 * Speaking: Piper, a small open-source neural text-to-speech engine, runs inside this container.
 * Nothing leaves the machine, it costs nothing per word, and the browser gets plain WAV it can
 * play through whichever speaker you chose. The engine and the voices are baked into the image
 * from pinned, checksummed downloads (Dockerfile, voice/piper.sha256).
 *
 * See docs/VOICE.md.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "./config.js";
import { estimateCost, listModels, type ModelInfo } from "./models.js";
import { record } from "./activity.js";
import { DOG_PITCH, concat, dogify, laugh, readWav, splitLaughs, writeWav, type Pcm } from "./dogvoice.js";

/* ---------------- voices ---------------- */

export interface Voice {
  id: string;
  name: string;
  accent: "UK" | "US";
  gender: "female" | "male";
  /** the Piper model file (without .onnx) */
  model: string;
  /** for multi-speaker models */
  speaker?: number;
  /** licence of the recordings the voice was trained on */
  licence: string;
  /** a character voice built on top of the Piper voice (dogvoice.ts) */
  character?: "dog";
}

/**
 * Only voices whose training data allows any use, including commercial: LibriTTS (CC BY 4.0, many
 * speakers in one model) and OpenSLR 83 (CC BY-SA 4.0). Piper's other English voices from the same
 * release were left out on purpose: lessac and ryan are non-commercial, alan is all rights reserved.
 * The LibriTTS speakers were picked by pitch and pace from the first 200 (docs/VOICE.md).
 */
export const VOICES: Voice[] = [
  // BitBull himself: an original cartoon-dog character (dogvoice.ts), with his own laugh
  { id: "bitbull", name: "BitBull (cartoon dog)", accent: "US", gender: "male", model: "en-us-libritts-high", speaker: 54, licence: "CC BY 4.0 (LibriTTS), BitBull effects", character: "dog" },
  { id: "uk-female", name: "Southern English (UK)", accent: "UK", gender: "female", model: "en-gb-southern_english_female-low", licence: "CC BY-SA 4.0 (OpenSLR 83)" },
  { id: "us-female-warm", name: "Warm (US)", accent: "US", gender: "female", model: "en-us-libritts-high", speaker: 0, licence: "CC BY 4.0 (LibriTTS)" },
  { id: "us-female-clear", name: "Clear (US)", accent: "US", gender: "female", model: "en-us-libritts-high", speaker: 30, licence: "CC BY 4.0 (LibriTTS)" },
  { id: "us-female-bright", name: "Bright (US)", accent: "US", gender: "female", model: "en-us-libritts-high", speaker: 53, licence: "CC BY 4.0 (LibriTTS)" },
  { id: "us-male-deep", name: "Deep (US)", accent: "US", gender: "male", model: "en-us-libritts-high", speaker: 42, licence: "CC BY 4.0 (LibriTTS)" },
  { id: "us-male-calm", name: "Calm (US)", accent: "US", gender: "male", model: "en-us-libritts-high", speaker: 97, licence: "CC BY 4.0 (LibriTTS)" },
  { id: "us-male-steady", name: "Steady (US)", accent: "US", gender: "male", model: "en-us-libritts-high", speaker: 16, licence: "CC BY 4.0 (LibriTTS)" },
  { id: "us-male-bright", name: "Bright (US)", accent: "US", gender: "male", model: "en-us-libritts-high", speaker: 54, licence: "CC BY 4.0 (LibriTTS)" },
];

const piperDir = () => config.voice.piperDir;
const piperBin = () => path.join(piperDir(), "piper");
const modelFile = (v: Voice) => path.join(piperDir(), "voices", `${v.model}.onnx`);
export const voiceAvailable = (v: Voice) => existsSync(piperBin()) && existsSync(modelFile(v));

/* ---------------- listening ---------------- */

/**
 * The model that transcribes: VOICE_STT_MODEL if it is a Gemini model in the catalogue, otherwise
 * the cheapest Gemini "flash" SayGM lists. null when there is none (the browser's own speech
 * recognition is then the only way in).
 */
export function sttModel(models: ModelInfo[]): ModelInfo | null {
  const google = models.filter((m) => m.api === "google");
  const want = config.voice.sttModel;
  if (want) return google.find((m) => m.id === want) ?? null;
  const flash = google.filter((m) => /flash/i.test(m.id) && !/image|tts|live/i.test(m.id) && m.price);
  const price = (m: ModelInfo) => (m.price ? 3 * m.price.input + m.price.output : Infinity);
  return flash.sort((a, b) => price(a) - price(b) || a.id.localeCompare(b.id))[0] ?? null;
}

/** A RIFF/WAVE file, PCM, and not absurdly long. Checked before anything is sent anywhere. */
export function checkWav(buf: Buffer): { seconds: number } {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("Not a WAV recording");
  const rate = buf.readUInt32LE(24);
  const byteRate = buf.readUInt32LE(28);
  if (!rate || !byteRate || rate > 96_000) throw new Error("Unsupported recording format");
  const seconds = (buf.length - 44) / byteRate;
  if (seconds > config.voice.maxSeconds) throw new Error(`Recording longer than ${config.voice.maxSeconds}s`);
  return { seconds };
}

const PROMPT =
  "Transcribe the speech in this recording exactly, in the language spoken, with normal punctuation. " +
  "Reply with the words only: no quotes, no labels, no commentary. If there is no speech, reply with nothing.";

export function cleanTranscript(t: string): string {
  let s = t.replace(/\s+/g, " ").trim();
  s = s.replace(/^(transcript(ion)?|text)\s*:\s*/i, "");
  if (/^["“].*["”]$/.test(s)) s = s.slice(1, -1).trim();
  if (/^\[?(no speech|silence|inaudible)\]?\.?$/i.test(s)) return "";
  return s;
}

export async function transcribe(wav: Buffer): Promise<{ text: string; model: string; seconds: number; costUsd?: number }> {
  const { seconds } = checkWav(wav);
  const model = sttModel(await listModels());
  if (!model) throw new Error("No Gemini model on SayGM to transcribe with; set VOICE_STT_MODEL, or use the computer's speech recognition");
  if (!config.saygm.apiKey) throw new Error("SAYGM_API_KEY is not set");
  const res = await fetch(`${config.saygm.anthropicBaseUrl}/v1beta/models/${encodeURIComponent(model.id)}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": config.saygm.apiKey },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: PROMPT }, { inline_data: { mime_type: "audio/wav", data: wav.toString("base64") } }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 2048 },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Transcription failed (SayGM ${res.status}): ${body.slice(0, 200)}`);
  const j = JSON.parse(body) as any;
  const text = cleanTranscript((j.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join(""));
  const costUsd = await estimateCost(model.id, j.usageMetadata?.promptTokenCount ?? 0, j.usageMetadata?.candidatesTokenCount ?? 0);
  return { text, model: model.id, seconds, costUsd };
}

/* ---------------- speaking ---------------- */

/** Text Piper reads well: no control characters, sane length. The client already strips markdown. */
export function speakableText(t: string): string {
  return t
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, config.voice.maxChars);
}

let running = 0;
const waiting: Array<() => void> = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= 2) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

/** WAV for some text in one of the voices. Piper gets the text on stdin and argv only from fixed values. */
export async function speak(text: string, voiceId: string, speed = 1): Promise<Buffer> {
  const v = VOICES.find((x) => x.id === voiceId) ?? VOICES[0];
  if (!voiceAvailable(v)) throw new Error("Piper or its voices aren't in this image (deploy again to rebuild it)");
  const say = speakableText(text);
  if (!say) throw new Error("Nothing to say");
  const rate = Math.min(2, Math.max(0.5, Number(speed) || 1));
  if (v.character === "dog") return speakDog(say, v, rate);
  return slot(() => piper(say, v, 1 / rate));
}

/** BitBull's character voice: Piper a little faster, then made bigger and gruffer, laughing where the reply laughs. */
async function speakDog(say: string, v: Voice, rate: number): Promise<Buffer> {
  const parts: Pcm[] = [];
  let laughs = 0;
  for (const part of splitLaughs(say)) {
    if ("laugh" in part) {
      parts.push(laugh(22050, laughs++));
      continue;
    }
    const wav = await slot(() => piper(part.say, v, DOG_PITCH / rate));
    parts.push(dogify(readWav(wav)));
  }
  if (!parts.length) parts.push(laugh(22050)); // nothing but laughing
  return writeWav(concat(parts));
}

/** One run of Piper. `lengthScale` < 1 is faster. Text on stdin; argv only from fixed values. */
async function piper(say: string, v: Voice, lengthScale: number): Promise<Buffer> {
  const dir = mkdtempSync(path.join(tmpdir(), "bitbull-tts-"));
  const out = path.join(dir, "out.wav");
  try {
    const args = ["--model", modelFile(v), "--output_file", out, "--length_scale", lengthScale.toFixed(3), "--quiet"];
    if (v.speaker !== undefined) args.push("--speaker", String(v.speaker));
    await new Promise<void>((resolve, reject) => {
      const p = spawn(piperBin(), args, { stdio: ["pipe", "ignore", "pipe"], cwd: piperDir() });
      let err = "";
      p.stderr.on("data", (d) => (err = (err + d).slice(-500)));
      const timer = setTimeout(() => p.kill("SIGKILL"), 60_000);
      p.on("error", reject);
      p.on("close", (code) => {
        clearTimeout(timer);
        code === 0 ? resolve() : reject(new Error(`piper exited ${code}: ${err.trim()}`));
      });
      p.stdin.end(say);
    });
    return readFileSync(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ---------------- what the UI shows ---------------- */

export async function voiceStatus() {
  const stt = sttModel(await listModels());
  return {
    tts: { engine: "piper", available: existsSync(piperBin()), voices: VOICES.map((v) => ({ id: v.id, name: v.name, accent: v.accent, gender: v.gender, licence: v.licence, available: voiceAvailable(v) })) },
    stt: { model: stt?.id ?? null, price: stt?.price ?? null },
    limits: { maxSeconds: config.voice.maxSeconds, maxChars: config.voice.maxChars },
  };
}

export function logTranscription(r: { model: string; seconds: number; costUsd?: number }) {
  record({ level: "info", source: "saygm", message: `Voice: ${r.seconds.toFixed(1)}s transcribed by ${r.model}${r.costUsd ? ` · $${r.costUsd.toFixed(5)}` : ""}` });
}
