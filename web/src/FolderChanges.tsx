/**
 * Changes the agent proposed to a linked folder (server/src/folderChanges.ts), waiting for you.
 * The agent can't write to a linked folder; this card is the only way a change gets there, and
 * the writing is done by the link helper on this PC when you press a button here.
 *
 * Two ways to accept: put it on a new git branch (offered first when the files are in a repo:
 * your working files aren't touched), or apply the files to the folder. Declining changes nothing.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { api, type FolderChange, type FolderChangeDetail, type FolderChangeFile } from './api'
import { onLiveActivity, reportLocal } from './activity'
import { IconFile, IconFolder } from './icons'
import { applyChange, grantFolder, helperStatus, onThisPc, undoChange, HELPER_HINT, type HelperLink } from './linkHelper'

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

/** The list for the card has no diffs; the detail fetched for an open card has. */
const diffOf = (f: FolderChangeFile & { diff?: string }) => f.diff

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

  const finish = async (status: 'applied' | 'branch' | 'declined' | 'failed', message?: string, extra: { backup?: string; auto?: boolean } = {}) => {
    await api.decideFolderChange(c.id, status, message, extra).then(
      (r) => {
        state = r.changes
        emit()
      },
      (e) => reportLocal(e instanceof Error ? e.message : String(e)),
    )
  }
  // one write at a time: allowing changes switches on the write-by-itself path while the button's own write is starting
  const writing = useRef(false)
  const run = async (mode: 'files' | 'branch', auto = false) => {
    if (!detail || writing.current) return
    writing.current = true
    setErr(null)
    setBusy(mode === 'branch' ? 'Creating the branch on this PC…' : 'Writing the files on this PC…')
    try {
      const r = await applyChange({
        name: c.link,
        staging: c.hostStaging ?? '',
        manifest: detail.files.map((f) => ({ path: f.path, sha256: f.sha256, new: f.status === 'new' })),
        deletes: c.deletes,
        mode,
        branch: c.branch,
        message: c.summary,
      })
      if (r.ok) await finish(mode === 'branch' ? 'branch' : 'applied', r.message, { backup: r.backupId, auto })
      else if (!r.cancelled) {
        setErr(r.message ?? 'It could not be applied.')
        await finish('failed', r.message)
      }
    } catch {
      setErr(HELPER_HINT)
    } finally {
      writing.current = false
      setBusy(null)
    }
  }

  // You allowed changes in this folder: write straight away, no click. One page does it (the
  // server hands the change to the first that asks), and a failure leaves the buttons to retry.
  const ready = !!detail && !!helper && c.status === 'pending' && onThisPc() && !!c.hostStaging
  useEffect(() => {
    if (!ready || !canWrite || needsDelete) return
    let live = true
    void api.claimFolderChange(c.id).then((r) => {
      if (live && r.ok) void run('files', true)
    })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, canWrite, needsDelete])

  // Not allowed yet: one box on this PC, then this change and every later one in the folder is written
  const allowAndApply = async () => {
    setErr(null)
    setBusy('Answer the box that opened on this PC…')
    try {
      const g = await grantFolder(c.link, 'write')
      if (!g.ok) {
        if (!g.cancelled) setErr(g.message ?? 'Changes could not be allowed.')
        return
      }
      const h = await helperStatus()
      setLink(h?.links.find((l) => l.name === c.link) ?? 'none')
      await run('files')
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
                {diffOf(f)
                  ? diffOf(f)!.split('\n').map((l, i) => (
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
        {canWrite && !needsDelete ? 'Changes are allowed in this folder, so this is being written.' : 'Nothing is written until you choose.'} Click a file to see its diff.
      </p>
      {!onThisPc() ? (
        <p className="small muted">Open BitBull on the PC it runs on (http://localhost:8787) to apply this: the files are written by the helper on that PC.</p>
      ) : link === 'none' ? (
        <p className="small muted">{HELPER_HINT}</p>
      ) : !c.hostStaging ? (
        <p className="small muted">This BitBull doesn't know where its data folder is on the PC, so the helper can't read the staged files. Run start.ps1 once, then ask again.</p>
      ) : (
        <>
          <div className="net-actions">
            {canWrite ? (
              <button className="btn primary sm" disabled={!!busy || !detail || needsDelete} onClick={() => void run('files')} title="Writes these files into the folder now. What they replace is backed up first, and you can undo.">
                Write to the folder
              </button>
            ) : (
              <button
                className="btn primary sm"
                disabled={!!busy || !detail || needsDelete}
                onClick={() => void allowAndApply()}
                title="A box on this PC asks you once. After that, changes the agent makes for this folder are written straight away, each listed here with its diff and an Undo."
              >
                Allow changes in this folder and write
              </button>
            )}
            {c.repo !== null && (
              <button className="btn sm" disabled={!!busy || !detail} onClick={() => void run('branch')} title={`Creates ${c.branch} from the repo's current commit; your working files are not touched`}>
                Put it on a branch instead
              </button>
            )}
            <button className="btn sm danger" disabled={!!busy} onClick={() => void finish('declined')}>
              Decline
            </button>
          </div>
          {!canWrite && <p className="small muted">You are asked once per folder. After that the agent's changes here are written straight away, with the diff and an Undo shown each time.</p>}
          {canWrite && needsDelete && <p className="small muted">This change deletes {plural(c.deletes.length, 'file')}, and deleting isn't allowed in this folder. Allow it under Settings → Folders{c.repo !== null ? ', or use the branch.' : '.'}</p>}
        </>
      )}
      {busy && <p className="small fm-busy">{busy}</p>}
      {err && <p className="small lv-error-text">{err}</p>}
    </div>
  )
}

const dismissed = new Set<string>()
const RECENT_MS = 20 * 60_000
const q = (s: string) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s)

/** What was just written: the files with their diffs, an Undo, and the git commands to review and publish it. */
function Done({ c, onGone }: { c: FolderChange; onGone: () => void }) {
  const [detail, setDetail] = useState<FolderChangeDetail | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [helper, setHelper] = useState<{ link?: HelperLink; undo: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    void api.folderChange(c.id).then(setDetail, () => {})
    void helperStatus().then((h) => setHelper({ link: h?.links.find((l) => l.name === c.link), undo: !!h?.caps.includes('undo') }))
  }, [c.id, c.link])
  const root = helper?.link?.path
  const inRepo = (p: string) => (c.repo ? p.slice(c.repo.length + 1) : p)
  const repoDir = root ? (c.repo ? `${root}\\${c.repo.replace(/\//g, '\\')}` : root) : null
  const commands =
    c.repo !== null && repoDir
      ? [
          `cd ${q(repoDir)}`,
          'git status',
          'git diff',
          `git add ${[...c.files.map((f) => f.path), ...c.deletes].map((p) => q(inRepo(p))).join(' ')}`,
          `git commit -m ${q(c.summary)}`,
          'git push',
        ].join('\n')
      : null
  const undo = async () => {
    if (!c.backup) return
    setBusy(true)
    setNote(null)
    try {
      const r = await undoChange(c.link, c.backup)
      setNote({ ok: r.ok, text: r.message ?? (r.ok ? 'Undone.' : 'It could not be undone.') })
      if (r.ok)
        await api.decideFolderChange(c.id, 'undone', r.message).then(
          (x) => {
            state = x.changes
            emit()
          },
          () => {},
        )
    } catch {
      setNote({ ok: false, text: HELPER_HINT })
    } finally {
      setBusy(false)
    }
  }
  const undone = c.status === 'undone'
  return (
    <div className="net-prompt fc-card fc-done" role="status" aria-label={`Changes written to ${c.link}`}>
      <div className="net-head">
        <IconFolder size={15} />
        <span>
          {undone ? 'Undone in' : `Wrote ${plural(c.files.length, 'file')}${c.deletes.length ? `, deleted ${c.deletes.length}` : ''} in`} <b className="mono">{root ?? c.link}</b>
        </span>
        <button className="link small fc-x" onClick={onGone} aria-label="Dismiss">
          ×
        </button>
      </div>
      <p className="net-reason">“{c.summary}”</p>
      <ul className="fc-files">
        {(detail?.files ?? c.files).map((f) => (
          <li key={f.path}>
            <button type="button" className="fc-file" onClick={() => setOpen(open === f.path ? null : f.path)} title="Show what changed">
              <IconFile size={12} />
              <span className="mono">{f.path}</span>
              <span className={`pill ${f.status === 'new' ? 'ok' : ''}`}>{f.status}</span>
              <span className="fc-count">
                <b className="fc-add">+{f.added}</b> <b className="fc-del">−{f.removed}</b>
              </span>
            </button>
            {open === f.path && (
              <pre className="fc-diff">
                {diffOf(f)
                  ? diffOf(f)!.split('\n').map((l, i) => (
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
              <span className="pill bad">deleted</span>
            </span>
          </li>
        ))}
      </ul>
      {!undone && commands && (
        <div className="fc-git">
          <div className="fc-git-head">
            <span className="muted small">To review and publish it, in a terminal on this PC:</span>
            <button
              className="link small"
              onClick={() => {
                void navigator.clipboard?.writeText(commands).then(() => {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                })
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <pre>{commands}</pre>
        </div>
      )}
      {!undone && (
        <div className="net-actions">
          <button className="btn sm" disabled={busy || !c.backup || !helper?.undo} onClick={() => void undo()} title={c.backup ? 'Puts back what was replaced or deleted and removes what was created. Files you have changed since are left alone.' : 'No backup was recorded for this change'}>
            {busy ? 'Undoing…' : 'Undo'}
          </button>
          <button className="btn sm" onClick={onGone}>
            Done
          </button>
        </div>
      )}
      {note && <p className={`small ${note.ok ? 'muted' : 'lv-error-text'}`}>{note.text}</p>}
    </div>
  )
}

export function FolderChangePrompt({ onOpenSession }: { onOpenSession?: (id: string) => void }) {
  const all = useFolderChanges()
  const [, bump] = useState(0)
  // waiting for an answer, or approved but not applied yet (so it can be tried again)
  const open = (all ?? []).filter((c) => c.status === 'pending' || c.status === 'failed')
  // written (or undone) a moment ago: shown until dismissed, so a change made without a click is never silent
  const recent = (all ?? []).filter((c) => (c.status === 'applied' || c.status === 'undone') && !dismissed.has(c.id) && Date.now() - Date.parse(c.decidedAt ?? c.createdAt) < RECENT_MS).slice(0, 3)
  if (!open.length && !recent.length) return null
  return (
    <div className="net-prompts fc-prompts" role="region" aria-label="Changes to linked folders">
      {open.map((c) => (
        <Card key={c.id} c={c} onOpenSession={onOpenSession} />
      ))}
      {recent.map((c) => (
        <Done
          key={c.id}
          c={c}
          onGone={() => {
            dismissed.add(c.id)
            bump((n) => n + 1)
          }}
        />
      ))}
    </div>
  )
}

/** Settings → Folders: what was proposed lately and what became of it. */
export function FolderChangeHistory() {
  const all = useFolderChanges()
  const done = (all ?? []).filter((c) => c.status !== 'pending').slice(0, 10)
  if (!done.length) return null
  const label: Record<string, string> = { applied: 'written', branch: 'on a branch', declined: 'declined', failed: 'failed', expired: 'expired', undone: 'undone' }
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
