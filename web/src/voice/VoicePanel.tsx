/**
 * Settings → Voice: which microphone and speaker this computer uses, how BitBull sounds, and how
 * hands-free behaves. Kept on this computer only (prefs.ts).
 */
import { useEffect, useRef, useState } from 'react'
import { api, type VoiceInfo } from '../api'
import { allowMic, audioDevices, Mic } from './mic'
import { setVoicePrefs, voicePrefs, type VoicePrefs } from './prefs'
import { canChooseSpeaker, speaker } from './speaker'

const SAMPLE = "Hello, I'm BitBull. This is how I'll sound when I read my replies to you."
const isMac = /Mac/.test(navigator.platform)
const SHORTCUT = isMac ? '⌘ Cmd + Shift + Space' : 'Ctrl + Shift + Space'
const desktop = !!(window as unknown as { __BITBULL_DESKTOP?: { globalPtt?: boolean } }).__BITBULL_DESKTOP?.globalPtt

function usePrefs(): [VoicePrefs, (p: Partial<VoicePrefs>) => void] {
  const [p, setP] = useState(voicePrefs())
  useEffect(() => {
    const on = () => setP(voicePrefs())
    window.addEventListener('bitbull:voice-prefs', on)
    return () => window.removeEventListener('bitbull:voice-prefs', on)
  }, [])
  return [p, setVoicePrefs]
}

