import { useEffect, useState } from 'react'
import { api, type LinkedFolder } from './api'
import { IconLock, IconPlus, IconRefresh, IconTrash } from './icons'
import { grantFolder, HELPER_HINT, helperStatus, linkFolder, onThisPc, refreshFolder, revokeFolder, unlinkFolder, type HelperLink } from './linkHelper'
import { FolderChangeHistory } from './FolderChanges'

/** Settings → Folders: the read-only links, with Link / Remove through the helper on this PC. */
export function FoldersPanel() {
  const [links, setLinks] = useState<{ available: boolean; links: LinkedFolder[] } | null>(null)
  const [helper, setHelper] = useState<{ links: HelperLink[]; caps: string[] } | null | 'checking'>('checking')
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
  // changes can be allowed only where the helper on this PC knows how (Windows for now)
  const canGrant = ready && helper.caps.includes('changes')
  const rows: Array<{ name: string; path?: string; mode?: string; inBitBull?: LinkedFolder; state?: string; write?: boolean; del?: boolean; since?: string }> = []
  for (const l of links?.links ?? []) {
    const h = ready ? helper.links.find((x) => x.name === l.name) : undefined
    rows.push({ name: l.name, inBitBull: l, path: h?.path, mode: h?.mode, write: h?.write, del: h?.delete, since: h?.since })
  }
  if (ready) for (const h of helper.links) if (!rows.some((r) => r.name === h.name)) rows.push({ name: h.name, path: h.path, mode: h.mode, state: h.state, write: h.write, del: h.delete, since: h.since })

  return (
    <div className="net-panel">
      <p className="muted small">
        Linked folders are folders on this PC that the agent can <b>read but never write to</b>: they are mounted read-only, and BitBull
        restarts (about 10 seconds) whenever one is added or removed. Every chat in this BitBull can read them. A folder holding .env files,
        keys or wallets (BitBull's own repo, for one) is linked as a read-only copy without them: the agent never sees those files, and
        Refresh updates the copy.
      </p>
      <p className="muted small">
        <b>Changes.</b> If you allow changes in a folder, the agent can <i>propose</i> them: you are shown the files and the diff, and only
        what you approve is copied in, by the helper on this PC. For files in a git repo you can put the change on a new branch instead and
        leave your working files alone: the safer choice, and it needs no standing permission (a box on this PC asks each time). Git hooks and config, editor and CI files, .env
        files and programs are never written. Deleting is a separate permission. Scheduled runs and Telegram can't change anything here.
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
                  {r.write && (
                    <span className="pill warn" title={`You allowed changes here${r.since ? ` on ${r.since}` : ''}. Each change still needs your approval.`}>
                      changes allowed{r.del ? ' · deleting too' : ''}
                    </span>
                  )}
                  {canGrant && r.mode === 'live' && r.inBitBull && !r.write && (
                    <button
                      className="btn sm"
                      disabled={!!busy}
                      title="A box on this PC asks you to confirm"
                      onClick={() => {
                        setBusy(`Confirm in the box that opened on this PC to allow changes in ${r.name}…`)
                        void run(() => grantFolder(r.name, 'write'), `Changes allowed in ${r.name}. Each one still waits for your approval.`)
                      }}
                    >
                      Allow changes…
                    </button>
                  )}
                  {canGrant && r.write && !r.del && (
                    <button
                      className="btn sm"
                      disabled={!!busy}
                      title="A box on this PC asks you to confirm"
                      onClick={() => {
                        setBusy(`Confirm in the box that opened on this PC to allow deleting in ${r.name}…`)
                        void run(() => grantFolder(r.name, 'delete'), `Deleting allowed in ${r.name}.`)
                      }}
                    >
                      Allow deleting…
                    </button>
                  )}
                  {canGrant && r.del && (
                    <button className="btn sm" disabled={!!busy} onClick={() => (setBusy('…'), void run(() => revokeFolder(r.name, 'delete'), `Deleting is off again in ${r.name}.`))}>
                      Stop deleting
                    </button>
                  )}
                  {canGrant && r.write && (
                    <button className="btn sm danger" disabled={!!busy} onClick={() => (setBusy('…'), void run(() => revokeFolder(r.name, 'write'), `${r.name} is read-only again.`))}>
                      Make read-only
                    </button>
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
          {ready && !canGrant && <p className="muted small">Allowing changes needs the helper that comes with this version on Windows; on a Mac, links are read-only copies for now.</p>}
          <FolderChangeHistory />
        </>
      )}
    </div>
  )
}
