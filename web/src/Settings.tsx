import { useEffect, useState } from 'react'
import { api, type AppConfig, type SettingGroup, type Status } from './api'
import { IconCheck, IconLogout, IconMonitor, IconMoon, IconRefresh, IconSun, IconX } from './icons'
import type { ThemePref } from './theme'

type Tab = 'status' | 'config' | 'appearance'

export function Settings({
  cfg,
  theme,
  setTheme,
  onClose,
  onLogout,
  onModelsRefreshed,
}: {
  cfg: AppConfig
  theme: ThemePref
  setTheme: (t: ThemePref) => void
  onClose: () => void
  onLogout: () => void
  onModelsRefreshed: () => void
}) {
  const [tab, setTab] = useState<Tab>('status')
  const [status, setStatus] = useState<Status | null>(null)
  const [groups, setGroups] = useState<SettingGroup[] | null>(null)
  const [checking, setChecking] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const check = async () => {
    setChecking(true)
    try {
      setStatus(await api.status())
    } finally {
      setChecking(false)
    }
  }

  useEffect(() => {
    void check()
    void api.settings().then((r) => setGroups(r.groups))
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Settings">
        <header className="modal-head">
          <h2>Settings</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <IconX />
          </button>
        </header>
        <nav className="seg tabs">
          {(
            [
              ['status', 'Status'],
              ['config', 'Configuration'],
              ['appearance', 'Appearance'],
            ] as const
          ).map(([id, label]) => (
            <button key={id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </nav>

        <div className="modal-body">
          {tab === 'status' && (
            <>
              <div className="status-grid">
                <StatusCard
                  title="SayGM"
                  ok={status?.saygm.ok}
                  loading={!status}
                  detail={
                    status?.saygm.ok
                      ? `${status.saygm.models} chat models · ${status.saygm.ms} ms`
                      : status?.saygm.error ?? 'Not reachable'
                  }
                />
                <StatusCard
                  title="Ditto memory"
                  ok={status?.ditto.ok}
                  loading={!status}
                  detail={status?.ditto.ok ? `${status.ditto.tools} memory tools · archive: ${cfg.ditto.archive}` : status?.ditto.error ?? 'Not connected'}
                />
              </div>
              <div className="row-actions">
                <button className="btn" onClick={() => void check()} disabled={checking}>
                  <IconRefresh size={14} /> {checking ? 'Checking…' : 'Re-check connections'}
                </button>
                <button
                  className="btn"
                  disabled={refreshing}
                  onClick={async () => {
                    setRefreshing(true)
                    try {
                      await api.refreshModels()
                      onModelsRefreshed()
                    } finally {
                      setRefreshing(false)
                    }
                  }}
                >
                  <IconRefresh size={14} /> {refreshing ? 'Refreshing…' : 'Reload SayGM model list'}
                </button>
              </div>

              <h3>Skills</h3>
              {status?.skills.length ? (
                <ul className="skill-list">
                  {status.skills.map((s) => (
                    <li key={s.name}>
                      <code>{s.name}</code>
                      <span>{s.description}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">No skills yet. Add folders under <code>skills/</code>.</p>
              )}

              <h3>Runtime</h3>
              <dl className="kv">
                <dt>Engines</dt>
                <dd>{cfg.engines.map((e) => e.label).join(' · ')}</dd>
                <dt>Workspace</dt>
                <dd><code>{status?.workspace ?? '…'}</code></dd>
                <dt>System prompt</dt>
                <dd>{status ? (status.systemPromptFound ? 'agent/SYSTEM.md loaded' : 'not found') : '…'}</dd>
                <dt>Node</dt>
                <dd>{status?.node ?? '…'}</dd>
              </dl>
            </>
          )}

          {tab === 'config' && (
            <>
              <p className="muted small">
                What the server is running with right now. Change values in <code>.env</code> and restart <code>npm run dev</code>.
                Secrets are masked.
              </p>
              {!groups && <p className="muted">Loading…</p>}
              {groups?.map((g) => (
                <section key={g.id} className="cfg-group">
                  <h3>{g.title}</h3>
                  <div className="cfg-table">
                    {g.rows.map((r) => (
                      <div className="cfg-row" key={r.env}>
                        <div className="cfg-label">
                          {r.label}
                          {r.hint && <div className="cfg-hint">{r.hint}</div>}
                        </div>
                        <div className="cfg-val">
                          <code className={r.secret ? 'secret' : ''}>{r.value}</code>
                          <div className="cfg-env">
                            {r.env}
                            {r.isDefault && <span className="tag">default</span>}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </>
          )}

          {tab === 'appearance' && (
            <>
              <h3>Theme</h3>
              <div className="theme-pick">
                {(
                  [
                    ['system', 'System', <IconMonitor key="m" />],
                    ['light', 'Light', <IconSun key="s" />],
                    ['dark', 'Dark', <IconMoon key="d" />],
                  ] as const
                ).map(([id, label, icon]) => (
                  <button key={id} className={`theme-card ${theme === id ? 'on' : ''}`} onClick={() => setTheme(id)}>
                    <span className={`theme-swatch sw-${id}`} />
                    <span className="theme-label">
                      {icon} {label}
                      {theme === id && <IconCheck size={14} />}
                    </span>
                  </button>
                ))}
              </div>
              <h3>Session</h3>
              <button className="btn danger" onClick={onLogout}>
                <IconLogout size={14} /> Sign out of this browser
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function StatusCard({ title, ok, loading, detail }: { title: string; ok?: boolean; loading: boolean; detail: string }) {
  return (
    <div className={`status-card ${loading ? '' : ok ? 'ok' : 'bad'}`}>
      <div className="status-title">
        <span className="pulse" />
        {title}
      </div>
      <div className="status-detail">{loading ? 'Checking…' : detail}</div>
    </div>
  )
}
