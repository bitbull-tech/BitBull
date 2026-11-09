import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, clearToken, getToken, setToken, Unauthorized, type AppConfig, type EngineId, type Model, type Project, type Session, type Status, type Swarm } from './api'
import { getBrand } from './brand'
import { BrandMark } from './BrandMark'
import { Chat } from './Chat'
import { SwarmDialog, SwarmPill } from './SwarmDialog'
import { SwarmTheatre } from './SwarmTheatre'
import { onThisPc, vaultKeyFromThisPc } from './linkHelper'
import { IconChevronRight, IconBranch, IconFolder, IconFolderMove, IconMenu, IconMoon, IconMore, IconPencil, IconPlus, IconSearch, IconSettings, IconSun, IconTrash, IconX, IconChip} from './icons'
import { ProjectDialog } from './ProjectDialog'
import { FilesDialog } from './FilesDialog'
import { ReposDialog } from './ReposDialog'
import { ExportMenu } from './ExportMenu'
import { ActivityDock, ActivityView, clearToasts, composeInChat, ErrorToasts, latestError, markErrorsSeen, reportLocal, SelectionAsk, useActivity } from './activity'
import { ModelPicker } from './ModelPicker'
import { ModelsDialog } from './ModelsDialog'
import { Settings } from './Settings'
import { useTheme } from './theme'
import { NetworkPrompt } from './network'

const MODEL_KEY = 'bitbull-model'
const EXPANDED_KEY = 'bitbull-expanded'
const DEFAULT_SEEN_KEY = 'bitbull-default-model-seen'
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
        setError('Cannot reach the BitBull server. Is `npm run dev` running?')
      }
    }
  }, [])
  useEffect(() => {
    void boot()
  }, [boot])

  if (authed === null) return <div className="center"><BrandMark className="hero-mark pulse-soft" /></div>
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
        <BrandMark className="hero-mark" />
        <h1>{getBrand().name}</h1>
        <p className="muted">{getBrand().tagline}</p>
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
  if (d.getTime() >= today.getTime() - 7 * day) return 'Previous 7 days'
  return 'Older'
}
// Date groups in the Chats list: open unless the user collapsed them; "Older" starts collapsed
const GROUP_DEFAULT_OPEN: Record<string, boolean> = { Today: true, 'Previous 7 days': true, Older: false }

/** Inside a project: Today, Previous 7 days, then one group per month ("Sep 2026"). */
function monthLabel(ts: number) {
  const g = groupLabel(ts)
  if (g !== 'Older') return g
  return new Date(ts).toLocaleDateString([], { month: 'short', year: 'numeric' })
}
function groupBy(list: Session[], label: (ts: number) => string): Array<[string, Session[]]> {
  const out: Array<[string, Session[]]> = []
  for (const s of list) {
    const g = label(s.updated_at)
    const last = out[out.length - 1]
    if (last && last[0] === g) last[1].push(s)
    else out.push([g, [s]])
  }
  return out
}

