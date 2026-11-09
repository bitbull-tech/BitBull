/**
 * The microphone: one open stream, a level for meters, and two ways to take speech from it.
 *
 *   record() / stop()   push-to-talk: everything between the two
 *   listen()            hands-free: notices when you start talking and when you have finished
 *                       (a quiet gap of `silenceMs`), and hands over each utterance
 *
 * Audio leaves as 16 kHz mono 16-bit WAV, which every transcription model takes and which is
 * small enough (32 kB a second) to post as is. Echo cancellation is on, so BitBull's own voice
 * coming out of the speakers is mostly not heard as you talking over it.
 */

const TARGET_RATE = 16000

export interface ListenOptions {
  silenceMs: number
  /** you started talking (used to stop BitBull speaking over you) */
  onSpeechStart?: () => void
  /** one finished utterance */
  onUtterance: (wav: Blob, seconds: number) => void
  /** a sound too short to be speech (a cough, a click) was dropped */
  onDiscard?: () => void
}

export class Mic {
  private ctx: AudioContext
  private stream: MediaStream
  private proc: ScriptProcessorNode
  private src: MediaStreamAudioSourceNode
  private frames: Float32Array[] = []
  private mode: 'idle' | 'record' | 'listen' = 'idle'
  private listenOpts: ListenOptions | null = null
  // hands-free state
  private floor = 0.004
  private speaking = false
  private loudRun = 0
  private quietMs = 0
  private preroll: Float32Array[] = []
  /** while BitBull itself is talking, ask for clearly louder speech before calling it you */
  boost = false
  /** 0..1, for meters */
  level = 0
  onLevel?: (level: number) => void

  private constructor(stream: MediaStream) {
    this.stream = stream
    this.ctx = new AudioContext()
    this.src = this.ctx.createMediaStreamSource(stream)
    // ScriptProcessor is deprecated but runs everywhere BitBull does (Chrome, Edge/WebView2,
    // Safari/WKWebView) without a separate worklet file
    this.proc = this.ctx.createScriptProcessor(2048, 1, 1)
    this.proc.onaudioprocess = (e) => this.onFrame(e.inputBuffer.getChannelData(0))
    this.src.connect(this.proc)
    this.proc.connect(this.ctx.destination) // required for onaudioprocess to fire; it outputs silence
  }

  static async open(deviceId?: string): Promise<Mic> {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser has no microphone access (it needs https or localhost).')
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    })
    const mic = new Mic(stream)
    if (mic.ctx.state === 'suspended') await mic.ctx.resume().catch(() => {})
    return mic
  }

  get open() {
    return this.ctx.state !== 'closed'
  }

  record() {
    this.frames = []
    this.mode = 'record'
  }

  /** End push-to-talk: the recording as WAV (null if it was too short to be speech). */
  stop(): { wav: Blob; seconds: number } | null {
    const frames = this.frames
    this.frames = []
    this.mode = 'idle'
    const n = frames.reduce((a, f) => a + f.length, 0)
    const seconds = n / this.ctx.sampleRate
    if (seconds < 0.3) return null
    return { wav: encodeWav(frames, this.ctx.sampleRate), seconds }
  }

  listen(opts: ListenOptions) {
    this.listenOpts = opts
    this.mode = 'listen'
    this.speaking = false
    this.loudRun = 0
    this.quietMs = 0
    this.frames = []
  }

  pause() {
    this.mode = 'idle'
    this.speaking = false
    this.frames = []
  }

  close() {
    this.mode = 'idle'
    try {
      this.proc.disconnect()
      this.src.disconnect()
    } catch {
      /* already */
    }
    this.stream.getTracks().forEach((t) => t.stop())
    void this.ctx.close().catch(() => {})
  }

  private onFrame(input: Float32Array) {
    const f = new Float32Array(input) // the buffer is reused by the browser
    let sum = 0
    for (let i = 0; i < f.length; i++) sum += f[i] * f[i]
    const rms = Math.sqrt(sum / f.length)
    this.level = Math.min(1, rms * 12)
    this.onLevel?.(this.level)
    const frameMs = (f.length / this.ctx.sampleRate) * 1000

    if (this.mode === 'record') {
      this.frames.push(f)
      if (this.frames.length * frameMs > 120_000) this.frames.shift()
      return
    }
    if (this.mode !== 'listen' || !this.listenOpts) return

    // background level follows quiet frames only, so speech never raises it
    if (!this.speaking) this.floor = rms < this.floor ? rms : this.floor * 0.995 + rms * 0.005
    const threshold = Math.max(this.floor * 3.2, 0.012) * (this.boost ? 2.5 : 1)
    const loud = rms > threshold

    if (!this.speaking) {
      this.preroll.push(f)
      if (this.preroll.length > 8) this.preroll.shift() // ~350 ms before the start is kept
      this.loudRun = loud ? this.loudRun + 1 : 0
      if (this.loudRun >= 3) {
        this.speaking = true
        this.quietMs = 0
        this.frames = [...this.preroll]
        this.preroll = []
        this.listenOpts.onSpeechStart?.()
      }
      return
    }
    this.frames.push(f)
    this.quietMs = loud ? 0 : this.quietMs + frameMs
    const total = this.frames.length * frameMs
    if (this.quietMs >= this.listenOpts.silenceMs || total > 60_000) {
      const frames = this.frames
      this.frames = []
      this.speaking = false
      this.loudRun = 0
      const seconds = (total - this.quietMs) / 1000
      if (seconds >= 0.4) this.listenOpts.onUtterance(encodeWav(frames, this.ctx.sampleRate), total / 1000)
      else this.listenOpts.onDiscard?.()
    }
  }
}