export function VoicePanel() {
  const [prefs, set] = usePrefs()
  const [info, setInfo] = useState<VoiceInfo | null>(null)
  const [infoErr, setInfoErr] = useState<string | null>(null)
  const [mics, setMics] = useState<MediaDeviceInfo[]>([])
  const [speakers, setSpeakers] = useState<MediaDeviceInfo[]>([])
  const [named, setNamed] = useState(true)
  const [sysVoices, setSysVoices] = useState<SpeechSynthesisVoice[]>([])
  const [testing, setTesting] = useState(false)
  const [level, setLevel] = useState(0)
  const [msg, setMsg] = useState<string | null>(null)
  const micRef = useRef<Mic | null>(null)

  const refreshDevices = () =>
    void audioDevices()
      .then((d) => {
        setMics(d.mics)
        setSpeakers(d.speakers)
        setNamed(d.named)
      })
      .catch(() => {})

  useEffect(() => {
    api.voice().then(setInfo, (e) => setInfoErr(e instanceof Error ? e.message : String(e)))
    refreshDevices()
    navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices)
    const loadVoices = () => typeof speechSynthesis !== 'undefined' && setSysVoices(speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang)))
    loadVoices()
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.addEventListener('voiceschanged', loadVoices)
    return () => {
      navigator.mediaDevices?.removeEventListener?.('devicechange', refreshDevices)
      if (typeof speechSynthesis !== 'undefined') speechSynthesis.removeEventListener('voiceschanged', loadVoices)
      micRef.current?.close()
    }
  }, [])

  const stopTest = () => {
    micRef.current?.close()
    micRef.current = null
    setTesting(false)
    setLevel(0)
  }

  const testMic = async () => {
    if (testing) return stopTest()
    setMsg(null)
    try {
      const mic = await Mic.open(prefs.micId || undefined)
      mic.onLevel = setLevel
      micRef.current = mic
      setTesting(true)
      refreshDevices() // names appear once allowed
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    }
  }

  // switching microphone restarts the meter on the new one
  useEffect(() => {
    if (testing) {
      stopTest()
      void testMic()
    }
  }, [prefs.micId])

  const preview = () => {
    speaker.stop()
    speaker.say(SAMPLE)
  }

  const piper = info?.tts
  const piperOk = !!piper?.available

  return (
    <>
      <p className="muted small">
        Talk to BitBull and have it talk back. These settings are kept on this computer only, so a laptop and a desktop can each use their own
        microphone and speakers.
      </p>

      <h3>Microphone and speaker</h3>
      <div className="cfg-table">
        <div className="cfg-row">
          <div className="cfg-label">
            Microphone
            <div className="cfg-hint">Click Test and talk: the bar should move.</div>
          </div>
          <div className="cfg-val voice-row">
            <select value={prefs.micId} onChange={(e) => set({ micId: e.target.value })}>
              <option value="">System default</option>
              {mics
                .filter((m) => m.deviceId && m.deviceId !== 'default')
                .map((m, i) => (
                  <option key={m.deviceId} value={m.deviceId}>
                    {m.label || `Microphone ${i + 1}`}
                  </option>
                ))}
            </select>
            <button type="button" className="btn sm" onClick={() => void testMic()}>
              {testing ? 'Stop' : 'Test'}
            </button>
            {!named && (
              <button type="button" className="btn sm" onClick={() => void allowMic().then(refreshDevices, (e) => setMsg(String(e?.message ?? e)))}>
                Allow microphone
              </button>
            )}
            <div className="voice-meter" aria-label="Microphone level">
              <i style={{ width: `${Math.round(level * 100)}%` }} />
            </div>
          </div>
        </div>
        <div className="cfg-row">
          <div className="cfg-label">
            Speaker
            <div className="cfg-hint">{canChooseSpeaker ? 'Where BitBull’s voice plays.' : 'This browser always uses the system’s default output.'}</div>
          </div>
          <div className="cfg-val voice-row">
            <select value={prefs.speakerId} onChange={(e) => set({ speakerId: e.target.value })} disabled={!canChooseSpeaker || prefs.engine === 'system'}>
              <option value="">System default</option>
              {speakers
                .filter((s) => s.deviceId && s.deviceId !== 'default')
                .map((s, i) => (
                  <option key={s.deviceId} value={s.deviceId}>
                    {s.label || `Speaker ${i + 1}`}
                  </option>
                ))}
            </select>
            <button type="button" className="btn sm" onClick={preview}>
              Test
            </button>
          </div>
        </div>
      </div>

      <h3>BitBull’s voice</h3>
      <div className="cfg-table">
        <div className="cfg-row">
          <div className="cfg-label">
            Voice engine
            <div className="cfg-hint">
              {prefs.engine === 'piper'
                ? 'Natural voices, generated inside BitBull’s own container (Piper). Nothing leaves your machine.'
                : 'The computer’s built-in voices. Always plays on the default speaker.'}
            </div>
          </div>
          <div className="cfg-val">
            <div className="seg mini">
              <button type="button" className={prefs.engine === 'piper' ? 'on' : ''} onClick={() => set({ engine: 'piper' })}>
                BitBull voices
              </button>
              <button type="button" className={prefs.engine === 'system' ? 'on' : ''} onClick={() => set({ engine: 'system' })}>
                This computer’s
              </button>
            </div>
            {prefs.engine === 'piper' && info && !piperOk && (
              <div className="cfg-hint bad-text">The voices aren’t in this build yet: deploy again to rebuild the image.</div>
            )}
          </div>
        </div>
        <div className="cfg-row">
          <div className="cfg-label">Voice</div>
          <div className="cfg-val voice-row">
            {prefs.engine === 'piper' ? (
              <select value={prefs.voice} onChange={(e) => set({ voice: e.target.value })}>
                {(['female', 'male'] as const).map((g) => (
                  <optgroup key={g} label={g === 'female' ? 'Female' : 'Male'}>
                    {piper?.voices
                      .filter((v) => v.gender === g)
                      .map((v) => (
                        <option key={v.id} value={v.id} disabled={!v.available}>
                          {v.name}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
            ) : (
              <select value={prefs.systemVoice} onChange={(e) => set({ systemVoice: e.target.value })}>
                <option value="">Default</option>
                {sysVoices.map((v) => (
                  <option key={v.name} value={v.name}>
                    {v.name}
                  </option>
                ))}
              </select>
            )}
            <button type="button" className="btn sm" onClick={preview}>
              Preview
            </button>
          </div>
        </div>
        <div className="cfg-row">
          <div className="cfg-label">Speed</div>
          <div className="cfg-val voice-row">
            <input type="range" min={0.75} max={1.5} step={0.05} value={prefs.speed} onChange={(e) => set({ speed: Number(e.target.value) })} />
            <span className="muted small">{prefs.speed.toFixed(2)}×</span>
          </div>
        </div>
        <div className="cfg-row">
          <div className="cfg-label">
            Speak replies
            <div className="cfg-hint">Read the answer out loud when you asked by voice (and always in hands-free).</div>
          </div>
          <div className="cfg-val">
            <label className="check">
              <input type="checkbox" checked={prefs.autoSpeak} onChange={(e) => set({ autoSpeak: e.target.checked })} /> On
            </label>
          </div>
        </div>
      </div>

      <h3>Talking to BitBull</h3>
      <div className="cfg-table">
        <div className="cfg-row">
          <div className="cfg-label">
            Hands-free pause
            <div className="cfg-hint">How long a silence means you’ve finished. Longer if it cuts you off mid-thought.</div>
          </div>
          <div className="cfg-val voice-row">
            <input type="range" min={600} max={2500} step={100} value={prefs.silenceMs} onChange={(e) => set({ silenceMs: Number(e.target.value) })} />
            <span className="muted small">{(prefs.silenceMs / 1000).toFixed(1)} s</span>
          </div>
        </div>
        <div className="cfg-row">
          <div className="cfg-label">Push-to-talk</div>
          <div className="cfg-val small">
            Hold <kbd>{SHORTCUT}</kbd>, talk, let go: it’s sent.{' '}
            {desktop ? 'Works from any app while the BitBull desktop app is running.' : 'In a browser this works while the BitBull tab has focus; the desktop app makes it work from anywhere.'}
          </div>
        </div>
        <div className="cfg-row">
          <div className="cfg-label">
            Listening model
            <div className="cfg-hint">Turns your speech into text. Change it under Configuration → Voice: listening model.</div>
          </div>
          <div className="cfg-val small">
            {infoErr ? (
              <span className="bad-text">{infoErr}</span>
            ) : !info ? (
              'Checking…'
            ) : info.stt.model ? (
              <>
                <code>{info.stt.model}</code>
                {info.stt.price && <span className="muted"> · ${info.stt.price.input}/M input tokens</span>}
              </>
            ) : (
              <span className="bad-text">No Gemini model in the SayGM catalogue, so listening is off. Check SayGM under Integrations.</span>
            )}
          </div>
        </div>
      </div>
      {msg && <p className="bad-text small">{msg}</p>}
      <p className="muted small voice-credits">
        Voices: Piper (MIT). Southern English from OpenSLR 83 (CC BY-SA 4.0); US voices from LibriTTS (CC BY 4.0).
      </p>
    </>
  )
}
