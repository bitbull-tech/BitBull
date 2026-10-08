import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  api,
  getToken,
  setToken,
  Unauthorized,
  type AgentEvent,
  type AppConfig,
  type EngineId,
  type Message,
  type Model,
  type Session,
  type ToolCall,
} from './api'

interface ViewMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  thinking?: string
  model?: string | null
  tools: ToolCall[]
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number }
  error?: string
  streaming?: boolean
}

const FAMILY_LABEL: Record<Model['family'], string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  open: 'Open weights',
  other: 'Other',
}

function toView(m: Message): ViewMessage {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    model: m.model,
    tools: m.tools_json ? (JSON.parse(m.tools_json) as ToolCall[]).map((t) => ({ ...t, done: true })) : [],
    usage: m.usage_json ? JSON.parse(m.usage_json) : undefined,
  }
}

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null)
  const [cfg, setCfg] = useState<AppConfig | null>(null)

  const boot = useCallback(async () => {
    try {
      setCfg(await api.config())
      setAuthed(true)
    } catch (e) {
      setAuthed(e instanceof Unauthorized ? false : true)
    }
  }, [])
  useEffect(() => {
    void boot()
  }, [boot])

  if (authed === null) return <div className="center muted">Loading…</div>
  if (!authed || !cfg) return <Login onDone={boot} />
  return <Shell cfg={cfg} onUnauthorized={() => setAuthed(false)} />
}

function Login({ onDone }: { onDone: () => void }) {
  const [value, setValue] = useState(getToken())
  return (
    <div className="center">
      <form
        className="login"
        onSubmit={(e) => {
          e.preventDefault()
          setToken(value.trim())
          onDone()
        }}
      >
        <div className="logo">GM</div>
        <h1>GM Agent</h1>
        <p className="muted">Enter your access token (APP_TOKEN).</p>
        <input type="password" autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder="Access token" />
        <button type="submit" className="primary">Unlock</button>
      </form>
    </div>
  )
}

function Shell({ cfg, onUnauthorized }: { cfg: AppConfig; onUnauthorized: () => void }) {
  const [sessions, setSessions] = useState<Session[]>([])
  const [models, setModels] = useState<Model[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [newEngine, setNewEngine] = useState<EngineId>(cfg.defaultEngine)
  const [model, setModel] = useState(cfg.defaultModel)
  const [navOpen, setNavOpen] = useState(false)

  const guard = useCallback(
    async <T,>(p: Promise<T>): Promise<T | undefined> => {
      try {
        return await p
      } catch (e) {
        if (e instanceof Unauthorized) onUnauthorized()
        else console.error(e)
      }
    },
    [onUnauthorized],
  )

  const refreshSessions = useCallback(async () => {
    const r = await guard(api.sessions())
    if (r) setSessions(r.sessions)
  }, [guard])

  useEffect(() => {
    void refreshSessions()
    void guard(api.models()).then((r) => r && setModels(r.models))
  }, [guard, refreshSessions])

  const active = sessions.find((s) => s.id === activeId) ?? null

  const newChat = async () => {
    const r = await guard(api.createSession(newEngine, model))
    if (!r) return
    setSessions((s) => [r.session, ...s])
    setActiveId(r.session.id)
    setNavOpen(false)
  }

  const remove = async (id: string) => {
    await guard(api.deleteSession(id))
    if (activeId === id) setActiveId(null)
    void refreshSessions()
  }

  return (
    <div className={`shell ${navOpen ? 'nav-open' : ''}`}>
      <aside className="sidebar">
        <div className="brand">
          <div className="logo sm">GM</div>
          <span>GM Agent</span>
        </div>
        <div className="new-row">
          <select value={newEngine} onChange={(e) => setNewEngine(e.target.value as EngineId)} title="Engine for new chats">
            {cfg.engines.map((e) => (
              <option key={e.id} value={e.id}>{e.label}</option>
            ))}
          </select>
          <button className="primary" onClick={newChat}>New chat</button>
        </div>
        <nav className="sessions">
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`session ${s.id === activeId ? 'active' : ''}`}
              onClick={() => {
                setActiveId(s.id)
                setModel(s.model)
                setNavOpen(false)
              }}
            >
              <span className="title">{s.title}</span>
              <span className="engine-tag">{s.engine === 'claude' ? 'SDK' : 'OC'}</span>
              <button
                className="icon"
                title="Delete"
                onClick={(e) => {
                  e.stopPropagation()
                  if (confirm('Delete this chat?')) void remove(s.id)
                }}
              >
                ×
              </button>
            </div>
          ))}
          {!sessions.length && <p className="muted small pad">No chats yet.</p>}
        </nav>
        <footer className="side-foot small muted">
          Memory: {cfg.ditto.enabled ? `Ditto (archive: ${cfg.ditto.archive})` : 'off'}
        </footer>
      </aside>
      <div className="scrim" onClick={() => setNavOpen(false)} />
      <main className="main">
        <header className="topbar">
          <button className="icon menu" onClick={() => setNavOpen(true)} aria-label="Menu">☰</button>
          <div className="topbar-title">{active?.title ?? 'GM Agent'}</div>
          <ModelPicker models={models} value={model} onChange={setModel} />
        </header>
        {active ? (
          <Chat key={active.id} session={active} model={model} guard={guard} onTurnDone={refreshSessions} engineLabel={cfg.engines.find((e) => e.id === active.engine)?.label ?? active.engine} />
        ) : (
          <div className="empty">
            <div className="logo lg">GM</div>
            <p>Start a new chat. Switch models any time from the picker — memory lives in Ditto, so context follows you.</p>
            <button className="primary" onClick={newChat}>New chat</button>
          </div>
        )}
      </main>
    </div>
  )
}

