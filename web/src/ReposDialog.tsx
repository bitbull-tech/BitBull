import { useEffect, useState } from 'react'
import { api, type Project, type RepoInfo } from './api'
import { composeInChat } from './activity'
import { IconChevronRight, IconFolder, IconRefresh, IconX } from './icons'

/**
 * Git clones in a project's workspace: branch, what's uncommitted, ahead/behind, branches.
 * These are the AGENT'S copies inside the sandbox — not the code the server runs (that is
 * deployed separately from the machine you edit on) and not a folder on your PC.
 *
 * Almost read-only: "Sync from origin" fetches and fast-forwards, because a stale copy quietly
 * wastes a QA Hound run; "Change remote" points a copy somewhere else (the repo was renamed, or it
 * should follow a folder you linked); "Add a repository" makes a copy of a repo in a linked folder.
 * Every other change (checkout, commit, push) is handed to the agent as a chat message, so it
 * happens in view and the reviewer can look at it.
 */
const lastName = (s: string) =>
  s
    .trim()
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop()!
    .replace(/\.git$/i, '')
const errText = (e: unknown) => (e instanceof Error ? e.message.replace(/^\d+ /, '').replace(/^\{"error":"(.*)"\}$/, '$1') : String(e))
export function ReposDialog({ project, onClose, onBrowse }: { project: Project | null; onClose: () => void; onBrowse: (dir: string) => void }) {
  const pid = project?.id ?? 'general'
  const [repos, setRepos] = useState<RepoInfo[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [diff, setDiff] = useState<Record<string, string>>({})
  const [showRemote, setShowRemote] = useState(false)
  const [syncing, setSyncing] = useState<string | null>(null)
  const [synced, setSynced] = useState<{ path: string; ok: boolean; message: string } | null>(null)
  // repos in the owner's linked folders: offered as a new origin, and as something to copy in
  const [linked, setLinked] = useState<Array<{ ref: string; name: string }>>([])
  const [remoteFor, setRemoteFor] = useState<string | null>(null)
  const [source, setSource] = useState('')
  const [rename, setRename] = useState(true)
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState('')
  const [added, setAdded] = useState<{ ok: boolean; message: string } | null>(null)
  useEffect(() => {
    void api
      .repoSources(pid)
      .then((r) => setLinked(r.linked))
      .catch(() => setLinked([]))
  }, [pid])
  const openRemote = (r: RepoInfo) => {
    setSynced(null)
    setRemoteFor(remoteFor === r.path ? null : r.path)
    // the likeliest fix first: a linked repo, when there is exactly one to offer
    setSource(linked.length === 1 ? linked[0].ref : '')
    setRename(true)
  }
  const saveRemote = async (r: RepoInfo) => {
    if (!source.trim() || busy) return
    setBusy(true)
    try {
      const res = await api.setRepoRemote(pid, r.path, source.trim(), rename)
      setRepos(res.repos)
      const at = res.path ?? r.path
      setSynced({ path: at, ok: res.ok, message: res.message })
      if (res.ok) {
        setRemoteFor(null)
        setOpen(at)
      }
    } catch (e) {
      setSynced({ path: r.path, ok: false, message: errText(e) })
    } finally {
      setBusy(false)
    }
  }
  const add = async (ref: string) => {
    if (!ref.trim() || busy) return
    setBusy(true)
    setAdded(null)
    try {
      const res = await api.addRepo(pid, ref.trim())
      setRepos(res.repos)
      setAdded({ ok: res.ok, message: res.message })
      if (res.ok) {
        setAdding('')
        if (res.path) setOpen(res.path)
      }
    } catch (e) {
      setAdded({ ok: false, message: errText(e) })
    } finally {
      setBusy(false)
    }
  }
  const isGithub = (s: string) => /^https:\/\//i.test(s.trim()) || (/^[\w.-]+\/[\w.-]+$/.test(s.trim()) && !s.trim().startsWith('links/'))
  // Ditto Review per branch: what happened, keyed by repo + branch
  const [ditto, setDitto] = useState<Record<string, { busy?: boolean; ok?: boolean; message?: string; url?: string; openPr?: string }>>({})
  const askDitto = async (r: RepoInfo, branch: string) => {
    const key = `${r.path}:${branch}`
    setDitto((d) => ({ ...d, [key]: { busy: true } }))
    try {
      const res = await api.dittoReview(pid, r.path, branch)
      setDitto((d) => ({ ...d, [key]: { ok: res.ok, message: res.message, url: res.prUrl, openPr: res.compareUrl } }))
    } catch (e) {
      setDitto((d) => ({ ...d, [key]: { ok: false, message: e instanceof Error ? e.message.replace(/^\d+ /, '').replace(/^\{"error":"(.*)"\}$/, '$1') : String(e) } }))
    }
  }
  const onGithub = (r: RepoInfo) => !!r.remote && /github\.com[:/]/.test(r.remote)

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

  const sync = async (repo: string) => {
    setSyncing(repo)
    setSynced(null)
    try {
      const r = await api.syncRepo(pid, repo)
      setRepos(r.repos)
      setSynced({ path: repo, ok: r.ok, message: r.message })
    } catch (e) {
      setSynced({ path: repo, ok: false, message: e instanceof Error ? e.message : String(e) })
    } finally {
      setSyncing(null)
    }
  }

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
          {repos?.length === 0 && <p className="muted small">No git repositories in this workspace yet. Add one below.</p>}
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
                      <button
                        className="btn sm"
                        title="Fetch from origin and fast-forward this copy. Refuses if the tree is dirty or the branch has diverged."
                        disabled={syncing === r.path}
                        onClick={() => void sync(r.path)}
                      >
                        {syncing === r.path ? 'Syncing…' : 'Sync from origin'}
                      </button>
                      <button className="btn sm" onClick={() => ask(`In ${where(r)}: review the uncommitted changes with the reviewer subagent, then propose a commit message. Don't commit until I say so.`)}>
                        Review and propose commit
                      </button>
                      <button className="btn sm" onClick={() => ask(`In ${where(r)}: create and switch to a new branch called <name> from the current branch.`)}>
                        New branch…
                      </button>
                      <button
                        className={`btn sm ${remoteFor === r.path ? 'on' : ''}`}
                        title="The repository was renamed or moved, or this copy should follow a folder you linked"
                        onClick={() => openRemote(r)}
                      >
                        Change remote…
                      </button>
                    </div>
                    {remoteFor === r.path && (
                      <form
                        className="repo-remote"
                        onSubmit={(e) => {
                          e.preventDefault()
                          void saveRemote(r)
                        }}
                      >
                        <label htmlFor="repo-remote-src">Where this copy should come from</label>
                        <div className="repo-remote-row">
                          <input
                            id="repo-remote-src"
                            autoFocus
                            list="repo-sources"
                            value={source}
                            placeholder="links/<folder>/<repo>, owner/name, or https://github.com/owner/name.git"
                            onChange={(e) => setSource(e.target.value)}
                            spellCheck={false}
                          />
                          <button className="btn sm primary" type="submit" disabled={!source.trim() || busy}>
                            {busy ? 'Changing…' : 'Change and fetch'}
                          </button>
                          <button className="btn sm" type="button" onClick={() => setRemoteFor(null)}>
                            Cancel
                          </button>
                        </div>
                        {source.trim() && lastName(source) !== r.name && r.path !== '.' && (
                          <label className="check small">
                            <input type="checkbox" checked={rename} onChange={(e) => setRename(e.target.checked)} /> Rename the folder from <span className="mono">{r.name}</span> to{' '}
                            <span className="mono">{lastName(source)}</span>
                          </label>
                        )}
                        <p className="muted small">
                          Points <span className="mono">origin</span> at the new place and fetches. Uncommitted work and local branches are left as they are.
                          {linked.length === 0 && ' To follow a folder on your PC, link it under Settings → Folders first.'}
                        </p>
                      </form>
                    )}
                    {synced?.path === r.path && <p className={`small ${synced.ok ? 'muted' : 'error'}`}>{synced.message}</p>}
                    {r.behind > 0 && (
                      <p className="small warn-line">
                        This copy is {r.behind} commit{r.behind === 1 ? '' : 's'} behind {r.upstream ?? 'origin'}
                        {r.ahead ? ` and ${r.ahead} ahead` : ''}. A QA Hound run would review the older code.
                      </p>
                    )}

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
                              {onGithub(r) && (
                                <button
                                  className="link small"
                                  disabled={ditto[`${r.path}:${b.name}`]?.busy}
                                  title="Ask Ditto Review to review this branch's open pull request (comments @ditto review on it, as you)"
                                  onClick={() => void askDitto(r, b.name)}
                                >
                                  {ditto[`${r.path}:${b.name}`]?.busy ? 'asking Ditto…' : 'Ditto review'}
                                </button>
                              )}
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
                              {ditto[`${r.path}:${b.name}`]?.message && (
                                <div className={`ditto-note small ${ditto[`${r.path}:${b.name}`]?.ok ? 'ok' : ''}`}>
                                  {ditto[`${r.path}:${b.name}`]!.message}{' '}
                                  {ditto[`${r.path}:${b.name}`]?.url && (
                                    <a href={ditto[`${r.path}:${b.name}`]!.url} target="_blank" rel="noreferrer">
                                      Open the pull request
                                    </a>
                                  )}
                                  {ditto[`${r.path}:${b.name}`]?.openPr && (
                                    <a href={ditto[`${r.path}:${b.name}`]!.openPr} target="_blank" rel="noreferrer">
                                      Open a pull request on GitHub
                                    </a>
                                  )}
                                </div>
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
          {repos !== null && (
            <div className="repo-add">
              <div className="section-head">
                <span>Add a repository</span>
              </div>
              {linked.filter((l) => !repos.some((r) => r.name === l.name)).length > 0 && (
                <div className="repo-add-linked">
                  <span className="muted small">From your linked folders:</span>
                  {linked
                    .filter((l) => !repos.some((r) => r.name === l.name))
                    .map((l) => (
                      <button key={l.ref} className="btn sm" disabled={busy} title={`Make a working copy of ${l.ref} here`} onClick={() => void add(l.ref)}>
                        {l.name} <span className="mono muted">{l.ref}</span>
                      </button>
                    ))}
                </div>
              )}
              <form
                className="repo-remote-row"
                onSubmit={(e) => {
                  e.preventDefault()
                  const s = adding.trim()
                  if (!s) return
                  if (isGithub(s)) ask(`Clone the GitHub repository \`${s}\` into this project's workspace (shallow is fine), then summarise what it is and how it builds.`)
                  else void add(s)
                }}
              >
                <input
                  list="repo-sources"
                  value={adding}
                  placeholder="links/<folder>/<repo>, or owner/name on GitHub"
                  onChange={(e) => setAdding(e.target.value)}
                  spellCheck={false}
                  aria-label="Repository to add"
                />
                <button className="btn sm" type="submit" disabled={!adding.trim() || busy}>
                  {isGithub(adding) ? 'Ask the agent to clone it' : busy ? 'Adding…' : 'Add'}
                </button>
              </form>
              {added && <p className={`small ${added.ok ? 'muted' : 'error'}`}>{added.message}</p>}
              <p className="muted small">
                A repo in a linked folder is copied in and follows that folder, so "Sync from origin" brings in what you commit on your PC. A GitHub
                repository is cloned by the agent in the chat, because private ones need your token.
              </p>
            </div>
          )}
          <datalist id="repo-sources">
            {linked.map((l) => (
              <option key={l.ref} value={l.ref} />
            ))}
          </datalist>
          <p className="muted small">
            <b>These are the agent's working copies</b>, inside BitBull's sandbox — not the code BitBull itself is running, and not the folder on
            your PC. They are what the agent reads, edits and reviews, and what QA Hound looks at. "Sync from origin" fetches and
            fast-forwards a copy, and "Change remote" points it somewhere else; every other button puts a request in the chat so the agent does
            the work where you can see it.
          </p>
        </div>
      </div>
    </div>
  )
}
