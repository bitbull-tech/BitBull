import { useEffect, useState } from 'react'
import { api, type Project, type RepoInfo } from './api'
import { composeInChat } from './activity'
import { IconChevronRight, IconFolder, IconRefresh, IconX } from './icons'

/**
 * Git clones in a project's workspace: branch, what's uncommitted, ahead/behind, branches.
 * Read-only. Every change (checkout, pull, commit, push) is handed to the agent as a chat
 * message, so it happens in the sandbox, in view, and the reviewer can look at it.
 */
export function ReposDialog({ project, onClose, onBrowse }: { project: Project | null; onClose: () => void; onBrowse: (dir: string) => void }) {
  const pid = project?.id ?? 'general'
  const [repos, setRepos] = useState<RepoInfo[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [diff, setDiff] = useState<Record<string, string>>({})
  const [showRemote, setShowRemote] = useState(false)

  const load = () => {
    setErr(null)
    void api
      .repos(pid)
      .then((r) => {
        setRepos(r.repos)
        if (r.repos.length === 1) setOpen(r.repos[0].path)
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
  }
  useEffect(load, [pid])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const ask = (text: string) => {
    composeInChat(text)
    onClose()
  }
  const where = (r: RepoInfo) => `the git repo at \`${r.path}\` in this project's workspace`

  // the open repo's uncommitted-changes summary, fetched once per repo
  useEffect(() => {
    const r = repos?.find((x) => x.path === open)
    if (!r || diff[r.path] !== undefined) return
    void api.repoDiff(pid, r.path).then((d) => setDiff((x) => ({ ...x, [r.path]: d.stat })))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, repos])

  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal repos-modal" role="dialog" aria-label="Repositories">
        <header className="modal-head">
          <h2>Repositories · {project?.name ?? 'General workspace'}</h2>
          <button className="icon-btn sm" title="Refresh" onClick={load}>
            <IconRefresh size={14} />
          </button>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <IconX />
          </button>
        </header>
        <div className="modal-body">
          {err && <p className="error small">{err}</p>}
          {repos === null && !err && <p className="muted small">Looking for clones…</p>}
          {repos?.length === 0 && (
            <div className="muted small">
              <p>No git repositories in this workspace yet.</p>
              <button className="btn sm" onClick={() => ask('Clone the GitHub repository <owner/name> into this project (shallow is fine), then summarise what it is and how it builds.')}>
                Ask the agent to clone one…
              </button>
            </div>
          )}
          {repos?.map((r) => {
            const isOpen = open === r.path
            const dirty = r.changed + r.untracked + r.staged + r.conflicts
            return (
              <div key={r.path} className={`repo ${isOpen ? 'open' : ''}`}>
                <button
                  className="repo-head"
                  onClick={() => setOpen(isOpen ? null : r.path)}
                >
                  <IconChevronRight size={13} className={`chev ${isOpen ? 'open' : ''}`} />
                  <b>{r.name}</b>
                  <span className="mono muted small">{r.path}</span>
                  <span className="grow" />
                  {r.error ? (
                    <span className="pill bad">error</span>
                  ) : (
                    <>
                      <span className={`pill ${r.detached ? 'bad' : ''}`} title={r.detached ? 'Detached HEAD' : 'Current branch'}>
                        {r.detached ? `detached @ ${r.branch}` : r.branch ?? 'no commits'}
                      </span>
                      {dirty > 0 ? (
                        <span className="pill warn" title={`${r.changed} changed, ${r.staged} staged, ${r.untracked} untracked${r.conflicts ? `, ${r.conflicts} in conflict` : ''}`}>
                          {dirty} uncommitted
                        </span>
                      ) : (
                        <span className="pill ok">clean</span>
                      )}
                      {r.upstream && (r.ahead || r.behind) ? (
                        <span className="pill" title={`vs ${r.upstream}`}>
                          {r.ahead ? `↑${r.ahead}` : ''}
                          {r.behind ? ` ↓${r.behind}` : ''}
                        </span>
                      ) : null}
                      {r.conflicts > 0 && <span className="pill bad">{r.conflicts} conflicts</span>}
                    </>
                  )}
                </button>
                {isOpen && (
                  <div className="repo-body">
                    {r.error && <p className="error small">{r.error}</p>}
                    <dl className="repo-facts">
                      <dt>Remote</dt>
                      <dd className="mono">{r.remote ?? '(none)'}</dd>
                      <dt>Last commit</dt>
                      <dd>
                        {r.head ? (
                          <>
                            <span className="mono">{r.head.sha}</span> {r.head.subject} <span className="muted">· {r.head.author}, {r.head.when}</span>
                          </>
                        ) : (
                          '(none)'
                        )}
                      </dd>
                      {r.upstream && (
                        <>
                          <dt>Tracking</dt>
                          <dd className="mono">
                            {r.upstream}
                            {r.ahead ? ` · ${r.ahead} to push` : ''}
                            {r.behind ? ` · ${r.behind} to pull` : ''}
                          </dd>
                        </>
                      )}
                      {r.stashes > 0 && (
                        <>
                          <dt>Stashes</dt>
                          <dd>{r.stashes}</dd>
                        </>
                      )}
                    </dl>

                    <div className="repo-actions">
                      <button className="btn sm" onClick={() => onBrowse(r.path === '.' ? '' : r.path)}>
                        <IconFolder size={13} /> Browse files
                      </button>
                      <button className="btn sm" onClick={() => ask(`In ${where(r)}: show me \`git status\` and \`git diff\`, and explain what is uncommitted and why.`)}>
                        Explain changes
                      </button>
                      <button className="btn sm" onClick={() => ask(`In ${where(r)}: fetch from origin and tell me what is new on the remote compared with my branch (don't merge or pull yet).`)}>
                        Fetch and compare
                      </button>
                      <button className="btn sm" onClick={() => ask(`In ${where(r)}: pull the current branch from origin (fast-forward only). If that isn't possible, stop and show me why.`)}>
                        Pull (ff only)
                      </button>
                      <button className="btn sm" onClick={() => ask(`In ${where(r)}: review the uncommitted changes with the reviewer subagent, then propose a commit message. Don't commit until I say so.`)}>
                        Review and propose commit
                      </button>
                      <button className="btn sm" onClick={() => ask(`In ${where(r)}: create and switch to a new branch called <name> from the current branch.`)}>
                        New branch…
                      </button>
                    </div>

                    <div className="repo-section">
                      <div className="section-head">
                        <span>Branches ({r.branches.filter((b) => showRemote || !b.remote).length})</span>
                        <label className="check small">
                          <input type="checkbox" checked={showRemote} onChange={(e) => setShowRemote(e.target.checked)} /> show remote branches
                        </label>
                      </div>
                      <ul className="branches">
                        {r.branches
                          .filter((b) => showRemote || !b.remote)
                          .map((b) => (
                            <li key={b.name} className={b.current ? 'current' : ''}>
                              <span className="mono">{b.name}</span>
                              {b.current && <span className="pill ok">current</span>}
                              {b.remote && <span className="pill">remote</span>}
                              {b.upstream && (b.ahead || b.behind) ? (
                                <span className="muted small">
                                  {b.ahead ? `↑${b.ahead}` : ''}
                                  {b.behind ? ` ↓${b.behind}` : ''}
                                </span>
                              ) : null}
                              <span className="muted small grow">{b.last}</span>
                              {!b.current && (
                                <>
                                  <button className="link small" onClick={() => ask(`In ${where(r)}: switch to branch \`${b.name}\`${b.remote ? ' (track it locally)' : ''}. If there are uncommitted changes, stop and tell me first.`)}>
                                    switch
                                  </button>
                                  <button className="link small" onClick={() => ask(`In ${where(r)}: compare branch \`${b.name}\` with the current branch: commits each side has that the other doesn't, and a short summary of the file changes.`)}>
                                    compare
                                  </button>
                                </>
                              )}
                            </li>
                          ))}
                      </ul>
                    </div>

                    {dirty > 0 && (
                      <div className="repo-section">
                        <div className="section-head">
                          <span>Uncommitted changes</span>
                        </div>
                        <pre className="repo-diff">{diff[r.path] ?? 'Loading…'}</pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
          <p className="muted small">
            This view only reads. Every button puts a request in the chat for the agent, so branch changes, pulls and commits happen in the
            sandbox where you can see them.
          </p>
        </div>
      </div>
    </div>
  )
}
