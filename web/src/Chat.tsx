import { isValidElement, useEffect, useRef, useState, type ReactNode } from 'react'
import { HoundFindings, parseHoundBlock } from './HoundFindings'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ReplyFiles } from './ReplyFiles'
import { captureFiles, WindowShare } from './screen'
import { api, type OutputFile, type AgentEvent, type AppConfig, type EngineId, type Message, type Model, type Project, type Session, type ToolCall, type Uploaded } from './api'
import { IconBrain, IconCheck, IconClip, IconCopy, IconFile, IconFolder, IconHeadset, IconLock, IconMic, IconMonitor, IconPlan, IconSend, IconShare, IconSpeaker, IconSpeakerOff, IconStop, IconTool, IconX } from './icons'
import { useSpeaking, useVoice } from './voice/useVoice'
import { speaker } from './voice/speaker'
import { chunk, speakable } from './voice/text'
import { ModelDog } from './dogs'
import { ModelAdvisor } from './ModelAdvisor'
import { filterItems, fromDrop, fromInput, hasFolder, uploadItems, type UploadItem } from './uploads'
import { reportLocal } from './activity'
import { FolderMenu } from './FolderMenu'
import { BrandMark } from './BrandMark'
import { getBrand } from './brand'
import mascot from './assets/bitbull-arms-folded.webp'

const SHORTCUT = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘⇧Space' : 'Ctrl+Shift+Space'
const VOICE_HINT: Record<string, string> = {
  listening: 'Listening… just talk',
  hearing: 'Hearing you…',
  transcribing: 'Writing it down…',
  recording: 'Listening…',
  off: 'Hands-free',
}

const greeting = () => {
  const h = new Date().getHours()
  return h < 5 ? 'good night' : h < 12 ? 'good morning' : h < 18 ? 'good afternoon' : 'good evening'
}

interface ViewMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  thinking?: string
  model?: string | null
  tools: ToolCall[]
  attachments?: string[]
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number }
  error?: string
  streaming?: boolean
  plan?: boolean
  /** when the reply was saved (server time); none while it is still streaming */
  at?: number
}

function toView(m: Message): ViewMessage {
  let tools: ToolCall[] = []
  let attachments: string[] | undefined
  if (m.tools_json) {
    try {
      const parsed = JSON.parse(m.tools_json)
      if (Array.isArray(parsed)) tools = parsed.map((t: ToolCall) => ({ ...t, done: true }))
      else if (parsed && Array.isArray(parsed.attachments)) attachments = parsed.attachments
    } catch {
      /* ignore bad rows */
    }
  }
  let usage
  try {
    usage = m.usage_json ? JSON.parse(m.usage_json) : undefined
  } catch {
    usage = undefined
  }
  return { id: m.id, role: m.role, content: m.content, model: m.model, tools, attachments, usage, at: m.created_at }
}

const PROJECT_SUGGESTIONS = [
  { title: 'Catalogue my uploads', text: 'Use the archive-ingest skill: catalogue everything in uploads/, extract what each item says with evidence, and list conflicts and questions for me.' },
  { title: 'Plan a cinematic', text: 'Using the catalogue, propose a 90-second cinematic: beats, which shots use original images and which are reconstructions, and the grounding bindings for every line.' },
  { title: 'Set up a codebase', text: 'Clone a repository into this project and onboard it: map the code, run the build and tests, and write AGENTS.md. Ask me for the URL.' },
  { title: 'Catch me up', text: 'Catch me up on this project from memory and from the files in the workspace: where it stands and what is still open.' },
]

const SUGGESTIONS = [
  { title: 'Catch me up', text: 'Catch me up on my most recent projects from memory: where each one stands and what is still open.' },
  { title: 'Plan my day', text: 'Help me plan today. Ask me what is on my plate, then turn it into a prioritised schedule.' },
  { title: 'Compare models', text: 'Which SayGM models would you pick for coding, long documents and cheap quick answers, and why?' },
  { title: 'Remember something', text: 'Remember this for future chats: ' },
]