const SIDE_W_KEY = 'bitbull-side-width'
/** Drag handle on the sidebar's right edge; the width is a CSS variable on .shell, remembered per browser. */
function useSidebarWidth() {
  const [w, setW] = useState(() => {
    try {
      return Math.min(520, Math.max(220, Number(localStorage.getItem(SIDE_W_KEY)) || 276))
    } catch {
      return 276
    }
  })
  const start = (e: React.MouseEvent) => {
    e.preventDefault()
    const x0 = e.clientX
    const w0 = w
    const move = (ev: MouseEvent) => setW(Math.min(520, Math.max(220, w0 + ev.clientX - x0)))
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      setW((cur) => {
        try {
          localStorage.setItem(SIDE_W_KEY, String(cur))
        } catch {
          /* ignore */
        }
        return cur
      })
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  return { width: w, start }
}

function Shell({ cfg, onUnauthorized, onLogout }: { cfg: AppConfig; onUnauthorized: () => void; onLogout: () => void }) {
  const [theme, setTheme] = useTheme()
  const side = useSidebarWidth()
  // The vault (keys saved in Settings) unlocks on its own when the page runs on the PC that
  // holds the key; anywhere else it stays locked and .env applies.
  useEffect(() => {
    let stop = false
    void (async () => {
      try {
        const v = await api.vault()
        if (v.unlocked || !onThisPc()) return
        const key = await vaultKeyFromThisPc()
        if (!key || stop) return
        await api.vaultUnlock(key)
      } catch {
        /* locked stays locked; Settings shows why */
      }
    })()
    return () => {
      stop = true
    }
  }, [])
  const [sessions, setSessions] = useState<Session[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [models, setModels] = useState<Model[]>([])
  // The model picker asks for this by event rather than a prop, so every picker gets it
  // without threading a callback through each one (same pattern as bitbull:compose).
  const [browsingModels, setBrowsingModels] = useState(false)
  const [theatre, setTheatre] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(null)
  // Project a new (draft) chat will be created in
  const [draftProjectId, setDraftProjectId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(lsGet(EXPANDED_KEY) ?? '{}')
    } catch {
      return {}
    }
  })
  const [viewKey, setViewKey] = useState('draft-0')
  // When the server's DEFAULT_MODEL changes, adopt it once; otherwise keep the last model picked here
  const [model, setModelState] = useState(() => {
    const changed = lsGet(DEFAULT_SEEN_KEY) !== cfg.defaultModel
    lsSet(DEFAULT_SEEN_KEY, cfg.defaultModel)
    if (changed) lsSet(MODEL_KEY, cfg.defaultModel)
    return changed ? cfg.defaultModel : (lsGet(MODEL_KEY) ?? cfg.defaultModel)
  })
  const [navOpen, setNavOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [projectDialog, setProjectDialog] = useState<Project | 'new' | null>(null)
  // Files dialog: a project, or 'general' for the workspace of unfiled chats
  const [filesFor, setFilesFor] = useState<Project | 'general' | null>(null)
  const [filesDir, setFilesDir] = useState('')
  const [reposFor, setReposFor] = useState<Project | 'general' | null>(null)
  const [swarmOpen, setSwarmOpen] = useState(false)
  const [swarm, setSwarm] = useState<Swarm | null>(null)
  // right-click menu on a project row
  const [ctx, setCtx] = useState<{ p: Project; x: number; y: number } | null>(null)
  const [errCtx, setErrCtx] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    if (!ctx) return
    const close = () => (setCtx(null), setErrCtx(null))
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [ctx])
  const [filter, setFilter] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [status, setStatus] = useState<Status | null>(null)
  const [activityOpen, setActivityOpen] = useState(false)
  const { unseen } = useActivity()
  useEffect(() => {
    const close = () => setActivityOpen(false)
    window.addEventListener('bitbull:compose', close)
    return () => window.removeEventListener('bitbull:compose', close)
  }, [])

  const setModel = (id: string) => {
    setModelState(id)
    lsSet(MODEL_KEY, id)
  }
  const setExpand = (id: string, open: boolean) =>
    setExpanded((e) => {
      const next = { ...e, [id]: open }
      lsSet(EXPANDED_KEY, JSON.stringify(next))
      return next
    })

  const guard = useCallback(
    async <T,>(p: Promise<T>): Promise<T | undefined> => {
      try {
        return await p
      } catch (e) {
        if (e instanceof Unauthorized) onUnauthorized()
        else {
          console.error(e)
          reportLocal(e instanceof Error ? e.message : String(e), e instanceof Error ? e.stack : undefined)
        }
      }
    },
    [onUnauthorized],
  )

  const refreshSessions = useCallback(async () => {
    const r = await guard(api.sessions())
    if (r) setSessions(r.sessions)
  }, [guard])
  const refreshProjects = useCallback(async () => {
    const r = await guard(api.projects())
    if (r) setProjects(r.projects)
  }, [guard])
  const loadModels = useCallback(async () => {
    const r = await guard(api.models())
    if (r) setModels(r.models)
  }, [guard])

  useEffect(() => {
    void refreshSessions()
    void refreshProjects()
    void loadModels()
    void guard(api.status()).then((s) => s && setStatus(s))
  }, [guard, refreshSessions, refreshProjects, loadModels])

  // If the remembered model disappeared from SayGM, fall back to the server default
  useEffect(() => {
    if (models.length && !models.some((m) => m.id === model)) {
      setModel(models.some((m) => m.id === cfg.defaultModel) ? cfg.defaultModel : models[0].id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models])

  const active = sessions.find((s) => s.id === activeId) ?? null
  const currentProjectId = active ? active.project_id : draftProjectId
  const currentProject = projects.find((p) => p.id === currentProjectId) ?? null
  const modelInfo = models.find((m) => m.id === model)
  useEffect(() => {
    const open = () => setBrowsingModels(true)
    window.addEventListener('bitbull:browse-models', open)
    return () => window.removeEventListener('bitbull:browse-models', open)
  }, [])

  const newChat = (projectId: string | null = null) => {
    setActiveId(null)
    setDraftProjectId(projectId)
    if (projectId) setExpand(projectId, true)
    setViewKey(`draft-${Date.now()}`)
    setNavOpen(false)
  }

  const createSession = async (engine: EngineId) => {
    const r = await guard(api.createSession(engine, model, draftProjectId))
    if (!r) return
    setSessions((s) => [r.session, ...s])
    setActiveId(r.session.id) // viewKey unchanged: the draft view keeps streaming
    return r.session
  }

  /** Ditto sync: flag the project (the agent then keeps Ditto current) and run a seed in its own chat. */
  const setDittoSync = async (p: Project, on: boolean) => {
    const r = await guard(api.updateProject(p.id, { dittoSync: on }))
    if (!r) return
    await refreshProjects()
    if (on) await dittoSyncNow(r.project)
  }
  const dittoSyncNow = async (p: Project) => {
    if (!status?.ditto.ok) {
      reportLocal('Ditto is not connected: add DITTO_API_KEY in Settings first.')
      return
    }
    const r = await guard(api.dittoSyncNow(p.id))
    if (!r) return
    await refreshSessions()
    await refreshProjects()
    const s = (await guard(api.session(r.sessionId)))?.session
    if (s) openSession(s)
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

  const move = async (id: string, projectId: string | null) => {
    const r = await guard(api.moveSession(id, projectId))
    if (!r) return
    setSessions((all) => all.map((s) => (s.id === id ? r.session : s)))
    if (projectId) setExpand(projectId, true)
  }

  const f = filter.toLowerCase()
  const matches = (s: Session) => !f || s.title.toLowerCase().includes(f)
  const byProject = useMemo(() => {
    const m = new Map<string, Session[]>()
    for (const s of sessions) if (s.project_id) m.set(s.project_id, [...(m.get(s.project_id) ?? []), s])
    return m
  }, [sessions])
  const unfiled = useMemo(() => {
    return groupBy(
      sessions.filter((s) => !(s.project_id && projects.some((p) => p.id === s.project_id)) && matches(s)),
      groupLabel,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, projects, filter])

  const resolved = theme === 'system' ? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme

  const row = (s: Session) => (
    <SessionRow
      key={s.id}
      s={s}
      active={s.id === activeId}
      editing={editingId === s.id}
      projects={projects}
      onOpen={() => openSession(s)}
      onEdit={() => setEditingId(s.id)}
      onRename={(t) => void rename(s.id, t)}
      onCancel={() => setEditingId(null)}
      onMove={(pid) => void move(s.id, pid)}
      onDelete={() => {
        if (confirm(`Delete “${s.title}”?`)) void remove(s.id)
      }}
    />
  )

  return (
    <div className={`shell ${navOpen ? 'nav-open' : ''}`} style={{ ['--side-w' as string]: `${side.width}px` }}>
      <aside className="sidebar">
        <div className="brand">
          <BrandMark onDark />
          <div>
            <div className="brand-name">{getBrand().name}</div>
            <div className="brand-sub">{getBrand().tagline}</div>
          </div>
        </div>
        <button className="btn primary block new-chat" onClick={() => newChat(null)}>
          <IconPlus size={16} /> New chat
        </button>
        <label className="side-search">
          <IconSearch size={14} />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search chats" />
        </label>
        <nav className="sessions">
          <div className="section-head">
            <span>Projects</span>
            <button className="icon-btn sm" title="New project" onClick={() => setProjectDialog('new')}>
              <IconPlus size={14} />
            </button>
          </div>
          {projects.map((p) => {
            const list = (byProject.get(p.id) ?? []).filter(matches)
            const open = expanded[p.id] || (!!f && list.length > 0)
            if (f && !list.length && !p.name.toLowerCase().includes(f)) return null
            return (
              <div key={p.id} className="project">
                <div
                  className={`project-row ${currentProjectId === p.id ? 'current' : ''}`}
                  onClick={() => setExpand(p.id, !expanded[p.id])}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setCtx({ p, x: Math.min(e.clientX, window.innerWidth - 220), y: Math.min(e.clientY, window.innerHeight - 200) })
                  }}
                >
                  <IconChevronRight size={13} className={`chev ${open ? 'open' : ''}`} />
                  <span className={`pdot pc-${p.color}`} />
                  <span className="title">{p.name}</span>
                  {p.dittoSync && (
                    <span className="ditto-sync" title={`Ditto sync enabled${p.dittoSyncedAt ? ` · last sync ${new Date(p.dittoSyncedAt).toLocaleString()}` : ''}`}>
                      ◆
                    </span>
                  )}
                  <span className="count">{byProject.get(p.id)?.length ?? 0}</span>
                  <span className="session-actions">
                    <button
                      className="icon-btn sm"
                      title={`New chat in ${p.name}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        newChat(p.id)
                      }}
                    >
                      <IconPlus size={13} />
                    </button>
                    <button
                      className="icon-btn sm"
                      title={`Files in ${p.name}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        setFilesDir('')
                        setFilesFor(p)
                      }}
                    >
                      <IconFolder size={13} />
                    </button>
                    <button
                      className="icon-btn sm"
                      title={`Repositories in ${p.name}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        setReposFor(p)
                      }}
                    >
                      <IconBranch size={13} />
                    </button>
                    <button
                      className="icon-btn sm"
                      title="Project settings"
                      onClick={(e) => {
                        e.stopPropagation()
                        setProjectDialog(p)
                      }}
                    >
                      <IconSettings size={13} />
                    </button>
                  </span>
                </div>
                {open && (
                  <div className="project-chats">
                    {groupBy(list, monthLabel).map(([label, group], gi) => {
                      const key = `group:${p.id}:${label}`
                      const isOpen = !!f || (expanded[key] ?? (gi === 0 || label === 'Today' || label === 'Previous 7 days'))
                      return (
                        <div key={label} className="chat-group">
                          <button className="group-label" aria-expanded={isOpen} onClick={() => setExpand(key, !isOpen)} title={isOpen ? 'Collapse' : 'Expand'}>
                            <IconChevronRight size={12} className={`chev ${isOpen ? 'open' : ''}`} />
                            <span>{label}</span>
                            <span className="count">{group.length}</span>
                          </button>
                          {isOpen && <div className="group-chats">{group.map(row)}</div>}
                        </div>
                      )
                    })}
                    {!list.length && (
                      <button className="empty-project" onClick={() => newChat(p.id)}>
                        <IconPlus size={12} /> Start a chat in {p.name}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )
          })}
          {!projects.length && (
            <button className="empty-project" onClick={() => setProjectDialog('new')}>
              <IconFolder size={13} /> Group chats, files and instructions into a project
            </button>
          )}

          <div className="section-head chats-head">
            <span>Chats</span>
          </div>
          {unfiled.map(([label, list]) => {
            const key = `group:${label}`
            const isOpen = !!f || (expanded[key] ?? GROUP_DEFAULT_OPEN[label] ?? true)
            return (
              <div key={label} className="chat-group">
                <button
                  className="group-label"
                  aria-expanded={isOpen}
                  onClick={() => setExpand(key, !isOpen)}
                  title={isOpen ? 'Collapse' : 'Expand'}
                >
                  <IconChevronRight size={12} className={`chev ${isOpen ? 'open' : ''}`} />
                  <span>{label}</span>
                  <span className="count">{list.length}</span>
                </button>
                {isOpen && <div className="group-chats">{list.map(row)}</div>}
              </div>
            )
          })}
          {!sessions.length && <p className="muted small pad">Your chats will appear here.</p>}
        </nav>
        <footer className="side-foot">
          <button className="status-line" onClick={() => setSettingsOpen(true)} title="Connection status">
            <span className={`dot ${status ? (status.saygm.ok ? 'ok' : 'bad') : 'run'}`} /> SayGM
            <span className={`dot ${status ? (status.ditto.ok ? 'ok' : 'bad') : 'run'}`} /> Ditto
          </button>
          {unseen > 0 && (
            <button
              className="act-badge"
              onClick={() => (clearToasts(), setActivityOpen(true))}
              onContextMenu={(e) => {
                e.preventDefault()
                setErrCtx({ x: Math.min(e.clientX, window.innerWidth - 240), y: Math.min(e.clientY, window.innerHeight - 180) })
              }}
              title="Errors since you last looked · right-click for options"
            >
              {unseen} error{unseen > 1 ? 's' : ''}
            </button>
          )}
          {status?.sandbox && (
            <span
              className={`sandbox-pill ${status.sandbox.kind !== 'none' ? 'ok' : 'warn'}`}
              title={status.sandbox.kind !== 'none' ? `Agent runs in a ${status.sandbox.kind} sandbox` : 'Not sandboxed: the agent\'s shell is switched off'}
            >
              {status.sandbox.kind !== 'none' ? 'Sandboxed' : 'Shell off'}
            </span>
          )}
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
        <div className="side-resizer" onMouseDown={side.start} title="Drag to resize" />
      </aside>
      <div className="scrim" onClick={() => setNavOpen(false)} />

      <main className="main">
        <header className="topbar">
          <button className="icon-btn menu" onClick={() => setNavOpen(true)} aria-label="Open chats">
            <IconMenu />
          </button>
          <div className="topbar-title">
            {currentProject && (
              <button className="crumb" onClick={() => setProjectDialog(currentProject)} title="Project settings">
                <span className={`pdot pc-${currentProject.color}`} />
                {currentProject.name}
                <span className="crumb-sep">/</span>
              </button>
            )}
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
              <span className="muted new-label">New chat</span>
            )}
          </div>
          {active && <ExportMenu session={active} />}
          <button className="btn files-btn" title="Browse and add files and folders" onClick={() => (setFilesDir(''), setFilesFor(currentProject ?? 'general'))}>
            <IconFolder size={14} /> Files
          </button>
          <button className="btn files-btn" title="Git repositories in this workspace: branches, status, actions via the agent" onClick={() => setReposFor(currentProject ?? 'general')}>
            <IconBranch size={14} /> Repos
          </button>
          <button
            className="btn files-btn"
            title="Every model SayGM serves: price, context, capabilities and the gateway's own record"
            onClick={() => setBrowsingModels(true)}
          >
            <IconChip size={14} /> Models
          </button>
          {swarm && swarm.sessionId === active?.id ? (
            <SwarmPill
              swarm={swarm}
              onOpen={() => setTheatre(true)}
              onUpdate={setSwarm}
              onFinalTurn={(sessionId, turnId) => window.dispatchEvent(new CustomEvent('bitbull:turn-started', { detail: { sessionId, turnId } }))}
            />
          ) : (
            <button
              className="btn files-btn"
              title="QA Hound - unleash multiple LLMs on your designated repo, folder or file to review, challenge each other and summarise a verdict and recommendations."
              onClick={() => {
                // a swarm reports into a chat: start one if this is still a draft
                if (active) setSwarmOpen(true)
                else void createSession(cfg.defaultEngine).then((s) => s && setSwarmOpen(true))
              }}
            >
              <IconSearch size={14} /> QA Hound
            </button>
          )}
          <ModelPicker models={models} value={model} onChange={setModel} />
        </header>
        <Chat
          key={viewKey}
          session={active}
          project={currentProject}
          cfg={cfg}
          model={model}
          modelInfo={modelInfo}
          guard={guard}
          onCreate={createSession}
          onTurnDone={refreshSessions}
          onPickModel={setModel}
        />
        <ActivityDock sessionId={active?.id} onOpenFull={() => (clearToasts(), setActivityOpen(true))} />
      </main>
      {!activityOpen && <ErrorToasts onOpen={() => (clearToasts(), setActivityOpen(true))} />}
      <NetworkPrompt
        onOpenSession={(id) => {
          const s = sessions.find((x) => x.id === id)
          if (s) openSession(s)
        }}
      />
      {activityOpen && <ActivityView onClose={() => setActivityOpen(false)} />}
      <SelectionAsk />

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
      {theatre && swarm && (
        <SwarmTheatre
          swarm={swarm}
          onUpdate={(x) => {
            setSwarm(x)
            if (!x) setTheatre(false)
          }}
          onOpenSession={(id) => {
            setActiveId(id)
            setTheatre(false)
          }}
          onClose={() => setTheatre(false)}
        />
      )}
      {browsingModels && (
        <ModelsDialog
          models={models}
          current={model}
          onPick={(id) => {
            setModel(id)
            setBrowsingModels(false)
          }}
          onClose={() => setBrowsingModels(false)}
        />
      )}
      {filesFor && <FilesDialog project={filesFor === 'general' ? null : filesFor} startDir={filesDir} onClose={() => setFilesFor(null)} />}
      {swarmOpen && active && (
        <SwarmDialog
          session={active}
          project={currentProject}
          models={models}
          primaryModel={model}
          onClose={() => setSwarmOpen(false)}
          onStarted={(s) => {
            setSwarm(s)
            setSwarmOpen(false)
            setTheatre(true) // a QA Hound run costs real money and takes minutes: show it working
            void refreshSessions()
          }}
        />
      )}
      {reposFor && (
        <ReposDialog
          project={reposFor === 'general' ? null : reposFor}
          onClose={() => setReposFor(null)}
          onBrowse={(dir) => {
            setFilesDir(dir)
            setFilesFor(reposFor)
            setReposFor(null)
          }}
        />
      )}
      {ctx && (
        <div className="ctx-menu" style={{ left: ctx.x, top: ctx.y }} role="menu" onMouseDown={(e) => e.stopPropagation()}>
          <button onClick={() => (setCtx(null), newChat(ctx.p.id))}>
            <IconPlus size={14} /> New chat in {ctx.p.name}
          </button>
          <button onClick={() => (setCtx(null), setReposFor(ctx.p))}>
            <IconBranch size={14} /> Repositories
          </button>
          <button onClick={() => (setCtx(null), setFilesDir(''), setFilesFor(ctx.p))}>
            <IconFolder size={14} /> Files
          </button>
          <div className="sep" />
          {ctx.p.dittoSync ? (
            <>
              <button onClick={() => (setCtx(null), void dittoSyncNow(ctx.p))}>
                <IconMore size={14} /> Sync to Ditto now
              </button>
              <button onClick={() => (setCtx(null), void setDittoSync(ctx.p, false))}>
                <IconX size={14} /> Disable Ditto sync
              </button>
            </>
          ) : (
            <button onClick={() => (setCtx(null), void setDittoSync(ctx.p, true))} title="Seed Ditto from this project's imported material and keep it current">
              <IconMore size={14} /> Enable Ditto sync
            </button>
          )}
          <div className="sep" />
          <button onClick={() => (setCtx(null), setProjectDialog(ctx.p))}>
            <IconSettings size={14} /> Project settings
          </button>
        </div>
      )}
      {errCtx && (
        <div className="ctx-menu" style={{ left: errCtx.x, top: errCtx.y }} role="menu" onMouseDown={(e) => e.stopPropagation()}>
          <button onClick={() => (setErrCtx(null), clearToasts(), setActivityOpen(true))}>
            <IconSearch size={14} /> Inspect errors
          </button>
          <button
            onClick={() => {
              setErrCtx(null)
              const last = latestError()
              if (last) composeInChat(`This error just appeared in the activity log. Explain what it means and what to do about it:\n\n${last.source} · ${last.ts}\n${last.message}${last.detail ? `\n\n${last.detail}` : ''}`)
            }}
          >
            <IconPencil size={14} /> Ask the agent about the latest
          </button>
          <button
            onClick={() => {
              setErrCtx(null)
              const last = latestError()
              if (last) void navigator.clipboard?.writeText(`${last.ts} ${last.source}: ${last.message}${last.detail ? `\n${last.detail}` : ''}`)
            }}
          >
            <IconMore size={14} /> Copy the latest
          </button>
          <div className="sep" />
          <button onClick={() => (setErrCtx(null), markErrorsSeen())}>
            <IconTrash size={14} /> Clear (mark all seen)
          </button>
        </div>
      )}
      {projectDialog && (
        <ProjectDialog
          project={projectDialog === 'new' ? null : projectDialog}
          onClose={() => setProjectDialog(null)}
          onSaved={(p) => {
            setProjectDialog(null)
            void refreshProjects()
            if (projectDialog === 'new') newChat(p.id)
          }}
          onDeleted={(id) => {
            setProjectDialog(null)
            if (draftProjectId === id) setDraftProjectId(null)
            void refreshProjects()
            void refreshSessions()
          }}
        />
      )}
    </div>
  )
}

function SessionRow({
  s,
  active,
  editing,
  projects,
  onOpen,
  onEdit,
  onRename,
  onCancel,
  onMove,
  onDelete,
}: {
  s: Session
  active: boolean
  editing: boolean
  projects: Project[]
  onOpen: () => void
  onEdit: () => void
  onRename: (t: string) => void
  onCancel: () => void
  onMove: (projectId: string | null) => void
  onDelete: () => void
}) {
  const [menu, setMenu] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menu) return
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setMenu(false)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menu])
  return (
    <div ref={ref} className={`session ${active ? 'active' : ''} ${menu ? 'menu-open' : ''}`} onClick={() => !editing && onOpen()}>
      {editing ? (
        <RenameInput initial={s.title} onDone={onRename} onCancel={onCancel} />
      ) : (
        <>
          <span className="title" onDoubleClick={onEdit}>{s.title}</span>
          <span className="session-actions">
            <button
              className="icon-btn sm"
              title="More"
              onClick={(e) => {
                e.stopPropagation()
                setMenu((m) => !m)
              }}
            >
              <IconMore size={14} />
            </button>
          </span>
          {menu && (
            <div className="row-menu" onClick={(e) => e.stopPropagation()}>
              <button onClick={() => (setMenu(false), onEdit())}>
                <IconPencil size={13} /> Rename
              </button>
              <div className="menu-label">
                <IconFolderMove size={13} /> Move to
              </div>
              {projects.map((p) => (
                <button key={p.id} disabled={s.project_id === p.id} onClick={() => (setMenu(false), onMove(p.id))}>
                  <span className={`pdot pc-${p.color}`} /> {p.name}
                </button>
              ))}
              <button disabled={!s.project_id} onClick={() => (setMenu(false), onMove(null))}>
                <span className="pdot" /> No project
              </button>
              <div className="menu-sep" />
              <button className="danger" onClick={() => (setMenu(false), onDelete())}>
                <IconTrash size={13} /> Delete
              </button>
            </div>
          )}
        </>
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
