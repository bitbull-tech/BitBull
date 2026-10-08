import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, clearToken, getToken, setToken, Unauthorized, type AppConfig, type EngineId, type Model, type Session, type Status } from './api'
import { Chat } from './Chat'
import { IconMenu, IconMoon, IconPencil, IconPlus, IconSearch, IconSettings, IconSun, IconTrash } from './icons'
import { ModelPicker } from './ModelPicker'
import { Settings } from './Settings'
import { useTheme } from './theme'

const MODEL_KEY = 'gm-agent-model'
const lsGet = (k: string) => {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
const lsSet = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v)
  } catch {
    /* ignore */
  }
}

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null)
  const [cfg, setCfg] = useState<AppConfig | null>(null)
  const [error, setError] = useState<string | null>(null)

  const boot = useCallback(async () => {
    try {
      setCfg(await api.config())
      setAuthed(true)
      setError(null)
    } catch (e) {
      if (e instanceof Unauthorized) setAuthed(false)
      else {
        setAuthed(false)
        setError('Cannot reach the GM server. Is `npm run dev` running?')
      }
    }
  }, [])
  useEffect(() => {
    void boot()
  }, [boot])

  if (authed === null) return <div className="center"><div className="hero-mark pulse-soft">GM</div></div>
  if (!authed || !cfg) return <Login onDone={boot} error={error} />
  return (
    <Shell
      cfg={cfg}
      onUnauthorized={() => setAuthed(false)}
      onLogout={() => {
        clearToken()
        setAuthed(false)
      }}
    />
  )
}

function Login({ onDone, error }: { onDone: () => void; error: string | null }) {
  const [value, setValue] = useState(getToken())
  const [tried, setTried] = useState(false)
  return (
    <div className="center login-bg">
      <form
        className="login"
        onSubmit={(e) => {
          e.preventDefault()
          setToken(value.trim())
          setTried(true)
          onDone()
        }}
      >
        <div className="hero-mark">GM</div>
        <h1>GM Agent</h1>
        <p className="muted">Your agent on SayGM, with Ditto memory.</p>
        <input type="password" autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder="Access token (APP_TOKEN)" />
        {(error || (tried && value)) && <p className="error small">{error ?? 'That token was not accepted.'}</p>}
        <button type="submit" className="btn primary block">Unlock</button>
      </form>
    </div>
  )
}

function groupLabel(ts: number) {
  const d = new Date(ts)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const day = 86400000
  if (d.getTime() >= today.getTime()) return 'Today'
  if (d.getTime() >= today.getTime() - day) return 'Yesterday'
  if (d.getTime() >= today.getTime() - 7 * day) return 'Previous 7 days'
  if (d.getTime() >= today.getTime() - 30 * day) return 'Previous 30 days'
  return 'Older'
}

