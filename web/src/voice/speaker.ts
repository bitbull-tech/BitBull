/**
 * BitBull's voice. One queue for the whole page, so a read-aloud, an auto-spoken reply and the
 * Settings test never talk over each other. Chunks are fetched from the server (Piper) one ahead
 * of the one playing, so speech starts after the first sentence and has no gaps between them,
 * and played through the chosen speaker where the browser allows it (setSinkId).
 *
 * With engine "system" the computer's own speech synthesis is used instead: no server, but always
 * the system's default output.
 */
import { api } from '../api'
import { voicePrefs } from './prefs'

type Listener = (speaking: boolean) => void

interface Item {
  text: string
  audio?: Promise<Blob>
}

export const canChooseSpeaker = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype

class Speaker {
  private queue: Item[] = []
  private current: HTMLAudioElement | null = null
  private utter: SpeechSynthesisUtterance | null = null
  private playing = false
  private gen = 0
  private listeners = new Set<Listener>()
  private idleWaiters: Array<() => void> = []
  lastError: string | null = null

  get speaking() {
    return this.playing || this.queue.length > 0
  }

  on(fn: Listener) {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }

  /** Add text to what is being said. */
  say(text: string) {
    const t = text.trim()
    if (!t) return
    this.queue.push({ text: t })
    this.prefetch()
    if (!this.playing) void this.next(this.gen)
  }

  /** Stop now and forget the rest. */
  stop() {
    this.gen++
    this.queue = []
    if (this.current) {
      this.current.pause()
      this.current.src = ''
      this.current = null
    }
    if (this.utter || (typeof speechSynthesis !== 'undefined' && speechSynthesis.speaking)) speechSynthesis.cancel()
    this.utter = null
    this.setPlaying(false)
  }

  /** Resolves once everything queued has been said (or stopped). */
  idle(): Promise<void> {
    if (!this.speaking) return Promise.resolve()
    return new Promise((r) => this.idleWaiters.push(r))
  }

  private setPlaying(p: boolean) {
    if (this.playing === p && (p || this.queue.length)) return
    this.playing = p
    this.listeners.forEach((l) => l(this.speaking))
    if (!this.speaking) this.idleWaiters.splice(0).forEach((r) => r())
  }

  private prefetch() {
    const prefs = voicePrefs()
    if (prefs.engine !== 'piper') return
    for (const item of this.queue.slice(0, 2)) {
      if (!item.audio) item.audio = api.speak(item.text, prefs.voice, prefs.speed)
    }
  }

  private async next(gen: number) {
    if (gen !== this.gen) return
    const item = this.queue.shift()
    if (!item) return this.setPlaying(false)
    this.setPlaying(true)
    this.prefetch()
    const prefs = voicePrefs()
    try {
      if (prefs.engine === 'system') await this.speakSystem(item.text, prefs.systemVoice, prefs.speed)
      else {
        const blob = await (item.audio ?? api.speak(item.text, prefs.voice, prefs.speed))
        if (gen !== this.gen) return
        await this.play(blob, prefs.speakerId)
      }
      this.lastError = null
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e)
      if (gen === this.gen) {
        // a broken chunk shouldn't silence the rest, but a dead server would: give up on that
        if (/fetch|network|Piper/i.test(this.lastError)) this.queue = []
      }
    }
    if (gen === this.gen) void this.next(gen)
  }

  private async play(blob: Blob, sinkId: string) {
    const url = URL.createObjectURL(blob)
    const a = new Audio(url)
    this.current = a
    try {
      if (sinkId && canChooseSpeaker) await (a as HTMLAudioElement & { setSinkId(id: string): Promise<void> }).setSinkId(sinkId).catch(() => {})
      await new Promise<void>((resolve, reject) => {
        a.onended = () => resolve()
        a.onerror = () => reject(new Error('Could not play the audio'))
        a.onpause = () => resolve() // stop()
        void a.play().catch(reject)
      })
    } finally {
      URL.revokeObjectURL(url)
      if (this.current === a) this.current = null
    }
  }

  private speakSystem(text: string, voiceName: string, rate: number) {
    return new Promise<void>((resolve, reject) => {
      if (typeof speechSynthesis === 'undefined') return reject(new Error('No speech synthesis in this browser'))
      const u = new SpeechSynthesisUtterance(text)
      const v = speechSynthesis.getVoices().find((x) => x.name === voiceName)
      if (v) u.voice = v
      u.rate = rate
      u.onend = () => resolve()
      u.onerror = (e) => (e.error === 'interrupted' || e.error === 'canceled' ? resolve() : reject(new Error(e.error)))
      this.utter = u
      speechSynthesis.speak(u)
    })
  }
}

export const speaker = new Speaker()
