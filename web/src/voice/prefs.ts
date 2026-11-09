/**
 * Voice settings, kept per computer (localStorage): the microphone and speaker differ between a
 * laptop and a desktop, so each browser / desktop app remembers its own. Settings → Voice edits
 * them; everything else reads them through `voicePrefs()` and hears changes via the event.
 */
export interface VoicePrefs {
  /** MediaDevices deviceId; "" = the system default */
  micId: string
  speakerId: string
  /** "piper" = BitBull's voices (in the container); "system" = the computer's own */
  engine: 'piper' | 'system'
  /** a Piper voice id (server/src/voice.ts VOICES) */
  voice: string
  /** a SpeechSynthesisVoice name, for engine "system" */
  systemVoice: string
  /** 0.75–1.5 */
  speed: number
  /** speak the reply when you asked by voice */
  autoSpeak: boolean
  /** hands-free: this much quiet ends what you were saying */
  silenceMs: number
}

const KEY = 'bitbull-voice'
export const DEFAULT_PREFS: VoicePrefs = {
  micId: '',
  speakerId: '',
  engine: 'piper',
  voice: 'uk-female',
  systemVoice: '',
  speed: 1,
  autoSpeak: true,
  silenceMs: 1100,
}

let cached: VoicePrefs | null = null

export function voicePrefs(): VoicePrefs {
  if (cached) return cached
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<VoicePrefs>
    cached = { ...DEFAULT_PREFS, ...raw }
  } catch {
    cached = { ...DEFAULT_PREFS }
  }
  return cached
}

export function setVoicePrefs(patch: Partial<VoicePrefs>) {
  cached = { ...voicePrefs(), ...patch }
  try {
    localStorage.setItem(KEY, JSON.stringify(cached))
  } catch {
    /* private window: they last for this page only */
  }
  window.dispatchEvent(new CustomEvent('bitbull:voice-prefs', { detail: cached }))
}
