/**
 * Voice in the chat, in one hook so Chat.tsx only has to wire a few calls:
 *
 *   mic button        click to start, click again to stop: the words land in the message box
 *                     and the reply to that message is spoken (when "speak replies I asked by
 *                     voice" is on)
 *   hold the shortcut Ctrl/Cmd+Shift+Space (anywhere on the computer in the desktop app, in the
 *                     page otherwise): talk while held, let go and it is sent
 *   hands-free        BitBull listens; each thing you say is sent, the reply is spoken, and it
 *                     listens again. Talking over a reply stops it.
 *
 * Replies are spoken as they stream, a sentence or two at a time (SentenceFeed).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { Mic } from './mic'
import { voicePrefs } from './prefs'
import { speaker } from './speaker'
import { SentenceFeed } from './text'

export type MicState = 'off' | 'recording' | 'transcribing' | 'listening' | 'hearing'

export interface VoiceSend {
  (text: string, opts: { voice: true }): Promise<void> | void
}

export function useSpeaking() {
  const [speaking, setSpeaking] = useState(speaker.speaking)
  useEffect(() => speaker.on(setSpeaking), [])
  return speaking
}

export function useVoice({ busy, send, setInput }: { busy: boolean; send: VoiceSend; setInput: (fn: (cur: string) => string) => void }) {
  const [state, setState] = useState<MicState>('off')
  const [handsFree, setHandsFree] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [level, setLevel] = useState(0)
  const speaking = useSpeaking()

  const micRef = useRef<Mic | null>(null)
  const feedRef = useRef<SentenceFeed | null>(null)
  /** the message box text came from the mic: speak the reply to it */
  const spokenNextRef = useRef(false)
  const handsFreeRef = useRef(false)
  const busyRef = useRef(busy)
  busyRef.current = busy
  const sendRef = useRef(send)
  sendRef.current = send
  /** said while a reply was still coming: sent when it is done */
  const queueRef = useRef<string[]>([])
  const pttRef = useRef<'idle' | 'button' | 'hold'>('idle')

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e))

  const openMic = async () => {
    if (micRef.current?.open) return micRef.current
    const mic = await Mic.open(voicePrefs().micId || undefined)
    let last = 0
    mic.onLevel = (l) => {
      const now = performance.now()
      if (now - last > 80) (last = now), setLevel(l)
    }
    micRef.current = mic
    return mic
  }

  const closeMic = () => {
    micRef.current?.close()
    micRef.current = null
    setLevel(0)
  }

  const transcribe = async (wav: Blob): Promise<string> => {
    const r = await api.transcribe(wav)
    return r.text.trim()
  }

  // ---- what the chat calls while a reply streams ----

  /** A turn is starting; `voice` = it was asked by voice. Returns whether it will be spoken. */
  const beginTurn = useCallback((voice: boolean) => {
    const spoken = (voice || spokenNextRef.current || handsFreeRef.current) && voicePrefs().autoSpeak
    spokenNextRef.current = false
    speaker.stop()
    feedRef.current = spoken ? new SentenceFeed() : null
    return spoken
  }, [])

  const onText = useCallback((delta: string) => {
    const feed = feedRef.current
    if (feed) for (const c of feed.push(delta)) speaker.say(c)
  }, [])

  const endTurn = useCallback(() => {
    const feed = feedRef.current
    feedRef.current = null
    if (feed) for (const c of feed.flush()) speaker.say(c)
  }, [])

  /** The user pressed Stop: stop talking too. */
  const abort = useCallback(() => {
    feedRef.current = null
    speaker.stop()
  }, [])

  // ---- push-to-talk ----

  const startRecording = async (how: 'button' | 'hold') => {
    if (pttRef.current !== 'idle' || handsFreeRef.current) return
    pttRef.current = how
    setError(null)
    speaker.stop()
    try {
      const mic = await openMic()
      if (pttRef.current !== how) return closeMic() // let go before the mic opened
      mic.record()
      setState('recording')
    } catch (e) {
      pttRef.current = 'idle'
      setState('off')
      fail(e)
    }
  }

  const stopRecording = async (how: 'button' | 'hold') => {
    if (pttRef.current !== how) return
    pttRef.current = 'idle'
    const rec = micRef.current?.stop() ?? null
    closeMic()
    if (!rec) return setState('off')
    setState('transcribing')
    try {
      const text = await transcribe(rec.wav)
      if (!text) return setError('Nothing was heard. Check the microphone in Settings → Voice.')
      if (how === 'hold' && !busyRef.current) await sendRef.current(text, { voice: true })
      else {
        setInput((cur) => (cur.trim() ? `${cur.trimEnd()} ${text}` : text))
        spokenNextRef.current = true
      }
    } catch (e) {
      fail(e)
    } finally {
      setState('off')
    }
  }

  const toggleRecording = () => (pttRef.current === 'button' ? void stopRecording('button') : void startRecording('button'))

  // ---- hands-free ----

  const onUtterance = async (wav: Blob) => {
    if (!handsFreeRef.current) return
    setState('transcribing')
    try {
      const text = await transcribe(wav)
      if (!handsFreeRef.current || !text) return
      if (busyRef.current) queueRef.current.push(text)
      else await sendRef.current(text, { voice: true })
    } catch (e) {
      fail(e)
    } finally {
      if (handsFreeRef.current) setState('listening')
    }
  }

  const startHandsFree = async () => {
    setError(null)
    try {
      const mic = await openMic()
      handsFreeRef.current = true
      setHandsFree(true)
      setState('listening')
      mic.listen({
        silenceMs: voicePrefs().silenceMs,
        onSpeechStart: () => {
          // you talked over BitBull: it stops and listens
          if (speaker.speaking) speaker.stop()
          setState('hearing')
        },
        onUtterance: (wav) => void onUtterance(wav),
        onDiscard: () => handsFreeRef.current && setState('listening'),
      })
    } catch (e) {
      fail(e)
      stopHandsFree()
    }
  }

  const stopHandsFree = () => {
    handsFreeRef.current = false
    queueRef.current = []
    setHandsFree(false)
    setState('off')
    closeMic()
  }

  const toggleHandsFree = () => (handsFreeRef.current ? stopHandsFree() : void startHandsFree())

  // while BitBull talks, it takes clearly louder speech to count as you (its own voice leaks back)
  useEffect(() => {
    if (micRef.current) micRef.current.boost = speaking
  }, [speaking])

  // what was said during a reply goes once it is done
  useEffect(() => {
    if (busy || !queueRef.current.length) return
    const text = queueRef.current.splice(0).join(' ')
    void sendRef.current(text, { voice: true })
  }, [busy])

  // hold-to-talk: the desktop app's global shortcut sends bitbull:ptt; in a browser, the same keys in the page
  useEffect(() => {
    const onPtt = (e: Event) => {
      const d = (e as CustomEvent<'down' | 'up'>).detail
      if (d === 'down') void startRecording('hold')
      else void stopRecording('hold')
    }
    const isCombo = (e: KeyboardEvent) => e.code === 'Space' && e.shiftKey && (e.ctrlKey || e.metaKey)
    const onDown = (e: KeyboardEvent) => {
      if (!isCombo(e)) return
      e.preventDefault()
      if (!e.repeat) void startRecording('hold')
    }
    const onUp = (e: KeyboardEvent) => {
      if (pttRef.current === 'hold' && (e.code === 'Space' || e.key === 'Shift' || e.key === 'Control' || e.key === 'Meta')) void stopRecording('hold')
    }
    window.addEventListener('bitbull:ptt', onPtt)
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    return () => {
      window.removeEventListener('bitbull:ptt', onPtt)
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
    }
  }, [])

  // a different microphone or pause length chosen in Settings: hands-free picks it up
  useEffect(() => {
    const onPrefs = () => {
      if (handsFreeRef.current) {
        stopHandsFree()
        void startHandsFree()
      }
    }
    window.addEventListener('bitbull:voice-prefs', onPrefs)
    return () => window.removeEventListener('bitbull:voice-prefs', onPrefs)
  }, [])

  // leaving the chat releases the microphone
  useEffect(
    () => () => {
      handsFreeRef.current = false
      micRef.current?.close()
    },
    [],
  )

  return {
    state,
    handsFree,
    speaking,
    level,
    error,
    clearError: () => setError(null),
    toggleRecording,
    toggleHandsFree,
    beginTurn,
    onText,
    endTurn,
    abort,
    stopSpeaking: () => speaker.stop(),
  }
}