/** Float frames at the device's rate → 16 kHz mono 16-bit PCM WAV. */
export function encodeWav(frames: Float32Array[], rate: number): Blob {
  const n = frames.reduce((a, f) => a + f.length, 0)
  const all = new Float32Array(n)
  let o = 0
  for (const f of frames) all.set(f, o), (o += f.length)
  const ratio = rate / TARGET_RATE
  const len = Math.floor(n / ratio)
  const pcm = new Int16Array(len)
  for (let i = 0; i < len; i++) {
    // average the source samples this output sample covers (a crude low-pass, fine for speech)
    const a = Math.floor(i * ratio)
    const b = Math.min(n, Math.floor((i + 1) * ratio))
    let s = 0
    for (let j = a; j < b; j++) s += all[j]
    const v = Math.max(-1, Math.min(1, s / Math.max(1, b - a)))
    pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff
  }
  const buf = new ArrayBuffer(44 + pcm.length * 2)
  const d = new DataView(buf)
  const str = (off: number, s: string) => [...s].forEach((c, i) => d.setUint8(off + i, c.charCodeAt(0)))
  str(0, 'RIFF')
  d.setUint32(4, 36 + pcm.length * 2, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  d.setUint32(16, 16, true)
  d.setUint16(20, 1, true)
  d.setUint16(22, 1, true)
  d.setUint32(24, TARGET_RATE, true)
  d.setUint32(28, TARGET_RATE * 2, true)
  d.setUint16(32, 2, true)
  d.setUint16(34, 16, true)
  str(36, 'data')
  d.setUint32(40, pcm.length * 2, true)
  new Int16Array(buf, 44).set(pcm)
  return new Blob([buf], { type: 'audio/wav' })
}

/** Microphones and speakers. Names are only shown once the page has been allowed the microphone. */
export async function audioDevices(): Promise<{ mics: MediaDeviceInfo[]; speakers: MediaDeviceInfo[]; named: boolean }> {
  const all = (await navigator.mediaDevices?.enumerateDevices?.()) ?? []
  const mics = all.filter((d) => d.kind === 'audioinput')
  const speakers = all.filter((d) => d.kind === 'audiooutput')
  return { mics, speakers, named: mics.some((m) => !!m.label) }
}

/** Ask once for the microphone so device names appear; the stream is closed straight away. */
export async function allowMic(): Promise<void> {
  const s = await navigator.mediaDevices.getUserMedia({ audio: true })
  s.getTracks().forEach((t) => t.stop())
}
