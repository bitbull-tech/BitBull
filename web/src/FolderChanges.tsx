/**
 * Changes the agent proposed to a linked folder (server/src/folderChanges.ts), waiting for you.
 * The agent can't write to a linked folder; this card is the only way a change gets there, and
 * the writing is done by the link helper on this PC when you press a button here.
 *
 * Two ways to accept: put it on a new git branch (offered first when the files are in a repo:
 * your working files aren't touched), or apply the files to the folder. Declining changes nothing.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { api, type FolderChange, type FolderChangeDetail } from './api'
import { onLiveActivity, reportLocal } from './activity'
import { IconFile, IconFolder } from './icons'
import { applyChange, helperStatus, onThisPc, HELPER_HINT, type HelperLink } from './linkHelper'

let state: FolderChange[] | null = null
const subs = new Set<() => void>()
const emit = () => subs.forEach((f) => f())
let started = false

export function refreshFolderChanges() {
  return api
    .folderChanges()
    .then((r) => {
      state = r.changes
      emit()
    })
    .catch(() => {})
}
function start() {
  if (started) return
  started = true
  void refreshFolderChanges()
  onLiveActivity((e) => {
    if (e.source === 'integration' && /linked folder/.test(e.message)) void refreshFolderChanges()
  })
  setInterval(() => {
    if (document.visibilityState === 'visible') void refreshFolderChanges()
  }, 15000)
}
function useFolderChanges() {
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

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

function Card({ c, onOpenSession }: { c: FolderChange; onOpenSession?: (id: string) => void }) {
  const [detail, setDetail] = useState<FolderChangeDetail | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(c.status === 'failed' ? (c.message ?? 'It could not be applied.') : null)
  const [link, setLink] = useState<HelperLink | null | 'none'>(null)
  useEffect(() => {
    void api.folderChange(c.id).then(setDetail, () => {})
    void helperStatus().then((h) => setLink(h?.links.find((l) => l.name === c.link) ?? 'none'))
  }, [c.id, c.link])

  const helper = link && link !== 'none' ? link : null
  const where = helper?.path ?? `the linked folder ${c.link}`
  const canWrite = !!helper?.write
  const needsDelete = c.deletes.length > 0 && !helper?.delete

  const finish = async (status: 'applied' | 'branch' | 'declined' | 'failed', message?: string) => {
    await api.decideFolderChange(c.id, status, message).then(
      (r) => {
        state = r.changes
        emit()
      },
      (e) => reportLocal(e instanceof Error ? e.message : String(e)),
    )
  }
  const run = async (mode: 'files' | 'branch') => {
    if (!detail) return
    setErr(null)
    setBusy(mode === 'branch' ? 'Creating the branch on this PC…' : 'Copying the files in on this PC…')
    try {
      const r = await applyChange({
        name: c.link,
        staging: c.hostStaging ?? '',
        manifest: detail.files.map((f) => ({ path: f.path, sha256: f.sha256 })),
        deletes: c.deletes,
        mode,
        branch: c.branch,
        message: c.summary,
      })
      if (r.ok) await finish(mode === 'branch' ? 'branch' : 'applied', r.message)
      else if (!r.cancelled) {
        setErr(r.message ?? 'It could not be applied.')
        await finish('failed', r.message)
      }
    } catch {
      setErr(HELPER_HINT)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="net-prompt fc-card" role="alertdialog" aria-label={`Changes proposed to ${c.link}`}>
      <div className="net-head">
        <IconFolder size={15} />
        <span>
          The agent wants to change <b className="mono">{where}</b>
        </span>
      </div>
      <p className="net-reason">“{c.summary}”</p>
      <ul className="fc-files">
        {(detail?.files ?? c.files).map((f) => (
          <li key={f.path}>
            <button type="button" className="fc-file" onClick={() => setOpen(open === f.path ? null : f.path)} title="Show what changes">
              <IconFile size={12} />
              <span className="mono">{f.path}</span>
              <span className={`pill ${f.status === 'new' ? 'ok' : ''}`}>{f.status}</span>
              <span className="fc-count">
                <b className="fc-add">+{f.added}</b> <b className="fc-del">−{f.removed}</b>
              </span>
            </button>
            {open === f.path && (
              <pre className="fc-diff">
                {'diff' in f && f.diff
                  ? f.diff.split('\n').map((l, i) => (
                      <span key={i} className={l.startsWith('+') ? 'fc-add' : l.startsWith('-') ? 'fc-del' : ''}>
                        {l}
                        {'\n'}
                      </span>
                    ))
                  : 'No text diff for this file (binary, or too long to show).'}
              </pre>
            )}
          </li>
        ))}
        {c.deletes.map((d) => (
          <li key={d}>
            <span className="fc-file">
              <IconFile size={12} />
              <span className="mono">{d}</span>
              <span className="pill bad">delete</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="net-meta">
        {c.sessionId ? (
          <>
            From{' '}
            <button className="linklike" onClick={() => onOpenSession?.(c.sessionId!)}>
              {c.sessionTitle ?? 'a chat'}
            </button>
            {' · '}
          </>
        ) : null}
        Nothing changes unless you choose. Click a file to see its diff.
      </p>
      {!onThisPc() ? (
        <p className="small muted">Open BitBull on the PC it runs on (http://localhost:8787) to apply this: the files are written by the helper on that PC.</p>
      ) : link === 'none' ? (
        <p className="small muted">{HELPER_HINT}</p>
      ) : !c.hostStaging ? (
        <p className="small muted">This BitBull doesn't know where its data folder is on the PC, so the helper can't read the staged files. Run start.ps1 once, then ask again.</p>
      ) : (
        <>
          {c.repo !== null && (
            <p className="small fc-safer">
              <b>Safer:</b> these files are in a git repo. A branch leaves your working files exactly as they are; you review and merge it yourself.
            </p>
          )}
          <div className="net-actions">
            {c.repo !== null && (
              <button className="btn primary sm" disabled={!!busy || !detail} onClick={() => void run('branch')} title={`Creates ${c.branch} from the repo's current commit`}>
                Put it on a branch
              </button>
            )}
            <button
              className={`btn sm ${c.repo === null ? 'primary' : ''}`}
              disabled={!!busy || !detail || !canWrite || needsDelete}
              onClick={() => void run('files')}
              title={canWrite ? 'Copies these files into the folder now. What they replace is backed up first.' : 'Changes are not allowed in this folder yet'}
            >
              Apply to the folder
            </button>
            <button className="btn sm danger" disabled={!!busy} onClick={() => void finish('declined')}>
              Decline
            </button>
          </div>
          {!canWrite && (
            <p className="small muted">
              "Apply to the folder" is off because changes aren't allowed in this folder. Allow them under Settings → Folders
              {c.repo !== null ? ', or use the branch.' : '.'}
            </p>
          )}
          {canWrite && needsDelete && <p className="small muted">This change deletes {plural(c.deletes.length, 'file')}, and deleting isn't allowed in this folder. Allow it under Settings → Folders{c.repo !== null ? ', or use the branch.' : '.'}</p>}
        </>
      )}
      {busy && <p className="small fm-busy">{busy}</p>}
      {err && <p className="small lv-error-text">{err}</p>}
    </div>
  )
}

export function FolderChangePrompt({ onOpenSession }: { onOpenSession?: (id: string) => void }) {
  const all = useFolderChanges()
  // waiting for an answer, or approved but not applied yet (so it can be tried again)
  const open = (all ?? []).filter((c) => c.status === 'pending' || c.status === 'failed')
  if (!open.length) return null
  return (
    <div className="net-prompts fc-prompts" role="region" aria-label="Changes proposed to linked folders">
      {open.map((c) => (
        <Card key={c.id} c={c} onOpenSession={onOpenSession} />
      ))}
    </div>
  )
}

/** Settings → Folders: what was proposed lately and what became of it. */
export function FolderChangeHistory() {
  const all = useFolderChanges()
  const done = (all ?? []).filter((c) => c.status !== 'pending').slice(0, 10)
  if (!done.length) return null
  const label: Record<string, string> = { applied: 'applied', branch: 'on a branch', declined: 'declined', failed: 'failed', expired: 'expired' }
  return (
    <>
      <h3>Recent changes</h3>
      <ul className="net-list">
        {done.map((c) => (
          <li key={c.id}>
            <span className="mono">{c.link}</span>
            <span className="muted small net-why">
              {c.summary} · {plural(c.files.length + c.deletes.length, 'file')}
              {c.status === 'branch' ? ` · ${c.branch}` : ''}
            </span>
            <span className={`pill ${c.status === 'applied' || c.status === 'branch' ? 'ok' : c.status === 'failed' ? 'bad' : ''}`}>{label[c.status] ?? c.status}</span>
            <span className="muted small">{new Date(c.decidedAt ?? c.createdAt).toLocaleString()}</span>
          </li>
        ))}
      </ul>
      <p className="muted small">Kept until BitBull restarts. Files an apply replaced or deleted are backed up on this PC under %LOCALAPPDATA%\BitBull\folder-backups.</p>
    </>
  )
}