export function Chat({
  session,
  project,
  cfg,
  model,
  modelInfo,
  guard,
  onCreate,
  onTurnDone,
  onPickModel,
}: {
  session: Session | null
  project: Project | null
  cfg: AppConfig
  model: string
  modelInfo?: Model
  guard: <T>(p: Promise<T>) => Promise<T | undefined>
  onCreate: (engine: EngineId) => Promise<Session | undefined>
  onTurnDone: () => void
  /** "Use this model" from the home screen's advisor */
  onPickModel?: (id: string) => void
}) {
  const [msgs, setMsgs] = useState<ViewMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [engine, setEngine] = useState<EngineId>(session?.engine ?? cfg.defaultEngine)
  const [pending, setPending] = useState<File[]>([])
  const [dragging, setDragging] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [plan, setPlan] = useState(false)
  // "Show BitBull a window": while shared, each message carries a fresh picture of it (screen.ts)
  const [share, setShare] = useState<WindowShare | null>(null)
  const shareRef = useRef<WindowShare | null>(null)
  shareRef.current = share
  const stopShare = () => {
    shareRef.current?.stop()
    setShare(null)
  }
  const showWindow = async () => {
    try {
      let s = shareRef.current
      if (!s?.active) {
        s = await WindowShare.start()
        s.onEnd = () => setShare(null)
        setShare(s)
      }
      addFiles([await s.frame()])
      taRef.current?.focus()
    } catch (e) {
      // closing the picker is not an error worth showing
      if (!(e instanceof DOMException && e.name === 'NotAllowedError')) setNotice(e instanceof Error ? e.message : String(e))
    }
  }
  useEffect(() => () => shareRef.current?.stop(), [])
  // files the agent made or changed in this chat, shown under the reply that made them
  const [outputs, setOutputs] = useState<{ projectId: string; files: OutputFile[]; host: string | null } | null>(null)
  const loadOutputs = (id: string | undefined) => {
    if (!id) return setOutputs(null)
    void api.outputs(id).then(
      (r) => sessionRef.current?.id === id && setOutputs(r),
      () => {},
    )
  }
  // Folders dropped on the chat are uploaded right away; their paths go with the next message
  const [folders, setFolders] = useState<string[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const fileRef = useRef<HTMLInputElement>(null)
  const folderRef = useRef<HTMLInputElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  // When the first message of a draft creates a session, keep the local stream going
  const createdHere = useRef<string | null>(null)
  const sessionRef = useRef(session)
  sessionRef.current = session
  // The turn we are currently reading, so re-rendering doesn't attach to it twice
  const followingRef = useRef<string | null>(null)

  useEffect(() => {
    if (!session) {
      setMsgs([])
      setBusy(false)
      setOutputs(null)
      return
    }
    loadOutputs(session.id)
    setEngine(session.engine)
    if (createdHere.current === session.id) return
    void guard(api.session(session.id)).then((r) => {
      if (!r) return
      setMsgs(r.messages.map(toView))
      setBusy(r.running)
      // A turn left running (tab closed, phone asleep, laptop lid shut) is still going on
      // the server: join it and replay everything it produced while we were away.
      if (r.running && r.turnId && followingRef.current !== r.turnId) void resume(session.id, r.turnId)
    })
  }, [session, guard])

  // Follow the stream only while the user is at the bottom
  useEffect(() => {
    const el = scrollRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [msgs])

  useEffect(() => {
    taRef.current?.focus()
  }, [session?.id])

  // Text sent from the activity log or a highlighted passage lands here for the user to finish
  useEffect(() => {
    const onCompose = (e: Event) => {
      const text = (e as CustomEvent<string>).detail
      setInput((cur) => (cur.trim() ? `${cur.trimEnd()}\n\n${text}` : text))
      setTimeout(() => {
        const ta = taRef.current
        if (!ta) return
        ta.focus()
        ta.selectionStart = ta.selectionEnd = ta.value.length
        ta.scrollTop = ta.scrollHeight
      }, 0)
    }
    window.addEventListener('bitbull:compose', onCompose)
    // A turn the server started in this chat on its own (a QA Hound verdict): join it
    const onTurn = (e: Event) => {
      const d = (e as CustomEvent<{ sessionId: string; turnId: string }>).detail
      const cur = sessionRef.current
      if (d && cur && d.sessionId === cur.id && followingRef.current !== d.turnId) {
        void guard(api.session(cur.id)).then((r) => {
          if (!r) return
          setMsgs(r.messages.map(toView))
          void resume(cur.id, d.turnId)
        })
      }
    }
    window.addEventListener('bitbull:turn-started', onTurn)
    return () => {
      window.removeEventListener('bitbull:compose', onCompose)
      window.removeEventListener('bitbull:turn-started', onTurn)
    }
  }, [])

  // Pages sent from the BitBull browser extension land in the chat that is open (captures.ts)
  useEffect(() => {
    let stopped = false
    const poll = async () => {
      if (document.visibilityState !== 'visible') return
      const r = await api.nextCapture().catch(() => null)
      const c = r?.capture
      if (!c || stopped) return
      addFiles(captureFiles(c))
      setInput((cur) => (cur.trim() ? cur : `Review this page: ${c.title || c.url} (${c.url})`))
      setNotice(`Page from the browser attached: ${c.title || c.url}`)
      taRef.current?.focus()
    }
    const t = setInterval(() => void poll(), 3000)
    return () => {
      stopped = true
      clearInterval(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const patchLast = (fn: (m: ViewMessage) => ViewMessage) =>
    setMsgs((all) => (all.length ? [...all.slice(0, -1), fn(all[all.length - 1])] : all))

  const onEvent = (ev: AgentEvent) => {
    switch (ev.type) {
      case 'text':
        voice.onText(ev.delta)
        return patchLast((m) => ({ ...m, content: m.content + ev.delta }))
      case 'thinking':
        return patchLast((m) => ({ ...m, thinking: (m.thinking ?? '') + ev.delta }))
      case 'tool_start':
        return patchLast((m) => ({ ...m, tools: [...m.tools, { id: ev.id, name: ev.name, input: ev.input, parent: ev.parent }] }))
      case 'tool_end':
        return patchLast((m) => ({
          ...m,
          tools: m.tools.map((t) => (t.id === ev.id ? { ...t, output: ev.output, isError: ev.isError, done: true } : t)),
        }))
      case 'error':
        return patchLast((m) => ({ ...m, error: (m.error ? m.error + '\n' : '') + ev.message }))
      case 'done':
        return patchLast((m) => ({ ...m, usage: ev.usage, streaming: false, id: ev.messageId ?? m.id }))
    }
  }

  /** Join a turn that is already running and replay it from the start. */
  const resume = async (sessionId: string, turnId: string) => {
    followingRef.current = turnId
    setBusy(true)
    // The user's message is already in history; the reply is only saved when the turn ends.
    setMsgs((all) => [...all, { id: `a-${turnId}`, role: 'assistant', content: '', tools: [], model, streaming: true }])
    try {
      await guard(api.followUntilDone(sessionId, turnId, 0, onEvent))
    } finally {
      if (followingRef.current === turnId) followingRef.current = null
      patchLast((m) => ({ ...m, streaming: false }))
      setBusy(false)
      loadOutputs(sessionRef.current?.id)
      onTurnDone()
    }
  }

  const addFiles = (list: FileList | File[] | null) => {
    if (!list) return
    const arr = Array.from(list)
    const tooBig = arr.find((f) => f.size > 25 * 1024 * 1024)
    if (tooBig) setNotice(`${tooBig.name} is over 25 MB`)
    setPending((p) => [...p, ...arr.filter((f) => f.size <= 25 * 1024 * 1024)].slice(0, 20))
  }

  // Folders (dropped or picked): upload now into uploads/, keeping structure, then attach the folder paths
  const addFolder = async (items: UploadItem[], tops: string[]) => {
    const keep = filterItems(items, true)
    if (!keep.length) return setNotice('That folder has nothing to upload (only dependency/build folders or system files).')
    const names = tops.join(', ')
    setNotice(`Uploading ${keep.length} files from ${names}…`)
    try {
      await uploadItems(project?.id ?? 'general', keep, {
        target: 'uploads',
        onProgress: (d, t) => setNotice(`Uploading ${d}/${t} files from ${names}…`),
      })
      setFolders((f) => [...f, ...tops.map((t) => `uploads/${t}`).filter((t) => !f.includes(t))])
      setNotice(`Added ${keep.length} files from ${names} (dependency/build folders skipped). Use the Files button for more options.`)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Upload failed')
    }
  }

  const send = async (override?: string, opts?: { voice?: boolean }) => {
    const text = (override ?? input).trim()
    if (!text || busy) return
    setNotice(null)
    let s = session
    if (!s) {
      s = (await onCreate(engine)) ?? null
      if (!s) return
      createdHere.current = s.id
    }
    setBusy(true)
    let uploaded: Uploaded[] = []
    // a window is being shown: this message carries a picture of it as it is now
    const toSend = [...pending]
    if (shareRef.current?.active && !pending.some((f) => f.type === 'image/png' && Date.now() - f.lastModified < 5000)) {
      const frame = await shareRef.current.frame().catch(() => null)
      if (frame) toSend.push(frame)
    }
    if (toSend.length) {
      try {
        uploaded = (await api.upload(s.id, toSend)) ?? []
      } catch (e) {
        setNotice(e instanceof Error ? e.message : 'Upload failed')
        setBusy(false)
        return
      }
    }
    setInput('')
    setPending([])
    stickRef.current = true
    const paths = [...uploaded.map((u) => u.path), ...folders]
    setFolders([])
    setMsgs((all) => [
      ...all,
      { id: `u-${Date.now()}`, role: 'user', content: text, tools: [], attachments: paths },
      { id: `a-${Date.now()}`, role: 'assistant', content: '', tools: [], model, streaming: true, plan },
    ])
    voice.beginTurn(!!opts?.voice)
    try {
      await guard(api.run(s.id, { message: text, model, attachments: paths, plan }, onEvent, {
        onTurn: (turnId) => (followingRef.current = turnId),
      }))
    } finally {
      followingRef.current = null
      voice.endTurn()
      patchLast((m) => ({ ...m, streaming: false }))
      setBusy(false)
      loadOutputs(sessionRef.current?.id)
      onTurnDone()
    }
  }

  const voice = useVoice({ busy, send: (text, o) => send(text, o), setInput })
  // a voice problem (no microphone, nothing heard, transcription failed) shows where other notices do
  useEffect(() => {
    if (voice.error) setNotice(voice.error), voice.clearError()
  }, [voice.error])

  // which reply made which files: the first saved reply at or after the turn started; anything
  // newer than every saved reply belongs to the latest one (just finished, not reloaded yet)
  const filesByMsg = (() => {
    const m = new Map<string, OutputFile[]>()
    if (!outputs?.files.length) return m
    const replies = msgs.filter((x) => x.role === 'assistant' && !x.streaming)
    for (const f of outputs.files) {
      const r = replies.find((x) => x.at !== undefined && x.at >= f.turn.start) ?? replies[replies.length - 1]
      if (r) m.set(r.id, [...(m.get(r.id) ?? []), f])
    }
    return m
  })()

  const empty = msgs.length === 0

  return (
    <div
      className={`chat ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setDragging(true)
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        if (!hasFolder(e.dataTransfer)) return addFiles(e.dataTransfer.files)
        void fromDrop(e.dataTransfer).then(({ items, folders: tops }) => addFolder(items, tops))
      }}
    >
      <div
        className="scroll"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
      >
        {empty ? (
          <div className="hero">
            {project ? (
              <>
                <div className={`hero-mark pc-${project.color}`}>{project.name.slice(0, 2).toUpperCase()}</div>
                <h1>{project.name}</h1>
                <p>{project.description || 'Chats, files and instructions for this project live together. Attach photos, film and documents to get started.'}</p>
              </>
            ) : (
              // BitBull himself stands beside the welcome; a white-labelled install with its own logo keeps its mark instead
              <div className={`hero-intro ${getBrand().logo ? 'branded' : ''}`}>
                {getBrand().logo ? <BrandMark className="hero-mark" /> : <img className="hero-mascot" src={mascot} alt="" draggable={false} />}
                <div className="hero-copy">
                  <p className="hero-greet">{greeting()}.</p>
                  <h1>What are we working on?</h1>
                  <p>Any SayGM model, one conversation. Memory lives in Ditto, so context follows you from model to model.</p>
                </div>
              </div>
            )}
            {onPickModel && <ModelAdvisor current={model} onUse={onPickModel} />}
            <div className="suggest-label">Try a starting point</div>
            <div className="suggest">
              {(project ? PROJECT_SUGGESTIONS : SUGGESTIONS).map((s) => (
                <button
                  key={s.title}
                  className="suggest-card"
                  onClick={() => {
                    if (s.text.endsWith(': ')) {
                      setInput(s.text)
                      taRef.current?.focus()
                    } else void send(s.text)
                  }}
                >
                  <b>{s.title}</b>
                  <span>{s.text}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="thread">
            {msgs.map((m, i) => (
              <MessageView
                key={m.id}
                m={m}
                sessionId={session?.id}
                prompt={m.role === 'assistant' ? prevUserMsg(msgs, i) : undefined}
                files={filesByMsg.get(m.id)}
                filesAt={outputs}
              />
            ))}
          </div>
        )}
      </div>

      <div className="composer-wrap">
        {notice && (
          <div className="notice">
            {notice}
            <button className="icon-btn sm" onClick={() => setNotice(null)} aria-label="Dismiss">
              <IconX size={14} />
            </button>
          </div>
        )}
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault()
            void send()
          }}
        >
          {(pending.length > 0 || folders.length > 0 || share) && (
            <div className="chips">
              {share && (
                <span className="chip sharing" title="Each message you send includes a fresh picture of this window. Stop sharing to end it.">
                  <IconMonitor size={13} /> Showing: {share.label}
                  <button type="button" onClick={stopShare} aria-label="Stop showing the window">
                    <IconX size={12} />
                  </button>
                </span>
              )}
              {folders.map((f) => (
                <span className={`chip ${f.startsWith('links/') ? 'linked' : ''}`} key={f} title={f.startsWith('links/') ? 'Your folder, read-only: the agent can read it but not change it' : 'A copy, uploaded to the workspace'}>
                  {f.startsWith('links/') ? <IconLock size={13} /> : <IconFolder size={13} />} {f.startsWith('links/') ? `${f.slice(6)} (read-only)` : f}
                  <button type="button" onClick={() => setFolders((x) => x.filter((y) => y !== f))} aria-label={`Remove ${f}`}>
                    <IconX size={12} />
                  </button>
                </span>
              ))}
              {pending.map((f, i) => (
                <span className="chip" key={`${f.name}-${i}`}>
                  <IconFile size={13} /> {f.name}
                  <button type="button" onClick={() => setPending((p) => p.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`}>
                    <IconX size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={taRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={(e) => {
              if (e.clipboardData.files.length) {
                e.preventDefault()
                addFiles(e.clipboardData.files)
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void send()
              }
            }}
            placeholder={plan ? 'Describe what you want planned (read-only: nothing will be changed)…' : `Message ${modelInfo?.name ?? model}…`}
            rows={1}
          />
          <div className="composer-bar">
            <button type="button" className="icon-btn" title="Attach files" onClick={() => fileRef.current?.click()}>
              <IconClip />
            </button>
            {WindowShare.supported() && (
              <button
                type="button"
                className={`icon-btn ${share ? 'on' : ''}`}
                title={share ? `Attach a fresh picture of ${share.label}` : 'Show BitBull a window: pick one, and a picture of it is attached (and refreshed with each message while you share it)'}
                onClick={() => void showWindow()}
              >
                <IconMonitor />
              </button>
            )}
            <input ref={fileRef} type="file" multiple hidden onChange={(e) => (addFiles(e.target.files), (e.target.value = ''))} />
            <FolderMenu
              onUpload={() => folderRef.current?.click()}
              onLink={(name) => setFolders((f) => (f.includes(`links/${name}`) ? f : [...f, `links/${name}`]))}
            />
            <input
              ref={folderRef}
              type="file"
              hidden
              {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
              onChange={(e) => {
                const items = fromInput(e.target.files)
                e.target.value = ''
                const tops = [...new Set(items.map((it) => it.path.split('/')[0]))]
                if (items.length) void addFolder(items, tops)
              }}
            />
            <button
              type="button"
              className={`toggle ${plan ? 'on' : ''}`}
              onClick={() => setPlan((p) => !p)}
              title="Plan mode: the agent investigates and proposes a plan without changing anything"
            >
              <IconPlan size={14} /> Plan
            </button>
            {!session ? (
              <div className="seg mini" title="Engine for this chat">
                {cfg.engines.map((en) => (
                  <button type="button" key={en.id} className={engine === en.id ? 'on' : ''} onClick={() => setEngine(en.id)}>
                    {en.label}
                  </button>
                ))}
              </div>
            ) : (
              <span className="engine-pill" title="Engine for this chat">
                {cfg.engines.find((e) => e.id === session.engine)?.label ?? session.engine}
              </span>
            )}
            <span className="grow" />
            <span className="hint">{voice.handsFree ? VOICE_HINT[voice.state] : 'Enter to send · Shift+Enter for a new line'}</span>
            {voice.speaking && (
              <button type="button" className="icon-btn voice-btn" onClick={voice.stopSpeaking} title="Stop speaking">
                <IconSpeakerOff size={16} />
              </button>
            )}
            <button
              type="button"
              className={`icon-btn voice-btn ${voice.handsFree ? 'on' : ''}`}
              onClick={voice.toggleHandsFree}
              title={voice.handsFree ? 'Hands-free is on: click to stop listening' : 'Hands-free: talk, and BitBull answers out loud. Talk over it to interrupt.'}
              aria-pressed={voice.handsFree}
            >
              <IconHeadset size={16} />
            </button>
            {!voice.handsFree && (
              <button
                type="button"
                className={`icon-btn voice-btn mic ${voice.state}`}
                onClick={voice.toggleRecording}
                disabled={voice.state === 'transcribing'}
                title={
                  voice.state === 'recording'
                    ? 'Listening: click to stop'
                    : voice.state === 'transcribing'
                      ? 'Writing down what you said…'
                      : `Speak your message (or hold ${SHORTCUT} to talk and send)`
                }
                style={{ ['--lvl' as string]: voice.level.toFixed(2) }}
              >
                <IconMic size={16} />
              </button>
            )}
            {busy ? (
              <button type="button" className="send stop" onClick={() => (voice.abort(), session && void guard(api.abort(session.id)))} aria-label="Stop">
                <IconStop />
              </button>
            ) : (
              <button type="submit" className="send" disabled={!input.trim()} aria-label="Send">
                <IconSend />
              </button>
            )}
          </div>
        </form>
        {dragging && <div className="dropzone">Drop files or folders to attach</div>}
      </div>
    </div>
  )
}

function useCopy() {
  const [copied, setCopied] = useState(false)
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    })
  }
  return [copied, copy] as const
}

/**
 * Images in replies are never fetched by the browser: a reply the agent wrote could point at
 * https://evil/?<data> and the browser sits outside the egress proxy. Shown as a link instead
 * (the page's CSP blocks remote images anyway; this keeps the UI tidy and says why).
 */
function MdImage({ src, alt }: { src?: string; alt?: string }) {
  const s = src ?? ''
  return (
    <span className="md-img" title="Images in replies aren't loaded (they could carry data out of the sandbox). Open the link to see it.">
      <IconFile size={13} /> {alt || 'image'}
      {s && !s.startsWith('data:') && (
        <>
          {' '}
          <a href={s} target="_blank" rel="noreferrer">
            {s.length > 60 ? s.slice(0, 57) + '…' : s}
          </a>
        </>
      )}
    </span>
  )
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null)
  const [copied, copy] = useCopy()
  // QA Hound's findings block renders as its table once it is complete JSON
  const code = isValidElement<{ className?: string; children?: ReactNode }>(children) ? children.props : null
  if (code?.className?.includes('language-qa-hound') && typeof code.children === 'string' && parseHoundBlock(code.children))
    return <HoundFindings text={code.children} />
  return (
    <div className="code">
      <button className="code-copy" onClick={() => copy(ref.current?.innerText ?? '')} aria-label="Copy code">
        {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
        {copied ? 'Copied' : 'Copy'}
      </button>
      <pre ref={ref}>{children}</pre>
    </div>
  )
}

/** Nearest user message before index i — the prompt this reply answers. */
function prevUserMsg(msgs: ViewMessage[], i: number): ViewMessage | undefined {
  for (let j = i - 1; j >= 0; j--) if (msgs[j].role === 'user') return msgs[j]
  return undefined
}

/** Paste-ready markdown of one request/response pair, for handing to an external agent. */
function exchangeMarkdown(prompt: ViewMessage, m: ViewMessage): string {
  return [
    `**Prompt:**\n${prompt.content}`,
    ...(prompt.attachments?.length ? [`_Attachments: ${prompt.attachments.map((a) => a.split('/').pop()).join(', ')}_`] : []),
    `**Response${m.model ? ` (${m.model})` : ''}:**\n${m.content || ''}${m.error ? `${m.content ? '\n\n' : ''}_Error: ${m.error}_` : ''}`,
  ].join('\n\n')
}

function MessageView({
  m,
  sessionId,
  prompt,
  files,
  filesAt,
}: {
  m: ViewMessage
  sessionId?: string
  prompt?: ViewMessage
  files?: OutputFile[]
  filesAt?: { projectId: string; host: string | null } | null
}) {
  const [copied, copy] = useCopy()
  const [exported, setExported] = useState<'' | 'full' | 'short'>('')
  const [copiedX, copyExchange] = useCopy()
  const [reading, setReading] = useState(false)
  const speaking = useSpeaking()
  useEffect(() => {
    if (!speaking) setReading(false)
  }, [speaking])
  const readAloud = () => {
    speaker.stop()
    if (reading) return setReading(false)
    const parts = chunk(speakable(m.content))
    if (!parts.length) return
    parts.forEach((c) => speaker.say(c))
    setReading(true)
  }
  if (m.role === 'user')
    return (
      <div className="msg user">
        <div className="bubble">
          {m.content}
          {m.attachments && m.attachments.length > 0 && (
            <div className="chips in-bubble">
              {m.attachments.map((a) => (
                <span className={`chip ${a.startsWith('links/') ? 'linked' : ''}`} key={a}>
                  {a.startsWith('links/') ? <IconLock size={13} /> : <IconFile size={13} />} {a.split('/').pop()}
                  {a.startsWith('links/') ? ' (read-only)' : ''}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    )

  const running = plainTools(m.tools).filter((t) => !t.done).length
  return (
    <div className="msg assistant">
      <div className="avatar">BitBull</div>
      <div className="msg-body">
        <div className="msg-meta">
          {m.model && (
            <span className="model-chip">
              <ModelDog id={m.model} size={16} /> {m.model}
            </span>
          )}
          {m.plan && <span className="tag plan-tag"><IconPlan size={11} /> Plan</span>}
          {m.streaming && <span className="typing"><i /><i /><i /></span>}
        </div>
        {m.thinking && (
          <details className="fold">
            <summary>
              <IconBrain size={14} /> Thinking
            </summary>
            <pre>{m.thinking}</pre>
          </details>
        )}
        {todosOf(m.tools) && <TodoList todos={todosOf(m.tools)!} />}
        {agentsOf(m.tools).length > 0 && (
          <div className="agents">
            {agentsOf(m.tools).map((a) => (
              <AgentCard key={a.id} call={a} steps={m.tools.filter((t) => t.parent === a.id)} live={!!m.streaming} />
            ))}
          </div>
        )}
        {plainTools(m.tools).length > 0 && (
          <details className="fold tools" open={m.streaming}>
            <summary>
              <IconTool size={14} /> {plainTools(m.tools).length} tool call{plainTools(m.tools).length > 1 ? 's' : ''}
              {running > 0 && <span className="muted"> · {running} running</span>}
            </summary>
            <div className="tool-list">
              {plainTools(m.tools).map((t) => (
                <ToolRow key={t.id} t={t} />
              ))}
            </div>
          </details>
        )}
        <div className="md" data-askable="reply">
          {m.content ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ pre: CodeBlock, a: (p) => <a {...p} target="_blank" rel="noreferrer" />, img: MdImage }}>
              {m.content}
            </ReactMarkdown>
          ) : m.streaming && !m.tools.length ? (
            <span className="muted">Thinking…</span>
          ) : null}
        </div>
        {m.error && <div className="error">{m.error}</div>}
        {!m.streaming && files && filesAt && <ReplyFiles files={files} projectId={filesAt.projectId} host={filesAt.host} />}
        {!m.streaming && (
          <div className="msg-foot">
            {m.content && (
              <button className="icon-btn sm" onClick={() => copy(m.content)} title="Copy reply">
                {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
              </button>
            )}
            {m.content && (
              <button className={`icon-btn sm ${reading ? 'on' : ''}`} onClick={readAloud} title={reading ? 'Stop reading' : 'Read aloud'}>
                {reading ? <IconSpeakerOff size={13} /> : <IconSpeaker size={13} />}
              </button>
            )}
            {sessionId && !/^a-\d+$/.test(m.id) && (
              <span className="copy-agent">
                Copy for agent:
                {(['full', 'short'] as const).map((kind) => (
                  <button
                    key={kind}
                    className="link small"
                    title={
                      kind === 'full'
                        ? 'This request and reply with setup, tool calls and the activity log, for debugging in another agent'
                        : 'Just this request and reply, for a quick second opinion'
                    }
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(await api.exportChat(sessionId, 'md', { exchange: m.id, compact: kind === 'short' }))
                        setExported(kind)
                        setTimeout(() => setExported(''), 2000)
                      } catch (e) {
                        reportLocal(`Copy failed: ${e instanceof Error ? e.message : String(e)}`)
                      }
                    }}
                  >
                    {exported === kind ? 'Copied' : kind === 'full' ? 'full' : 'prompt + reply'}
                  </button>
                ))}
              </span>
            )}
            {prompt && (m.content || m.error) && (
              <button className="icon-btn sm" onClick={() => copyExchange(exchangeMarkdown(prompt, m))} title="Copy prompt + reply to paste into another agent">
                {copiedX ? <IconCheck size={13} /> : <IconShare size={13} />}
              </button>
            )}
            {m.usage && (m.usage.outputTokens || m.usage.costUsd) ? (
              <span>
                {fmtTokens(m.usage.inputTokens)} in · {fmtTokens(m.usage.outputTokens)} out
                {m.usage.costUsd ? ` · $${m.usage.costUsd < 0.01 ? m.usage.costUsd.toFixed(4) : m.usage.costUsd.toFixed(3)}` : ''}
              </span>
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}

const isAgentTool = (name: string) => /^(task|agent)$/i.test(name)
const agentsOf = (tools: ToolCall[]) => tools.filter((t) => !t.parent && isAgentTool(t.name))
const plainTools = (tools: ToolCall[]) => tools.filter((t) => !t.parent && !isAgentTool(t.name))

function ToolRow({ t }: { t: ToolCall }) {
  return (
    <details className={`tool ${t.isError ? 'err' : ''}`}>
      <summary>
        <span className={`dot ${t.done ? (t.isError ? 'bad' : 'ok') : 'run'}`} />
        <span className="tool-name">{prettyTool(t.name)}</span>
        <span className="tool-arg">{toolArg(t.input)}</span>
      </summary>
      {t.input !== undefined && <pre>{JSON.stringify(t.input, null, 2)}</pre>}
      {t.output && <pre className="out">{t.output}</pre>}
    </details>
  )
}

/** A subagent run: its type, brief, live steps and final report. */
function AgentCard({ call, steps, live }: { call: ToolCall; steps: ToolCall[]; live: boolean }) {
  const inp = (call.input ?? {}) as { subagent_type?: string; description?: string; prompt?: string }
  const runningSteps = steps.filter((s) => !s.done).length
  return (
    <details className="agent-card" open={live && !call.done}>
      <summary>
        <span className={`dot ${call.done ? (call.isError ? 'bad' : 'ok') : 'run'}`} />
        <span className="agent-type">{inp.subagent_type ?? 'agent'}</span>
        <span className="agent-desc">{inp.description ?? ''}</span>
        <span className="agent-steps">
          {steps.length} step{steps.length === 1 ? '' : 's'}
          {!call.done && runningSteps > 0 ? ' · working' : ''}
        </span>
      </summary>
      {inp.prompt && (
        <details className="tool">
          <summary>
            <span className="tool-name">Brief</span>
            <span className="tool-arg">{inp.prompt.slice(0, 80)}</span>
          </summary>
          <pre>{inp.prompt}</pre>
        </details>
      )}
      {steps.length > 0 && (
        <div className="tool-list">
          {steps.map((t) => (
            <ToolRow key={t.id} t={t} />
          ))}
        </div>
      )}
      {call.output && <pre className="out">{call.output}</pre>}
    </details>
  )
}

const fmtTokens = (n?: number) => (!n ? '0' : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

function prettyTool(name: string) {
  const mcp = name.match(/^mcp__([^_]+)__(.+)$/)
  if (mcp) return `${mcp[1]} · ${mcp[2].replace(/_/g, ' ')}`
  if (name.startsWith('ditto_')) return `ditto · ${name.slice(6).replace(/_/g, ' ')}`
  return name.replace(/_/g, ' ')
}

function toolArg(input: unknown) {
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  const v = o.queries ?? o.query ?? o.filePath ?? o.file_path ?? o.path ?? o.command ?? o.pattern ?? o.url ?? o.content
  const s = Array.isArray(v) ? v.join(', ') : typeof v === 'string' ? v : ''
  return s.length > 70 ? s.slice(0, 67) + '…' : s
}

type Todo = { content: string; status: string; activeForm?: string }

/** Latest todo list the agent wrote this turn (OpenCode todowrite / Claude TodoWrite). */
function todosOf(tools: ToolCall[]): Todo[] | null {
  for (let i = tools.length - 1; i >= 0; i--) {
    const t = tools[i]
    if (!/^todo_?write$/i.test(t.name)) continue
    const todos = (t.input as { todos?: Todo[] } | undefined)?.todos
    if (Array.isArray(todos) && todos.length) return todos
  }
  return null
}

function TodoList({ todos }: { todos: Todo[] }) {
  const done = todos.filter((t) => t.status === 'completed').length
  return (
    <div className="todos">
      <div className="todos-head">
        To-do · {done}/{todos.length}
        <span className="todos-bar"><i style={{ width: `${(done / todos.length) * 100}%` }} /></span>
      </div>
      {todos.map((t, i) => (
        <div key={i} className={`todo ${t.status}`}>
          <span className="box">{t.status === 'completed' ? <IconCheck size={11} /> : null}</span>
          <span>{t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}</span>
        </div>
      ))}
    </div>
  )
}