function ModelPicker({ models, value, onChange }: { models: Model[]; value: string; onChange: (m: string) => void }) {
  const groups = useMemo(() => {
    const g = new Map<Model['family'], Model[]>()
    for (const m of models) g.set(m.family, [...(g.get(m.family) ?? []), m])
    return [...g.entries()]
  }, [models])
  const known = models.some((m) => m.id === value)
  return (
    <select className="model-picker" value={value} onChange={(e) => onChange(e.target.value)} title="Model (applies to your next message)">
      {!known && <option value={value}>{value}</option>}
      {groups.map(([fam, ms]) => (
        <optgroup key={fam} label={FAMILY_LABEL[fam]}>
          {ms.map((m) => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}

function Chat({
  session,
  model,
  guard,
  onTurnDone,
  engineLabel,
}: {
  session: Session
  model: string
  guard: <T>(p: Promise<T>) => Promise<T | undefined>
  onTurnDone: () => void
  engineLabel: string
}) {
  const [msgs, setMsgs] = useState<ViewMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void guard(api.session(session.id)).then((r) => {
      if (r) {
        setMsgs(r.messages.map(toView))
        setBusy(r.running)
      }
    })
  }, [session.id, guard])

  useEffect(() => {
    // Block body on purpose: newer Chromium returns a Promise from scrollIntoView,
    // and React would treat a returned value as a cleanup function.
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [msgs])

  const patchLast = (fn: (m: ViewMessage) => ViewMessage) =>
    setMsgs((all) => [...all.slice(0, -1), fn(all[all.length - 1])])

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

  const send = async () => {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    setBusy(true)
    setMsgs((all) => [
      ...all,
      { id: `u-${Date.now()}`, role: 'user', content: text, tools: [] },
      { id: `a-${Date.now()}`, role: 'assistant', content: '', tools: [], model, streaming: true },
    ])
    await guard(api.send(session.id, text, model, onEvent))
    patchLast((m) => ({ ...m, streaming: false }))
    setBusy(false)
    onTurnDone()
  }

  return (
    <>
      <div className="messages">
        <div className="engine-note small muted">Engine: {engineLabel}</div>
        {msgs.map((m) => (
          <MessageView key={m.id} m={m} />
        ))}
        <div ref={endRef} />
      </div>
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send()
            }
          }}
          placeholder={`Message ${model}…`}
          rows={1}
        />
        {busy ? (
          <button type="button" onClick={() => void guard(api.abort(session.id))}>Stop</button>
        ) : (
          <button type="submit" className="primary" disabled={!input.trim()}>Send</button>
        )}
      </form>
    </>
  )
}

function MessageView({ m }: { m: ViewMessage }) {
  if (m.role === 'user') return <div className="msg user"><div className="bubble">{m.content}</div></div>
  return (
    <div className="msg assistant">
      {m.model && <div className="meta small muted">{m.model}</div>}
      {m.thinking && (
        <details className="thinking">
          <summary>Thinking</summary>
          <pre>{m.thinking}</pre>
        </details>
      )}
      {m.tools.length > 0 && (
        <div className="tools">
          {m.tools.map((t) => (
            <details key={t.id} className={`tool ${t.isError ? 'err' : ''}`}>
              <summary>
                <span className={`dot ${t.done ? (t.isError ? 'bad' : 'ok') : 'run'}`} />
                {prettyTool(t.name)}
              </summary>
              {t.input !== undefined && <pre>{JSON.stringify(t.input, null, 2)}</pre>}
              {t.output && <pre className="out">{t.output}</pre>}
            </details>
          ))}
        </div>
      )}
      <div className="md">
        {m.content ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown> : m.streaming ? <span className="cursor">▍</span> : null}
      </div>
      {m.error && <div className="error small">{m.error}</div>}
      {m.usage && (m.usage.outputTokens || m.usage.costUsd) ? (
        <div className="meta small muted">
          {m.usage.inputTokens ?? 0} in · {m.usage.outputTokens ?? 0} out
          {m.usage.costUsd ? ` · $${m.usage.costUsd.toFixed(4)}` : ''}
        </div>
      ) : null}
    </div>
  )
}

function prettyTool(name: string) {
  // mcp__ditto__search_memories -> ditto · search_memories ; ditto_save_memory (OpenCode) -> ditto · save_memory
  const mcp = name.match(/^mcp__([^_]+)__(.+)$/)
  if (mcp) return `${mcp[1]} · ${mcp[2]}`
  if (name.startsWith('ditto_')) return `ditto · ${name.slice(6)}`
  return name
}
