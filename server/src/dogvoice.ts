/**
 * BitBull's own character voice: a big, gruff, good-natured cartoon dog with a huffing chuckle.
 *
 * It is an original character, not an impression of anyone: a LibriTTS speaker from Piper, made
 * bigger (pitch and formants lowered together, so it sounds like a larger animal rather than a
 * slowed tape), given some gravel (a fast flutter and soft saturation) and a little bounce. The
 * laugh is synthesised here from scratch (no recording), so there is nothing to license.
 *
 * Everything works on 16-bit mono PCM; Piper writes plain WAV.
 */

export interface Pcm {
  rate: number;
  samples: Float32Array;
}

/** Plain PCM WAV → floats. Only what Piper writes (16-bit, mono). */
export function readWav(buf: Buffer): Pcm {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("Not a WAV");
  let off = 12;
  let rate = 0;
  let bits = 0;
  let channels = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      channels = buf.readUInt16LE(body + 2);
      rate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === "data") {
      if (bits !== 16 || channels !== 1) throw new Error("Only 16-bit mono WAV");
      const n = Math.floor(Math.min(size, buf.length - body) / 2);
      const samples = new Float32Array(n);
      for (let i = 0; i < n; i++) samples[i] = buf.readInt16LE(body + i * 2) / 32768;
      return { rate, samples };
    }
    off = body + size + (size & 1);
  }
  throw new Error("WAV has no data");
}

export function writeWav({ rate, samples }: Pcm): Buffer {
  const out = Buffer.alloc(44 + samples.length * 2);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + samples.length * 2, 4);
  out.write("WAVE", 8, "ascii");
  out.write("fmt ", 12, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    out.writeInt16LE(Math.round(v < 0 ? v * 32768 : v * 32767), 44 + i * 2);
  }
  return out;
}

/** How much lower (and bigger) BitBull's voice is. Piper speaks this much faster first so the pace comes out normal. */
export const DOG_PITCH = 0.8;

/** Stretch by 1/factor with interpolation: pitch and formants × factor, length ÷ factor. */
function resample(x: Float32Array, factor: number): Float32Array {
  const n = Math.floor(x.length / factor);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * factor;
    const a = Math.floor(p);
    const t = p - a;
    y[i] = (x[a] ?? 0) * (1 - t) + (x[a + 1] ?? 0) * t;
  }
  return y;
}

/** Gravel: a fast flutter (like a purr in the throat) and gentle saturation, plus a little bass weight. */
function growl(x: Float32Array, rate: number, depth = 0.22): Float32Array {
  const y = new Float32Array(x.length);
  const drive = 1.8;
  const norm = Math.tanh(drive);
  let low = 0;
  const k = 1 - Math.exp((-2 * Math.PI * 180) / rate); // one-pole low-pass at ~180 Hz
  for (let i = 0; i < x.length; i++) {
    const t = i / rate;
    // two incommensurate flutters so it doesn't sound like a machine
    const flutter = 1 - depth * (0.5 + 0.5 * Math.sin(2 * Math.PI * 31 * t)) * (0.75 + 0.25 * Math.sin(2 * Math.PI * 4.3 * t));
    let v = x[i] * flutter;
    low += k * (v - low);
    v = v + 0.35 * low;
    y[i] = Math.tanh(v * drive) / norm;
  }
  return y;
}

/** Piper's output, made into BitBull. Piper must have been run `DOG_PITCH` times faster. */
export function dogify(pcm: Pcm): Pcm {
  const big = resample(pcm.samples, DOG_PITCH);
  return { rate: pcm.rate, samples: normalise(growl(big, pcm.rate)) };
}

/** One-pole high-pass: no rumble or DC. */
function highpass(x: Float32Array, rate: number, hz: number): Float32Array {
  const a = Math.exp((-2 * Math.PI * hz) / rate);
  const y = new Float32Array(x.length);
  let px = 0;
  let py = 0;
  for (let i = 0; i < x.length; i++) {
    py = a * (py + x[i] - px);
    px = x[i];
    y[i] = py;
  }
  return y;
}

function normalise(x: Float32Array, peak = 0.89): Float32Array {
  let m = 0;
  for (const v of x) m = Math.max(m, Math.abs(v));
  if (m < 1e-6) return x;
  const g = peak / m;
  return x.map((v) => v * g);
}

/** Deterministic noise, so the same laugh comes out every time (and tests can compare). */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000) * 2 - 1;
}

/**
 * BitBull's laugh: a breathy, huffing chuckle, "hnh-hnh-hnh-hnh-hahh", built from a voice source
 * through vowel resonances plus breath noise. `variant` changes the count and pitch a little so
 * two laughs in one reply aren't identical.
 */
