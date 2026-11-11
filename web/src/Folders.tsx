import { useEffect, useState } from 'react'
import { api, type LinkedFolder } from './api'
import { IconLock, IconPlus, IconRefresh, IconTrash } from './icons'
import { HELPER_HINT, helperStatus, linkFolder, onThisPc, refreshFolder, unlinkFolder, type HelperLink } from './linkHelper'

/** Settings → Folders: the read-only links, with Link / Remove through the helper on this PC. */
export function FoldersPanel() {
  const [links, setLinks] = useState<{ available: boolean; links: LinkedFolder[] } | null>(null)
  const [helper, setHelper] = useState<{ links: HelperLink[] } | null | 'checking'>('checking')
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const load = () => {
    void api
      .links()
      .then(setLinks)
      .catch(() => setLinks({ available: false, links: [] }))
    void helperStatus().then(setHelper)
  }
  useEffect(load, [])

  const run = async (fn: () => Promise<{ ok: boolean; cancelled?: boolean; message?: string }>, done: string) => {
    setMsg(null)
    try {
      const r = await fn()
      if (r.ok) setMsg({ ok: true, text: done })
      else if (!r.cancelled) setMsg({ ok: false, text: r.message ?? 'Failed' })
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(null)
      load()
    }
  }

  const ready = helper && helper !== 'checking'
  const rows: Array<{ name: string; path?: string; mode?: string; inBitBull?: LinkedFolder; state?: string }> = []
  for (const l of links?.links ?? []) {
    const h = ready ? helper.links.find((x) => x.name === l.name) : undefined
    rows.push({ name: l.name, inBitBull: l, path: h?.path, mode: h?.mode })
  }
  if (ready) for (const h of helper.links) if (!rows.some((r) => r.name === h.name)) rows.push({ name: h.name, path: h.path, mode: h.mode, state: h.state })

  return (
    <div className="net-panel">
      <p className="muted small">
        Linked folders are folders on this PC that the agent can <b>read but never change</b>: they are mounted read-only, and BitBull restarts
        (about 10 seconds) whenever one is added or removed. Every chat in this BitBull can read them. A folder holding .env files, keys or
        wallets (BitBull's own repo, for one) is linked as a read-only copy without them: the agent never sees those files, and Refresh
        updates the copy. To give the agent a copy it may change, use the folder button in the chat → Upload a copy.
      </p>
      {links && !links.available ? (
        <p className="muted">Links work in the sandboxed BitBull (Docker) only.</p>
      ) : (
        <>
          <h3>Linked folders</h3>
          {rows.length ? (
            <ul className="net-list">
              {rows.map((r) => (
                <li key={r.name}>
                  <IconLock size={13} />
                  <span className="mono">{r.name}</span>
                  {r.path && <span className="muted small net-why mono">{r.path}</span>}
                  {r.inBitBull ? (
                    <span className={`pill ${r.inBitBull.readOnly ? 'ok' : 'bad'}`}>{r.inBitBull.readOnly ? 'read-only' : 'NOT read-only'}</span>
                  ) : (
                    <span className="pill bad">{r.state === 'missing' ? 'folder missing' : 'not visible to BitBull yet'}</span>
                  )}
                  {r.mode === 'filtered' && (
                    <span className="pill" title="A read-only copy without .env, keys and wallets. Changes to the folder show up after Refresh.">
                      copy, secrets hidden
                    </span>
                  )}
                  {ready && r.mode === 'filtered' && (
                    <button
                      className="icon-btn sm"
                      title={`Refresh ${r.name}: re-check for secrets and copy again`}
                      disabled={!!busy}
                      onClick={() => {
                        setBusy(`Refreshing ${r.name}…`)
                        void run(() => refreshFolder(r.name, setBusy), `Refreshed ${r.name}.`)
                      }}
                    >
                      <IconRefresh size={13} />
                    </button>
                  )}
                  {ready && (
                    <button
                      className="icon-btn sm"
                      title={`Remove ${r.name}`}
                      disabled={!!busy}
                      onClick={() => {
                        setBusy(`Confirm in the box that opened on this computer to remove ${r.name}…`)
                        void run(() => unlinkFolder(r.name, setBusy), `Removed ${r.name}.`)
                      }}
                    >
                      <IconTrash size={13} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">None yet.</p>
          )}
          <div className="net-add">
            {ready ? (
              <button
                className="btn primary sm"
                disabled={!!busy}
                onClick={() => {
                  setBusy('Opening the folder picker on this PC…')
                  void run(() => linkFolder(setBusy), 'Linked. Attach it from the folder button in the chat.')
                }}
              >
                <IconPlus size={13} /> Link a folder from this PC…
              </button>
            ) : helper === 'checking' ? (
              <p className="muted small">Checking for the link helper…</p>
            ) : !onThisPc() ? (
              <p className="muted small">Open BitBull on the PC it runs on (http://localhost:8787) to link or remove folders.</p>
            ) : (
              <p className="muted small">{HELPER_HINT}</p>
            )}
          </div>
          {busy && <p className="small fm-busy">{busy}</p>}
          {msg && <p className={`small ${msg.ok ? 'good' : 'error'}`}>{msg.text}</p>}
        </>
      )}
    </div>
  )
}
