import { useEffect, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api, type AgentEvent, type AppConfig, type EngineId, type Message, type Model, type Session, type ToolCall, type Uploaded } from './api'
import { IconBrain, IconCheck, IconClip, IconCopy, IconFile, IconSend, IconStop, IconTool, IconX } from './icons'

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
  return { id: m.id, role: m.role, content: m.content, model: m.model, tools, attachments, usage }
}

const SUGGESTIONS = [
  { title: 'Catch me up', text: 'Catch me up on my most recent projects from memory: where each one stands and what is still open.' },
  { title: 'Plan my day', text: 'Help me plan today. Ask me what is on my plate, then turn it into a prioritised schedule.' },
  { title: 'Compare models', text: 'Which SayGM models would you pick for coding, long documents and cheap quick answers, and why?' },
  { title: 'Remember something', text: 'Remember this for future chats: ' },
]

export function Chat({
  session,
  cfg,
  model,
  modelInfo,
  guard,
  onCreate,
  onTurnDone,
}: {
  session: Session | null
  cfg: AppConfig
  model: string
  modelInfo?: Model
  guard: <T>(p: Promise<T>) => Promise<T | undefined>
  onCreate: (engine: EngineId) => Promise<Session | undefined>
  onTurnDone: () => void
}) {
  const [msgs, setMsgs] = useState<ViewMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [engine, setEngine] = useState<EngineId>(session?.engine ?? cfg.defaultEngine)
  const [pending, setPending] = useState<File[]>([])
  const [dragging, setDragging] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const fileRef = useRef<HTMLInputElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  // When the first message of a draft creates a session, keep the local stream going
  const createdHere = useRef<string | null>(null)

  useEffect(() => {
    if (!session) {
      setMsgs([])
      setBusy(false)
      return
    }
    setEngine(session.engine)
    if (createdHere.current === session.id) return
    void guard(api.session(session.id)).then((r) => {
      if (r) {
        setMsgs(r.messages.map(toView))
        setBusy(r.running)
      }
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

  const patchLast = (fn: (m: ViewMessage) => ViewMessage) =>
    setMsgs((all) => (all.length ? [...all.slice(0, -1), fn(all[all.length - 1])] : all))

  const onEvent = (ev: AgentEvent) => {
    switch (ev.type) {
      case 'text':
        return patchLast((m) => ({ ...m, content: m.content + ev.delta }))
      case 'thinking':
        return patchLast((m) => ({ ...m, thinking: (m.thinking ?? '') + ev.delta }))
      case 'tool_start':
        return patchLast((m) => ({ ...m, tools: [...m.tools, { id: ev.id, name: ev.name, input: ev.input }] }))
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

  const addFiles = (list: FileList | File[] | null) => {
    if (!list) return
    const arr = Array.from(list)
    const tooBig = arr.find((f) => f.size > 25 * 1024 * 1024)
    if (tooBig) setNotice(`${tooBig.name} is over 25 MB`)
    setPending((p) => [...p, ...arr.filter((f) => f.size <= 25 * 1024 * 1024)].slice(0, 20))
  }

  const send = async (override?: string) => {
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
    if (pending.length) {
      try {
        uploaded = (await api.upload(s.id, pending)) ?? []
      } catch (e) {
        setNotice(e instanceof Error ? e.message : 'Upload failed')
        setBusy(false)
        return
      }
    }
    setInput('')
    setPending([])
    stickRef.current = true
    const paths = uploaded.map((u) => u.path)
    setMsgs((all) => [
      ...all,
      { id: `u-${Date.now()}`, role: 'user', content: text, tools: [], attachments: paths },
      { id: `a-${Date.now()}`, role: 'assistant', content: '', tools: [], model, streaming: true },
    ])
    await guard(api.send(s.id, text, model, onEvent, paths))
    patchLast((m) => ({ ...m, streaming: false }))
    setBusy(false)
    onTurnDone()
  }

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
        addFiles(e.dataTransfer.files)
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
            <div className="hero-mark">GM</div>
            <h1>What are we working on?</h1>
            <p>
              Any SayGM model, one conversation. Memory lives in Ditto, so context follows you from model to model.
            </p>
            <div className="suggest">
              {SUGGESTIONS.map((s) => (
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
            {msgs.map((m) => (
              <MessageView key={m.id} m={m} />
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
          {pending.length > 0 && (
            <div className="chips">
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
            placeholder={`Message ${modelInfo?.name ?? model}…`}
            rows={1}
          />
          <div className="composer-bar">
            <button type="button" className="icon-btn" title="Attach files" onClick={() => fileRef.current?.click()}>
              <IconClip />
            </button>
            <input ref={fileRef} type="file" multiple hidden onChange={(e) => (addFiles(e.target.files), (e.target.value = ''))} />
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
            <span className="hint">Enter to send · Shift+Enter for a new line</span>
            {busy ? (
              <button type="button" className="send stop" onClick={() => session && void guard(api.abort(session.id))} aria-label="Stop">
                <IconStop />
              </button>
            ) : (
              <button type="submit" className="send" disabled={!input.trim()} aria-label="Send">
                <IconSend />
              </button>
            )}
          </div>
        </form>
        {dragging && <div className="dropzone">Drop files to attach</div>}
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

function CodeBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null)
  const [copied, copy] = useCopy()
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

function MessageView({ m }: { m: ViewMessage }) {
  const [copied, copy] = useCopy()
  if (m.role === 'user')
    return (
      <div className="msg user">
        <div className="bubble">
          {m.content}
          {m.attachments && m.attachments.length > 0 && (
            <div className="chips in-bubble">
              {m.attachments.map((a) => (
                <span className="chip" key={a}>
                  <IconFile size={13} /> {a.split('/').pop()}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    )

  const running = m.tools.filter((t) => !t.done).length
  return (
    <div className="msg assistant">
      <div className="avatar">GM</div>
      <div className="msg-body">
        <div className="msg-meta">
          <span className="model-chip">{m.model}</span>
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
        {m.tools.length > 0 && (
          <details className="fold tools" open={m.streaming}>
            <summary>
              <IconTool size={14} /> {m.tools.length} tool call{m.tools.length > 1 ? 's' : ''}
              {running > 0 && <span className="muted"> · {running} running</span>}
            </summary>
            <div className="tool-list">
              {m.tools.map((t) => (
                <details key={t.id} className={`tool ${t.isError ? 'err' : ''}`}>
                  <summary>
                    <span className={`dot ${t.done ? (t.isError ? 'bad' : 'ok') : 'run'}`} />
                    <span className="tool-name">{prettyTool(t.name)}</span>
                    <span className="tool-arg">{toolArg(t.input)}</span>
                  </summary>
                  {t.input !== undefined && <pre>{JSON.stringify(t.input, null, 2)}</pre>}
                  {t.output && <pre className="out">{t.output}</pre>}
                </details>
              ))}
            </div>
          </details>
        )}
        <div className="md">
          {m.content ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ pre: CodeBlock, a: (p) => <a {...p} target="_blank" rel="noreferrer" /> }}>
              {m.content}
            </ReactMarkdown>
          ) : m.streaming && !m.tools.length ? (
            <span className="muted">Thinking…</span>
          ) : null}
        </div>
        {m.error && <div className="error">{m.error}</div>}
        {!m.streaming && (
          <div className="msg-foot">
            {m.content && (
              <button className="icon-btn sm" onClick={() => copy(m.content)} title="Copy reply">
                {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
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
