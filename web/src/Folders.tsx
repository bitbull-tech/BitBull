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

  const [projectNames, setProjectNames] = useState<Record<string, string>>({})
  const load = () => {
    void api
      .links()
      .then(setLinks)
      .catch(() => setLinks({ available: false, links: [] }))
    void helperStatus().then(setHelper)
  }
  useEffect(load, [])
  useEffect(() => {
    void api
      .projects()
      .then((r) => setProjectNames(Object.fromEntries(r.projects.map((p) => [p.id, p.name]))))
      .catch(() => {})
  }, [])

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
        Every folder linked on this PC, whichever project it is for. The agent reads a linked folder and can never write to it itself. A
        folder holding .env files, keys or wallets is read as a copy without them. Each folder belongs to the project it was linked from;
        add it to another from the Resources panel beside a chat.
      </p>
      <p className="muted small">
        <b>Changes.</b> Allow them once per folder (a box on this PC asks). After that, changes the agent makes for that folder in a chat are
        written by this PC straight away, each shown in the chat with its diff, an Undo and the git commands to publish it. Never written: git
        hooks and config, editor and CI files, .env files and programs. Deleting is a separate permission. Scheduled runs and Telegram can't
        change anything.
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
                    <span className="pill warn" title={`You allowed changes here${r.since ? ` on ${r.since}` : ''}. They are written straight away, each shown in the chat with an Undo.`}>
                      changes allowed{r.del ? ' · deleting too' : ''}
                    </span>
                  )}
                  {r.inBitBull?.projects && (
                    <span className="muted small" title="The projects whose chats are offered this folder">
                      {r.inBitBull.projects.length ? r.inBitBull.projects.map((id) => (id === 'general' ? 'General' : (projectNames[id] ?? 'a project'))).join(', ') : 'in no project yet'}
                    </span>
                  )}
                  {canGrant && (r.mode === 'live' || helper.caps.includes('copies')) && r.inBitBull && !r.write && (
                    <button
                      className="btn sm"
                      disabled={!!busy}
                      title="A box on this PC asks you to confirm"
                      onClick={() => {
                        setBusy(`Confirm in the box that opened on this PC to allow changes in ${r.name}…`)
                        void run(() => grantFolder(r.name, 'write'), `Changes allowed in ${r.name}.`)
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
                  void run(() => linkFolder(setBusy), 'Linked. Add it to a project from the Resources panel beside a chat.')
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
          {ready && canGrant && !helper.caps.includes('copies') && <p className="muted small">The helper running on this PC is an older one. Press Start in the launcher (or run start.ps1) to get the one that can write to folders linked as copies.</p>}
          <FolderChangeHistory />
        </>
      )}
    </div>
  )
}
