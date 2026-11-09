import { useEffect, useRef, useState } from 'react'
import { api, type AppConfig, type IntegrationInfo, type IntegrationStatus, type SettingGroup, type SettingRow, type Status } from './api'
import { IconCheck, IconLogout, IconMonitor, IconMoon, IconRefresh, IconSun, IconX } from './icons'
import type { ThemePref } from './theme'
import { applyBrand, getBrand, PRESETS, type Scheme, type SchemePart } from './brand'
import { BrandMark } from './BrandMark'
import { NetworkPanel } from './network'
import { FoldersPanel } from './Folders'
import { HELPER_HINT, vaultKeyFromThisPc } from './linkHelper'
import settingsArt from './assets/settings-dog.webp'
import { VoicePanel } from './voice/VoicePanel'

type Tab = 'status' | 'integrations' | 'folders' | 'network' | 'config' | 'voice' | 'appearance'

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
  const [info, setInfo] = useState<{ integrations: IntegrationInfo[]; atlasWorkflows: { file: string; title: string; inputs: string[] }[]; likenessPolicy: string } | null>(null)
  const [live, setLive] = useState<IntegrationStatus[] | null>(null)
  const [focus, setFocus] = useState<string | null>(null)

  const onRowSaved = (next: SettingGroup[], text: string) => {
    setGroups(next)
    setSaveMsg({ ok: true, text })
    void check()
  }
  /** From a Status card to that service's card under Integrations */
  const openIntegration = (id: string) => {
    setTab('integrations')
    setFocus(id)
    window.setTimeout(() => document.getElementById(`int-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60)
  }

  const check = async () => {
    setChecking(true)
    try {
      const [st, li] = await Promise.all([api.status(), api.integrationStatus().catch(() => ({ integrations: [] as IntegrationStatus[] }))])
      setStatus(st)
      setLive(li.integrations)
    } finally {
      setChecking(false)
    }
  }

  useEffect(() => {
    void check()
    void api.settings().then((r) => setGroups(r.groups))
    void api.integrations().then(setInfo).catch(() => {})
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal settings-modal" role="dialog" aria-label="Settings">
        <div className="settings-top">
          <img className="settings-art" src={settingsArt} alt="" draggable={false} />
          <div className="settings-top-main">
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
              ['config', 'Configuration'],
              ['folders', 'Folders'],
              ['network', 'Network'],
              ['voice', 'Voice'],
              ['appearance', 'Appearance'],
            ] as const
          ).map(([id, label]) => (
            <button key={id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </nav>
          </div>
        </div>

        <div className="modal-body">
          {tab === 'status' && (
            <>
              <p className="muted small">At a glance. Click a service to set it up under Integrations.</p>
              <div className="status-grid">
                {SERVICES.map((svc) => {
                  const st = serviceState(svc.id, status, live, groups)
                  return (
                    <button key={svc.id} className={`status-card as-link ${st.loading ? '' : st.ok ? 'ok' : st.configured ? 'bad' : 'off'}`} onClick={() => openIntegration(svc.id)}>
                      <div className="status-title">
                        <span className="pulse" />
                        {svc.name}
                      </div>
                      <div className="status-detail">{st.loading ? 'Checking…' : st.detail}</div>
                    </button>
                  )
                })}
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
              </div>
            </>
          )}

          {tab === 'integrations' && (
            <>
              <p className="muted small">
                The services BitBull connects to. Keys marked <b>Edit</b> can be changed here and apply straight away, overriding <code>.env</code>;
                while the vault is unlocked they are saved there, encrypted (Configuration → Vault). <b>Use .env</b> removes the override. Secrets are
                never shown in full.
              </p>
              {saveMsg && <p className={`small ${saveMsg.ok ? '' : 'lv-error-text'}`}>{saveMsg.text}</p>}
              {!groups && <p className="muted">Loading…</p>}
              {groups &&
                SERVICES.map((svc) => {
                  const g = groups.find((x) => x.id === svc.id)
                  const st = serviceState(svc.id, status, live, groups)
                  const meta = info?.integrations.find((i) => i.id === svc.id)
                  return (
                    <section key={svc.id} id={`int-${svc.id}`} className={`int-card ${focus === svc.id ? 'focus' : ''}`}>
                      <div className="int-head">
                        <div className={`status-card mini ${st.loading ? '' : st.ok ? 'ok' : st.configured ? 'bad' : 'off'}`}>
                          <span className="pulse" />
                        </div>
                        <div className="grow">
                          <b>{svc.name}</b>
                          <div className="muted small">{meta?.blurb ?? svc.blurb}</div>
                        </div>
                        <a className="btn" href={meta?.docs ?? svc.docs} target="_blank" rel="noreferrer">
                          Docs
                        </a>
                      </div>
                      <div className="int-status small">{st.loading ? 'Checking…' : st.detail}</div>
                      {g && (
                        <div className="cfg-table">
                          {g.rows.map((r) => (
                            <ConfigRow key={r.env} r={r} onSaved={onRowSaved} onError={(text) => setSaveMsg({ ok: false, text })} />
                          ))}
                        </div>
                      )}
                      {meta?.notes && <p className="muted small">{meta.notes}</p>}
                      {meta?.hasMcp && (
                        <p className="muted small">Its MCP tools reach a chat only in projects that switch it on (project settings).</p>
                      )}
                      {svc.id === 'saygm' && (
                        <div className="row-actions">
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
                            <IconRefresh size={14} /> {refreshing ? 'Refreshing…' : 'Reload model list'}
                          </button>
                        </div>
                      )}
                      {svc.id === 'atlas' && info && (
                        <>
                          <h3>Exported Atlas workflows</h3>
                          {info.atlasWorkflows.length ? (
                            <ul className="skill-list">
                              {info.atlasWorkflows.map((w) => (
                                <li key={w.file}>
                                  <code>{w.file}</code>
                                  <span>
                                    {w.title}
                                    {w.inputs.length ? ` · inputs: ${w.inputs.join(', ')}` : ''}
                                  </span>
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
            </>
          )}
          {tab === 'folders' && <FoldersPanel />}
          {tab === 'network' && <NetworkPanel />}

          {tab === 'config' && (
            <>
              <p className="muted small">
                How BitBull itself runs: engine and models, the sandbox, the vault, skills and subagents. Settings marked <b>Edit</b> apply straight
                away, overriding <code>.env</code>; access and sandbox settings can only be changed in <code>.env</code> followed by a deploy. Keys for
                outside services are under Integrations.
              </p>
              <VaultPanel />
              {saveMsg && <p className={`small ${saveMsg.ok ? '' : 'lv-error-text'}`}>{saveMsg.text}</p>}
              {!groups && <p className="muted">Loading…</p>}
              {groups
                ?.filter((g) => !SERVICES.some((svc) => svc.id === g.id))
                .map((g) => (
                  <section key={g.id} className="cfg-group">
                    <h3>{g.id === 'bitbull' ? 'Agent and runtime' : g.title}</h3>
                    <div className="cfg-table">
                      {g.rows.map((r) => (
                        <ConfigRow key={r.env} r={r} onSaved={onRowSaved} onError={(text) => setSaveMsg({ ok: false, text })} />
                      ))}
                    </div>
                  </section>
                ))}

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
                <p className="muted">{status ? <>No skills yet. Add folders under <code>skills/</code>.</> : 'Loading…'}</p>
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
                <p className="muted">{status ? <>No subagents. Add definitions under <code>subagents/</code>.</> : 'Loading…'}</p>
              )}

              <h3>Runtime</h3>
              <dl className="kv">
                <dt>Engines</dt>
                <dd>{cfg.engines.map((e) => e.label).join(' · ')}</dd>
                <dt>Workspace</dt>
                <dd>
                  <code>{status?.workspace ?? '…'}</code>
                </dd>
                <dt>System prompt</dt>
                <dd>{status ? (status.systemPromptFound ? 'agent/SYSTEM.md loaded' : 'not found') : '…'}</dd>
                <dt>Node</dt>
                <dd>{status?.node ?? '…'}</dd>
              </dl>
            </>
          )}

          {tab === 'voice' && <VoicePanel />}

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
              <ColourPanel />
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

/**
 * The vault: keys saved here are encrypted on the server with a key that lives on this PC
 * (kept by the link helper under Windows DPAPI). Unlock happens on its own when the page runs
 * on that PC; elsewhere the vault stays locked and .env applies.
 */
function VaultPanel() {
  const [v, setV] = useState<{ unlocked: boolean; exists: boolean; keys: string[] } | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const load = () => void api.vault().then(setV).catch(() => setV(null))
  useEffect(load, [])
  const unlock = async () => {
    setMsg(null)
    const key = await vaultKeyFromThisPc()
    if (!key) return setMsg(`No vault key from this PC: ${HELPER_HINT}`)
    try {
      const r = await api.vaultUnlock(key)
      setMsg(r.moved.length ? `Unlocked; moved ${r.moved.join(', ')} out of settings.local.json into the vault.` : 'Unlocked.')
      load()
      window.dispatchEvent(new CustomEvent('bitbull:settings-changed'))
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    }
  }
  const lock = async () => {
    await api.vaultLock().catch(() => {})
    setMsg('Locked: .env values apply until the next unlock.')
    load()
  }
  if (!v) return null
  return (
    <section className="cfg-group vault">
      <h3>Vault</h3>
      <p className="muted small">
        API keys saved here go into an encrypted vault on the server (AES-256-GCM). The key to it is kept on this PC by the link helper, not by
        BitBull, so the agent's own shell can't read your keys. {v.unlocked ? <b>Unlocked</b> : <b>Locked</b>}
        {v.keys.length ? ` · holds ${v.keys.join(', ')}` : v.exists ? '' : ' · not created yet (created at the first unlock)'}.
      </p>
      <div className="row-actions">
        {v.unlocked ? (
          <button className="btn sm" onClick={lock}>
            Lock
          </button>
        ) : (
          <button className="btn sm primary" onClick={unlock}>
            Unlock from this PC
          </button>
        )}
      </div>
      {msg && <p className="small">{msg}</p>}
    </section>
  )
}

const SOURCE_LABEL = { ui: 'set here', vault: 'vault', env: '.env', default: 'default' } as const
const SOURCE_HINT = {
  ui: 'Saved from this page in settings.local.json on the server; overrides .env',
  vault: 'Saved from this page in the encrypted vault; overrides .env',
  env: 'Comes from the .env file in the repo (copied in at deploy)',
  default: 'Not set anywhere; the built-in default applies',
} as const

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
            {r.editable && (r.source === 'ui' || r.source === 'vault') && (
              <button className="link" disabled={busy} onClick={() => void save(null)} title="Drop the value saved in the UI so the one in .env (or the default) applies again">
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
          <span className={`tag src-${r.source ?? 'env'}`} title={SOURCE_HINT[r.source ?? (r.isDefault ? 'default' : 'env')]}>
            {SOURCE_LABEL[r.source ?? (r.isDefault ? 'default' : 'env')]}
          </span>
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

/* ---------------- services ---------------- */

/** The outside services, in the order Status and Integrations show them. Ids match the server's setting groups. */
const SERVICES: { id: string; name: string; blurb: string; docs: string }[] = [
  { id: 'saygm', name: 'SayGM', blurb: 'The model gateway: one key, every model in the picker.', docs: 'https://saygm.com' },
  { id: 'ditto', name: 'Ditto memory', blurb: 'Long-term memory shared by every chat and model.', docs: 'https://heyditto.ai' },
  { id: 'github', name: 'GitHub', blurb: 'Clone, pull, push and open PRs from the agent’s shell.', docs: 'https://github.com/settings/personal-access-tokens' },
  { id: 'taostats', name: 'Taostats', blurb: 'Bittensor network data (subnets, validators, prices) for the taostats-api skill.', docs: 'https://docs.taostats.io' },
  { id: 'atlas', name: 'Atlas AI Studio', blurb: 'Images, video, 3D and animation workflows.', docs: 'https://docs.atlas.design' },
  { id: 'four04', name: '404.xyz (404—GEN)', blurb: 'Text-to-3D generation on Bittensor.', docs: 'https://www.404.xyz' },
  { id: 'hippius', name: 'Hippius storage', blurb: 'Encrypted copies of your uploads on decentralised S3 storage.', docs: 'https://hippius.com' },
]

/** One line of state for a service, from whichever check covers it. */
function serviceState(
  id: string,
  status: Status | null,
  live: IntegrationStatus[] | null,
  groups: SettingGroup[] | null,
): { loading: boolean; ok: boolean; configured: boolean; detail: string } {
  switch (id) {
    case 'saygm':
      if (!status) return { loading: true, ok: false, configured: true, detail: '' }
      return {
        loading: false,
        ok: status.saygm.ok,
        configured: true,
        detail: status.saygm.ok ? `${status.saygm.models} chat models · ${status.saygm.ms} ms` : status.saygm.error ?? 'Not reachable',
      }
    case 'ditto':
      if (!status) return { loading: true, ok: false, configured: true, detail: '' }
      return { loading: false, ok: status.ditto.ok, configured: status.ditto.error !== 'DITTO_API_KEY not set', detail: status.ditto.ok ? `${status.ditto.tools} memory tools` : status.ditto.error ?? 'Not connected' }
    case 'hippius':
      if (!status) return { loading: true, ok: false, configured: true, detail: '' }
      return { loading: false, ok: !!status.storage?.ok, configured: !!status.storage?.configured, detail: status.storage?.detail ?? 'Not configured' }
    case 'taostats': {
      // no live probe: the agent calls it, BitBull only holds the key
      const row = groups?.find((g) => g.id === 'taostats')?.rows.find((r) => r.env === 'TAOSTATS_API_KEY')
      if (!row) return { loading: !groups, ok: false, configured: false, detail: '' }
      const set = row.value !== '(not set)'
      return { loading: false, ok: set, configured: set, detail: set ? 'Key set · the agent uses it through the taostats-api skill' : 'Not configured: add an API key below' }
    }
    default: {
      const st = live?.find((l) => l.id === id)
      if (!st) return { loading: !live, ok: false, configured: false, detail: live ? 'Not configured' : '' }
      return { loading: false, ok: st.ok, configured: st.configured, detail: st.detail }
    }
  }
}

/* ---------------- colours ---------------- */

const DEFAULTS: Record<'light' | 'dark', Required<SchemePart>> = {
  light: { bg: '#faf7ef', side: '#16150f' },
  dark: { bg: '#0d0d0b', side: '#0a0a09' },
}
const same = (a: Scheme, b: Scheme) => JSON.stringify(a) === JSON.stringify(b)
const clone = (s: Scheme): Scheme => ({ light: { ...s.light }, dark: { ...s.dark } })

/**
 * Background and sidebar colour for each theme. Changes show at once and are saved to brand.json
 * a moment later, so they apply in every browser and in the desktop app. Everything else in the
 * palette (panels, lines, text, the sidebar's text and accent) is worked out from these two.
 */
function ColourPanel() {
  const [scheme, setScheme] = useState<Scheme>(() => clone(getBrand().scheme ?? { light: {}, dark: {} }))
  const [saved, setSaved] = useState<Scheme>(scheme)
  const [state, setState] = useState<{ ok: boolean; text: string } | null>(null)

  // preview immediately
  useEffect(() => {
    applyBrand({ ...getBrand(), scheme })
  }, [scheme])

  // save shortly after the last change
  useEffect(() => {
    if (same(scheme, saved)) return
    const t = window.setTimeout(() => {
      api
        .saveAppearance(scheme)
        .then((b) => {
          setSaved(clone(b.scheme))
          setState({ ok: true, text: 'Saved' })
        })
        .catch((e) => setState({ ok: false, text: e instanceof Error ? e.message : String(e) }))
    }, 500)
    return () => window.clearTimeout(t)
  }, [scheme, saved])

  const set = (mode: 'light' | 'dark', key: 'bg' | 'side', value: string | undefined) =>
    setScheme((cur) => {
      const next = clone(cur)
      if (value) next[mode][key] = value.toLowerCase()
      else delete next[mode][key]
      return next
    })

  // closing Settings inside the half-second still saves the last change
  const latest = useRef({ scheme, saved })
  latest.current = { scheme, saved }
  useEffect(
    () => () => {
      const { scheme: s, saved: v } = latest.current
      if (!same(s, v)) void api.saveAppearance(s).catch(() => {})
    },
    [],
  )

  const active = PRESETS.find((p) => same(p.scheme, scheme))?.id

  return (
    <>
      <h3>Colours</h3>
      <div className="scheme-presets">
        {PRESETS.map((p) => {
          const l = { ...DEFAULTS.light, ...p.scheme.light }
          const d = { ...DEFAULTS.dark, ...p.scheme.dark }
          return (
            <button key={p.id} className={`scheme-card ${active === p.id ? 'on' : ''}`} onClick={() => setScheme(clone(p.scheme))} title={`${p.name}: light and dark`}>
              <span className="scheme-swatch" aria-hidden="true">
                <i style={{ background: l.side }} />
                <i style={{ background: l.bg }} />
                <i style={{ background: d.side }} />
                <i style={{ background: d.bg }} />
              </span>
              <span className="scheme-name">
                {p.name}
                {active === p.id && <IconCheck size={13} />}
              </span>
            </button>
          )
        })}
      </div>
      <div className="scheme-grid">
        {(['light', 'dark'] as const).map((mode) => (
          <div key={mode} className="scheme-col">
            <div className="scheme-mode">{mode === 'light' ? <IconSun size={14} /> : <IconMoon size={14} />} {mode === 'light' ? 'Light' : 'Dark'} theme</div>
            {(['bg', 'side'] as const).map((key) => (
              <label key={key} className="scheme-row">
                <input type="color" value={scheme[mode][key] ?? DEFAULTS[mode][key]} onChange={(e) => set(mode, key, e.target.value)} />
                <span className="grow">{key === 'bg' ? 'Background' : 'Sidebar'}</span>
                {scheme[mode][key] ? (
                  <button className="link small" onClick={() => set(mode, key, undefined)}>
                    Default
                  </button>
                ) : (
                  <span className="muted small">Default</span>
                )}
              </label>
            ))}
          </div>
        ))}
      </div>
      <p className="muted small">
        Applies everywhere BitBull is opened: it is saved in <code>brand.json</code> in the data folder. Text, panels and the sidebar's accent
        follow the colours you pick, so any colour stays readable.
        {state && <span className={state.ok ? 'ok-text' : 'error'}> {state.text}.</span>}
      </p>
    </>
  )
}
