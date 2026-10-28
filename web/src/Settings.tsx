import { useEffect, useState } from 'react'
import { api, type AppConfig, type IntegrationInfo, type IntegrationStatus, type SettingGroup, type SettingRow, type Status } from './api'
import { IconCheck, IconLogout, IconMonitor, IconMoon, IconRefresh, IconSun, IconX } from './icons'
import type { ThemePref } from './theme'
import { getBrand } from './brand'
import { BrandMark } from './BrandMark'
import { NetworkPanel } from './network'

type Tab = 'status' | 'integrations' | 'network' | 'config' | 'appearance'

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
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null)

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
              ['integrations', 'Integrations'],
              ['network', 'Network'],
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
                <StatusCard
                  title="Hippius storage"
                  ok={status ? status.storage?.ok : undefined}
                  loading={!status}
                  detail={status?.storage?.detail ?? 'Not configured'}
                />
                <StatusCard
                  title="Agent sandbox"
                  ok={status ? status.sandbox?.kind !== 'none' : undefined}
                  loading={!status}
                  detail={
                    status?.sandbox?.kind && status.sandbox.kind !== 'none'
                      ? `${status.sandbox.kind} container · shell confined · internet: ${status.sandbox.egress === 'allowlist' ? 'allowlist only' : 'open'}`
                      : 'Running on your computer · agent shell switched off. Start with docker compose to sandbox it.'
                  }
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

              <h3>Subagents</h3>
              {status?.subagents?.length ? (
                <ul className="skill-list">
                  {status.subagents.map((a) => (
                    <li key={a.name}>
                      <code>{a.name}</code>
                      <span>
                        <span className="tag">{a.access === 'write' ? 'can edit' : 'read-only'}</span>{' '}
                        <span className="tag">{a.model === 'inherit' ? 'chat model' : a.model}</span> {a.description}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">No subagents. Add definitions under <code>subagents/</code>.</p>
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

          {tab === 'integrations' && <Integrations />}
          {tab === 'network' && <NetworkPanel />}

          {tab === 'config' && (
            <>
              <p className="muted small">
                Keys and settings marked <b>Edit</b> can be changed here: they're saved on the GM server (in its data folder, readable only by
                GM) and take effect straight away, overriding <code>.env</code>. <b>Use .env</b> removes the override. Everything else, including
                access and sandbox settings, can only be changed in <code>.env</code> followed by a deploy. Secrets are never shown in full.
              </p>
              {saveMsg && <p className={`small ${saveMsg.ok ? '' : 'lv-error-text'}`}>{saveMsg.text}</p>}
              {!groups && <p className="muted">Loading…</p>}
              {groups?.map((g) => (
                <section key={g.id} className="cfg-group">
                  <h3>{g.title}</h3>
                  <div className="cfg-table">
                    {g.rows.map((r) => (
                      <ConfigRow
                        key={r.env}
                        r={r}
                        onSaved={(groups, text) => {
                          setGroups(groups)
                          setSaveMsg({ ok: true, text })
                          void check()
                        }}
                        onError={(text) => setSaveMsg({ ok: false, text })}
                      />
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
              <h3>Branding</h3>
              <div className="brand-panel">
                <BrandMark className="brand-mark" />
                <div className="grow">
                  <div className="brand-name">{getBrand().name}</div>
                  <div className="muted small">
                    {getBrand().logo ? 'Using your logo' : 'Using the built-in mark'}
                    {' · '}
                    {Object.keys(getBrand().tokens.light).length + Object.keys(getBrand().tokens.dark).length} colour override
                    {Object.keys(getBrand().tokens.light).length + Object.keys(getBrand().tokens.dark).length === 1 ? '' : 's'}
                  </div>
                </div>
              </div>
              <p className="muted small">
                Name, logo and colours come from <code>brand.json</code> in the data folder, with images in{' '}
                <code>brand/</code> beside it. Edit the file and reload this page: there is nothing to rebuild or deploy.
                See <code>docs/BRANDING.md</code>.
              </p>
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

const SOURCE_LABEL = { ui: 'set here', env: '.env', default: 'default' } as const

function ConfigRow({
  r,
  onSaved,
  onError,
}: {
  r: SettingRow
  onSaved: (groups: SettingGroup[], msg: string) => void
  onError: (msg: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [reveal, setReveal] = useState(false)
  const [busy, setBusy] = useState(false)
  const save = async (v: string | null) => {
    setBusy(true)
    try {
      const res = await api.updateSettings({ [r.env]: v })
      onSaved(res.groups, v === null ? `${r.env} now comes from .env (or its default).` : `${r.env} saved and applied.`)
      setEditing(false)
      setValue('')
    } catch (e) {
      onError(e instanceof Error ? e.message.replace(/^\d+ /, '') : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="cfg-row">
      <div className="cfg-label">
        {r.label}
        {r.hint && <div className="cfg-hint">{r.hint}</div>}
      </div>
      <div className="cfg-val">
        {!editing ? (
          <div className="cfg-current">
            <code className={r.secret ? 'secret' : ''}>{r.value}</code>
            {r.editable && (
              <button className="btn sm" onClick={() => (setEditing(true), setValue(r.secret ? '' : r.value === '(not set)' ? '' : r.value))}>
                Edit
              </button>
            )}
            {r.editable && r.source === 'ui' && (
              <button className="link" disabled={busy} onClick={() => void save(null)} title="Remove the value set here">
                Use .env
              </button>
            )}
          </div>
        ) : (
          <form
            className="cfg-edit"
            onSubmit={(e) => {
              e.preventDefault()
              void save(value)
            }}
          >
            {r.options ? (
              <select value={value} onChange={(e) => setValue(e.target.value)} autoFocus>
                {r.options.map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
            ) : (
              <input
                type={r.secret && !reveal ? 'password' : 'text'}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={r.secret ? 'Paste the new key' : ''}
                autoComplete="off"
                spellCheck={false}
                autoFocus
              />
            )}
            {r.secret && (
              <button type="button" className="link" onClick={() => setReveal((x) => !x)}>
                {reveal ? 'Hide' : 'Show'}
              </button>
            )}
            {r.env === 'HIPPIUS_ENCRYPTION_KEY' && (
              <button
                type="button"
                className="btn sm"
                disabled={busy}
                title="32 random bytes, generated on the server"
                onClick={() => {
                  if (r.value !== '(not set)' && !confirm('Replace the existing key?\n\nEverything already stored on Hippius was encrypted with the old key and will no longer be readable. Only do this if nothing is stored yet, or you still have the old key safe.'))
                    return
                  setBusy(true)
                  void api
                    .newStorageKey()
                    .then((res) => {
                      setValue(res.key)
                      setReveal(true) // it is shown once here: they have to be able to copy it
                    })
                    .catch((e) => onError(e instanceof Error ? e.message : String(e)))
                    .finally(() => setBusy(false))
                }}
              >
                Generate
              </button>
            )}
            <button type="submit" className="btn sm primary" disabled={busy || !value.trim()}>
              {busy ? 'Saving…' : 'Save'}
            </button>
            {r.env === 'HIPPIUS_ENCRYPTION_KEY' && value && (
              <span className="cfg-warn small">Copy this somewhere safe before saving — it is not shown again, and without it nothing stored can be read back.</span>
            )}
            <button type="button" className="btn sm" onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </button>
          </form>
        )}
        <div className="cfg-env">
          {r.env}
          <span className={`tag src-${r.source ?? 'env'}`}>{SOURCE_LABEL[r.source ?? (r.isDefault ? 'default' : 'env')]}</span>
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

function Integrations() {
  const [info, setInfo] = useState<{ integrations: IntegrationInfo[]; atlasWorkflows: { file: string; title: string; inputs: string[] }[]; likenessPolicy: string } | null>(null)
  const [live, setLive] = useState<IntegrationStatus[] | null>(null)
  useEffect(() => {
    void api.integrations().then(setInfo)
    void api.integrationStatus().then((r) => setLive(r.integrations))
  }, [])
  if (!info) return <p className="muted">Loading…</p>
  return (
    <>
      <p className="muted small">
        External creative services the agent can use. Set the keys in <code>.env</code> and restart, then switch an integration on per project
        (project settings). MCP tools only reach chats in projects that enable them.
      </p>
      {info.integrations.map((i) => {
        const st = live?.find((l) => l.id === i.id)
        return (
          <section key={i.id} className="int-card">
            <div className="int-head">
              <div className={`status-card mini ${!st ? '' : st.ok ? 'ok' : i.configured ? 'bad' : ''}`}>
                <span className="pulse" />
              </div>
              <div className="grow">
                <b>{i.name}</b>
                <div className="muted small">{i.blurb}</div>
              </div>
              <a className="btn" href={i.docs} target="_blank" rel="noreferrer">Docs</a>
            </div>
            <div className="int-status small">{st ? st.detail : 'Checking…'}</div>
            <div className="cfg-table">
              {i.env.map((e) => (
                <div className="cfg-row" key={e.key}>
                  <div className="cfg-label">{e.label}</div>
                  <div className="cfg-val">
                    <code>{e.set ? e.value || 'set' : '(not set)'}</code>
                    <div className="cfg-env">{e.key}</div>
                  </div>
                </div>
              ))}
            </div>
            {i.notes && <p className="muted small">{i.notes}</p>}
            {i.id === 'atlas' && (
              <>
                <h3>Exported Atlas workflows</h3>
                {info.atlasWorkflows.length ? (
                  <ul className="skill-list">
                    {info.atlasWorkflows.map((w) => (
                      <li key={w.file}>
                        <code>{w.file}</code>
                        <span>{w.title}{w.inputs.length ? ` · inputs: ${w.inputs.join(', ')}` : ''}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted small">None yet. In Atlas, export a workflow as an API and save its JSON into the workflows folder above.</p>
                )}
              </>
            )}
          </section>
        )
      })}
      <h3>Heritage likeness policy</h3>
      <p className="small">
        <code>{info.likenessPolicy}</code> —{' '}
        {info.likenessPolicy === 'private-likeness'
          ? 'family photos may be animated in private, labelled projects with the uploader\'s confirmation.'
          : 'real people appear only through their original images; generated video and 3D are used for the world around them.'}{' '}
        Set <code>HERITAGE_LIKENESS_POLICY</code> in <code>.env</code>.
      </p>
    </>
  )
}