export function laugh(rate: number, variant = 0): Pcm {
  const r = rng(1234 + variant * 77);
  const bursts = 4 + (variant % 2);
  const out: number[] = [];
  const f0Base = 128 + (variant % 3) * 8;
  // vowel resonances (Hz, bandwidth Hz): an open, throaty "uh/ah"
  const formants = [
    [620, 110],
    [1150, 140],
    [2500, 220],
  ];
  const gainAt = (f: number) => formants.reduce((g, [fc, bw]) => g + 1 / (1 + ((f - fc) / (bw / 2)) ** 2), 0.04);
  for (let b = 0; b < bursts; b++) {
    const last = b === bursts - 1;
    const dur = last ? 0.24 : 0.105 - b * 0.006;
    const gap = last ? 0 : 0.055 + r() * 0.012;
    const n = Math.floor(dur * rate);
    // each huff starts a touch higher and falls; the run as a whole drifts down
    const start = f0Base * (1.18 - b * 0.05);
    let phase = 0;
    // breath: white noise band-passed to roughly 500 Hz to 3 kHz (difference of two low-passes)
    let lpHi = 0;
    let lpLo = 0;
    const kHi = 1 - Math.exp((-2 * Math.PI * 3000) / rate);
    const kLo = 1 - Math.exp((-2 * Math.PI * 500) / rate);
    const voiced = new Float32Array(n);
    const breath = new Float32Array(n);
    let vPeak = 1e-9;
    let bPeak = 1e-9;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const f0 = start * (1 - 0.22 * t);
      phase += f0 / rate;
      let v = 0;
      for (let k = 1; k * f0 < 3400; k++) v += (gainAt(k * f0) / Math.sqrt(k)) * Math.sin(2 * Math.PI * k * phase);
      const w = r();
      lpHi += kHi * (w - lpHi);
      lpLo += kLo * (w - lpLo);
      voiced[i] = v;
      breath[i] = lpHi - lpLo;
      vPeak = Math.max(vPeak, Math.abs(v));
      bPeak = Math.max(bPeak, Math.abs(breath[i]));
    }
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const attack = Math.min(1, i / (0.012 * rate));
      const env = attack * Math.exp(-t * (last ? 3.2 : 4.5));
      // mostly voice at the start of each huff, more breath as it trails off
      const voicing = last ? 0.7 - 0.45 * t : 0.85 - 0.4 * t;
      out.push(env * (voicing * (voiced[i] / vPeak) + (1 - voicing) * 0.8 * (breath[i] / bPeak)));
    }
    for (let i = 0; i < Math.floor(gap * rate); i++) out.push(0);
  }
  // a short pause after, so the words don't run straight on
  for (let i = 0; i < Math.floor(0.12 * rate); i++) out.push(0);
  const samples = highpass(Float32Array.from(out), rate, 70);
  return { rate, samples: normalise(growl(samples, rate, 0.12), 0.7) };
}

/** Laughter written in a reply, which BitBull laughs instead of reading out. */
export const LAUGH_RE = /\b(?:a?(?:ha){2,}h?|(?:ha+h?\s){1,3}ha+h?|(?:he){2,}h?|lo+l|lmao|rofl)\b|😂|🤣|😆|\*(?:laughs?|chuckles?)\*|\((?:laughs?|chuckles?)\)/gi;

/** What's left either side of a laugh, without the punctuation that belonged to it. */
const tidy = (t: string) => t.replace(/^[\s,.;:!?-]+/, "").trim();

/** Split text into what is said and where to laugh. */
export function splitLaughs(text: string): Array<{ say: string } | { laugh: true }> {
  const parts: Array<{ say: string } | { laugh: true }> = [];
  let last = 0;
  for (const m of text.matchAll(LAUGH_RE)) {
    const before = tidy(text.slice(last, m.index));
    if (before) parts.push({ say: before });
    if (!(parts.at(-1) && "laugh" in parts.at(-1)!)) parts.push({ laugh: true }); // "haha lol" is one laugh
    last = m.index! + m[0].length;
  }
  const rest = tidy(text.slice(last));
  if (rest && /[a-z0-9]/i.test(rest)) parts.push({ say: rest });
  return parts;
}

export function concat(parts: Pcm[]): Pcm {
  const rate = parts[0]?.rate ?? 22050;
  const same = parts.map((p) => (p.rate === rate ? p.samples : resample(p.samples, p.rate / rate)));
  const samples = new Float32Array(same.reduce((a, x) => a + x.length, 0));
  let o = 0;
  for (const x of same) samples.set(x, o), (o += x.length);
  return { rate, samples };
}