function Shell({ cfg, onUnauthorized, onLogout }: { cfg: AppConfig; onUnauthorized: () => void; onLogout: () => void }) {
  const [theme, setTheme] = useTheme()
  const [sessions, setSessions] = useState<Session[]>([])
  const [models, setModels] = useState<Model[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [viewKey, setViewKey] = useState('draft-0')
  const [model, setModelState] = useState(lsGet(MODEL_KEY) ?? cfg.defaultModel)
  const [navOpen, setNavOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [status, setStatus] = useState<Status | null>(null)

  const setModel = (id: string) => {
    setModelState(id)
    lsSet(MODEL_KEY, id)
  }

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

  const loadModels = useCallback(async () => {
    const r = await guard(api.models())
    if (r) setModels(r.models)
  }, [guard])

  useEffect(() => {
    void refreshSessions()
    void loadModels()
    void guard(api.status()).then((s) => s && setStatus(s))
  }, [guard, refreshSessions, loadModels])

  // If the remembered model disappeared from SayGM, fall back to the server default
  useEffect(() => {
    if (models.length && !models.some((m) => m.id === model)) {
      setModel(models.some((m) => m.id === cfg.defaultModel) ? cfg.defaultModel : models[0].id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models])

  const active = sessions.find((s) => s.id === activeId) ?? null
  const modelInfo = models.find((m) => m.id === model)

  const newChat = () => {
    setActiveId(null)
    setViewKey(`draft-${Date.now()}`)
    setNavOpen(false)
  }

  const createSession = async (engine: EngineId) => {
    const r = await guard(api.createSession(engine, model))
    if (!r) return
    setSessions((s) => [r.session, ...s])
    setActiveId(r.session.id) // viewKey unchanged: the draft view keeps streaming
    return r.session
  }

  const openSession = (s: Session) => {
    setActiveId(s.id)
    setViewKey(s.id)
    setModel(s.model)
    setNavOpen(false)
  }

  const remove = async (id: string) => {
    await guard(api.deleteSession(id))
    if (activeId === id) newChat()
    void refreshSessions()
  }

  const rename = async (id: string, title: string) => {
    const t = title.trim()
    setEditingId(null)
    if (!t) return
    setSessions((all) => all.map((s) => (s.id === id ? { ...s, title: t } : s)))
    await guard(api.renameSession(id, t))
  }

  const grouped = useMemo(() => {
    const f = filter.toLowerCase()
    const out: Array<[string, Session[]]> = []
    for (const s of sessions) {
      if (f && !s.title.toLowerCase().includes(f)) continue
      const g = groupLabel(s.updated_at)
      const last = out[out.length - 1]
      if (last && last[0] === g) last[1].push(s)
      else out.push([g, [s]])
    }
    return out
  }, [sessions, filter])

  const resolved = theme === 'system' ? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme

  return (
    <div className={`shell ${navOpen ? 'nav-open' : ''}`}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">GM</div>
          <div>
            <div className="brand-name">GM Agent</div>
            <div className="brand-sub">SayGM · Ditto</div>
          </div>
        </div>
        <button className="btn primary block new-chat" onClick={newChat}>
          <IconPlus size={16} /> New chat
        </button>
        <label className="side-search">
          <IconSearch size={14} />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search chats" />
        </label>
        <nav className="sessions">
          {grouped.map(([label, list]) => (
            <div key={label}>
              <div className="group-label">{label}</div>
              {list.map((s) => (
                <div key={s.id} className={`session ${s.id === activeId ? 'active' : ''}`} onClick={() => editingId !== s.id && openSession(s)}>
                  {editingId === s.id ? (
                    <RenameInput initial={s.title} onDone={(t) => void rename(s.id, t)} onCancel={() => setEditingId(null)} />
                  ) : (
                    <>
                      <span className="title" onDoubleClick={() => setEditingId(s.id)}>{s.title}</span>
                      <span className="session-actions">
                        <button
                          className="icon-btn sm"
                          title="Rename"
                          onClick={(e) => {
                            e.stopPropagation()
                            setEditingId(s.id)
                          }}
                        >
                          <IconPencil size={13} />
                        </button>
                        <button
                          className="icon-btn sm"
                          title="Delete"
                          onClick={(e) => {
                            e.stopPropagation()
                            if (confirm(`Delete “${s.title}”?`)) void remove(s.id)
                          }}
                        >
                          <IconTrash size={13} />
                        </button>
                      </span>
                    </>
                  )}
                </div>
              ))}
            </div>
          ))}
          {!sessions.length && <p className="muted small pad">Your chats will appear here.</p>}
          {sessions.length > 0 && !grouped.length && <p className="muted small pad">No chats match “{filter}”.</p>}
        </nav>
        <footer className="side-foot">
          <button className="status-line" onClick={() => setSettingsOpen(true)} title="Connection status">
            <span className={`dot ${status ? (status.saygm.ok ? 'ok' : 'bad') : 'run'}`} /> SayGM
            <span className={`dot ${status ? (status.ditto.ok ? 'ok' : 'bad') : 'run'}`} /> Ditto
          </button>
          <span className="grow" />
          <button
            className="icon-btn"
            title={`Switch to ${resolved === 'dark' ? 'light' : 'dark'} mode`}
            onClick={() => setTheme(resolved === 'dark' ? 'light' : 'dark')}
          >
            {resolved === 'dark' ? <IconSun /> : <IconMoon />}
          </button>
          <button className="icon-btn" title="Settings" onClick={() => setSettingsOpen(true)}>
            <IconSettings />
          </button>
        </footer>
      </aside>
      <div className="scrim" onClick={() => setNavOpen(false)} />

      <main className="main">
        <header className="topbar">
          <button className="icon-btn menu" onClick={() => setNavOpen(true)} aria-label="Open chats">
            <IconMenu />
          </button>
          <div className="topbar-title">
            {active ? (
              editingId === `top-${active.id}` ? (
                <RenameInput initial={active.title} onDone={(t) => void rename(active.id, t)} onCancel={() => setEditingId(null)} />
              ) : (
                <button className="title-btn" onClick={() => setEditingId(`top-${active.id}`)} title="Rename chat">
                  <span>{active.title}</span>
                  <IconPencil size={13} />
                </button>
              )
            ) : (
              <span className="muted">New chat</span>
            )}
          </div>
          <ModelPicker models={models} value={model} onChange={setModel} />
        </header>
        <Chat
          key={viewKey}
          session={active}
          cfg={cfg}
          model={model}
          modelInfo={modelInfo}
          guard={guard}
          onCreate={createSession}
          onTurnDone={refreshSessions}
        />
      </main>

      {settingsOpen && (
        <Settings
          cfg={cfg}
          theme={theme}
          setTheme={setTheme}
          onClose={() => {
            setSettingsOpen(false)
            void guard(api.status()).then((s) => s && setStatus(s))
          }}
          onLogout={onLogout}
          onModelsRefreshed={() => void loadModels()}
        />
      )}
    </div>
  )
}

function RenameInput({ initial, onDone, onCancel }: { initial: string; onDone: (t: string) => void; onCancel: () => void }) {
  const [v, setV] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  const settled = useRef(false)
  const finish = (fn: () => void) => {
    if (settled.current) return
    settled.current = true
    fn()
  }
  useEffect(() => {
    ref.current?.select()
  }, [])
  return (
    <input
      ref={ref}
      className="rename"
      value={v}
      autoFocus
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => finish(() => onDone(v))}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(() => onDone(v))
        if (e.key === 'Escape') finish(onCancel)
      }}
    />
  )
}
