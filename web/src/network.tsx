import { useEffect, useState, useSyncExternalStore } from 'react'
import { api, type NetworkState } from './api'
import { onLiveActivity, reportLocal } from './activity'
import { IconLock, IconTrash } from './icons'

/* ---------------- store: one copy of the network state for the prompt and Settings ---------------- */

let state: NetworkState | null = null
const subs = new Set<() => void>()
const emit = () => subs.forEach((f) => f())
let started = false
let loading: Promise<void> | null = null

export function refreshNetwork() {
  loading ??= api
    .network()
    .then((s) => {
      state = s
      emit()
    })
    .catch(() => {
      /* offline or unauthorised: the rest of the UI reports that */
    })
    .finally(() => {
      loading = null
    })
  return loading
}

function start() {
  if (started) return
  started = true
  void refreshNetwork()
  // Requests and refusals are announced on the activity feed; poll as a fallback
  onLiveActivity((e) => {
    if (e.source === 'network') void refreshNetwork()
  })
  setInterval(() => {
    if (document.visibilityState === 'visible') void refreshNetwork()
  }, 20000)
}

export function useNetwork() {
  useEffect(start, [])
  return useSyncExternalStore(
    (f) => {
      subs.add(f)
      return () => {
        subs.delete(f)
      }
    },
    () => state,
  )
}

function apply(p: Promise<NetworkState>) {
  return p
    .then((s) => {
      state = s
      emit()
    })
    .catch((e) => reportLocal(e instanceof Error ? e.message : String(e)))
}

/* ---------------- the prompt: the agent is waiting on an answer ---------------- */

export function NetworkPrompt({ onOpenSession }: { onOpenSession?: (id: string) => void }) {
  const net = useNetwork()
  const [busy, setBusy] = useState<string | null>(null)
  const pending = net?.requests.filter((r) => r.status === 'pending') ?? []
  if (!pending.length) return null
  const answer = (id: string, decision: 'host' | 'domain' | 'deny') => {
    setBusy(id)
    void apply(api.decideNetwork(id, decision)).finally(() => setBusy(null))
  }
  return (
    <div className="net-prompts" role="region" aria-label="Network access requests">
      {pending.map((r) => (
        <div key={r.id} className="net-prompt" role="alertdialog" aria-label={`Network access to ${r.host}`}>
          <div className="net-head">
            <IconLock size={15} />
            <span>
              The agent wants to reach <b className="mono">{r.host}</b>
            </span>
          </div>
          <p className="net-reason">“{r.reason}”</p>
          <p className="net-meta">
            {r.sessionId ? (
              <>
                From{' '}
                <button className="linklike" onClick={() => onOpenSession?.(r.sessionId!)}>
                  {r.sessionTitle ?? 'a chat'}
                </button>
                {' · '}
              </>
            ) : null}
            It is waiting for your answer. Anything you allow is somewhere the agent could send data.
          </p>
          <div className="net-actions">
            <button className="btn primary sm" disabled={busy === r.id} onClick={() => answer(r.id, 'host')}>
              Allow {r.host}
            </button>
            {r.domain !== r.host && (
              <button className="btn sm" disabled={busy === r.id} onClick={() => answer(r.id, 'domain')} title={`${r.domain} and every subdomain`}>
                Allow all of {r.domain}
              </button>
            )}
            <button className="btn sm danger" disabled={busy === r.id} onClick={() => answer(r.id, 'deny')}>
              Deny
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

/* ---------------- Settings → Network ---------------- */

export function NetworkPanel() {
  const net = useNetwork()
  const [host, setHost] = useState('')
  const [scope, setScope] = useState<'host' | 'domain'>('host')
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => void refreshNetwork(), [])
  if (!net) return <p className="muted">Loading…</p>
  if (!net.proxied)
    return (
      <p className="muted">
        This GM isn't running behind the egress proxy (host mode), so the agent's internet access isn't filtered and there is nothing to approve.
      </p>
    )
  const add = (h: string, s: 'host' | 'domain') => {
    setErr(null)
    return api
      .allowNetwork(h, s)
      .then((r) => {
        state = r
        emit()
        setHost('')
      })
      .catch((e) => setErr(e instanceof Error ? e.message.replace(/^\d+\s*/, '') : String(e)))
  }
  const decided = net.requests.filter((r) => r.status !== 'pending').slice(-10).reverse()
  return (
    <div className="net-panel">
      <p className="muted small">
        The agent reaches the internet only through the egress proxy. The list in <code>egress/allowlist.txt</code> is always allowed; anything
        else needs your approval here. Approvals apply within seconds, with no redeploy, and are kept in the data folder.
      </p>

      <h3>Approved by you</h3>
      {net.approved.length ? (
        <ul className="net-list">
          {net.approved.map((a) => (
            <li key={`${a.scope}:${a.host}`}>
              <span className="mono">{a.scope === 'domain' ? `*.${a.host}` : a.host}</span>
              {a.reason && <span className="muted small net-why">{a.reason}</span>}
              <span className="muted small">{new Date(a.approvedAt).toLocaleDateString()}</span>
              <button className="icon-btn sm" title="Remove" onClick={() => void apply(api.revokeNetwork(a.host, a.scope))}>
                <IconTrash size={13} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">Nothing yet.</p>
      )}
      <form
        className="net-add"
        onSubmit={(e) => {
          e.preventDefault()
          if (host.trim()) void add(host.trim(), scope)
        }}
      >
        <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="Add a domain, e.g. api.example.com" />
        <select value={scope} onChange={(e) => setScope(e.target.value as 'host' | 'domain')}>
          <option value="host">Just this host</option>
          <option value="domain">Whole domain</option>
        </select>
        <button className="btn sm primary" type="submit" disabled={!host.trim()}>
          Allow
        </button>
      </form>
      {err && <p className="error small">{err}</p>}

      <h3>Recently blocked</h3>
      {net.blocked.length ? (
        <ul className="net-list">
          {net.blocked.map((b) => (
            <li key={b.host}>
              <span className="mono">{b.host}</span>
              <span className="muted small">
                {b.count}× · last {new Date(b.lastAt).toLocaleTimeString()}
              </span>
              <button className="btn sm" onClick={() => void add(b.host, 'host')}>
                Allow
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">Nothing has been refused since GM started.</p>
      )}

      {decided.length > 0 && (
        <>
          <h3>Recent requests from the agent</h3>
          <ul className="net-list">
            {decided.map((r) => (
              <li key={r.id}>
                <span className="mono">{r.host}</span>
                <span className={`pill ${r.status === 'approved' ? 'ok' : 'bad'}`}>{r.status}</span>
                <span className="muted small net-why">{r.reason}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <details className="net-static">
        <summary>Always allowed ({net.allowlist.length}, from egress/allowlist.txt)</summary>
        <p className="mono small">{net.allowlist.join('  ')}</p>
      </details>
    </div>
  )
}

