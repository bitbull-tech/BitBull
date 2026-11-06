import { useEffect, useState } from 'react'
import { api, type Model, type Project, type RepoInfo, type Session, type Swarm } from './api'
import { IconX } from './icons'
import { priceLabel } from './ModelPicker'

const FOCUS: { id: Swarm['focus'][number]; label: string; hint: string }[] = [
  { id: 'attack-vectors', label: 'Attack vectors', hint: 'how a hostile input, contributor, dependency or prompt-injected agent could abuse it; entry point → impact' },
  { id: 'correctness', label: 'Correctness', hint: 'does what it claims; logic errors, races, data loss, misleading behaviour, tests that don’t test' },
  { id: 'code-quality', label: 'Code quality', hint: 'duplication, structure, naming, dead code, error handling, coverage' },
  { id: 'performance', label: 'Performance', hint: 'hot spots, waste, memory/I-O, scalability, leaks' },
  { id: 'user-experience', label: 'User experience', hint: 'fit for purpose, first-run and everyday workflows, error messages, docs, real-world use' },
]

/**
 * QA swarm: pick a repo, folder or file in the workspace and up to two other models. Each
 * reviews it on its own, then they challenge each other, then this chat's model gives the
 * verdict as its next reply. Progress shows in the pill in the top bar.
 */
export function SwarmDialog({
  session,
  project,
  models,
  primaryModel,
  onClose,
  onStarted,
}: {
  session: Session
  project: Project | null
  models: Model[]
  primaryModel: string
  onClose: () => void
  onStarted: (s: Swarm) => void
}) {
  const [target, setTarget] = useState('')
  const [repos, setRepos] = useState<RepoInfo[]>([])
  const [reposLoaded, setReposLoaded] = useState(false)
  const [a, setA] = useState('')
  const [b, setB] = useState('')
  const [focus, setFocus] = useState<Swarm['focus']>(['attack-vectors', 'correctness', 'code-quality', 'performance', 'user-experience'])
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void api
      .repos(project?.id ?? 'general')
      .then((r) => {
        setRepos(r.repos)
        // default to the first repo in this workspace, whatever the count: reviewing "the repo
        // I'm working on" is the normal case, and an empty box invites a path that isn't there
        setTarget((cur) => cur || r.repos[0]?.path || '')
        setReposLoaded(true)
      })
      .catch(() => setReposLoaded(true))
  }, [project])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const others = models.filter((m) => m.id !== primaryModel)
  // The id, not just the name: SayGM ships TEE and non-TEE builds under the SAME display name
  // (DeepSeek-V4.1-Flash twice, Kimi K3.1 Pro twice), and they differ in price by multiples.
  const option = (m: Model) => (
    <option key={m.id} value={m.id}>
      {m.name || m.id}
      {m.confidential ? ' (TEE)' : ''} — {m.id}
      {m.price ? ` · ${priceLabel(m)}` : ''}
    </option>
  )
  // The reviewers read the agent's copy in this workspace, not your machine and not what the
  // server is running. A copy that is behind origin means a swarm spends real money reviewing
  // code you already changed, so say so before it starts rather than in the verdict.
  const stale = repos.find((r) => r.path === target.trim() && r.behind > 0)
  const [syncing, setSyncing] = useState(false)
  const [fetched, setFetched] = useState<string[]>([])
  // `behind` is only true as of the last fetch, so a copy nobody has fetched always looks level.
  // Fetch once per target when it is a repo, so the warning below means something.
  useEffect(() => {
    const t = target.trim()
    if (!t || fetched.includes(t) || !repos.some((r) => r.path === t)) return
    setFetched((f) => [...f, t])
    void api
      .syncRepo(project?.id ?? 'general', t, true)
      .then((r) => setRepos(r.repos))
      .catch(() => {})
  }, [target, repos, fetched, project])
  const syncNow = async () => {
    if (!stale) return
    setSyncing(true)
    setErr(null)
    try {
      const r = await api.syncRepo(project?.id ?? 'general', stale.path)
      setRepos(r.repos)
      if (!r.ok) setErr(r.message)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSyncing(false)
    }
  }

  const start = async () => {
    setErr(null)
    const chosen = [a, b].filter(Boolean)
    if (!target.trim()) return setErr('Which repo, folder or file? A path inside this workspace, e.g. my-repo or uploads/tool.py.')
    if (!chosen.length) return setErr('Choose at least one reviewer model.')
    if (!focus.length) return setErr('Tick at least one thing to look at.')
    setBusy(true)
    try {
      const r = await api.startSwarm({ sessionId: session.id, target: target.trim(), models: chosen, focus })
      onStarted(r.swarm)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal swarm-modal" role="dialog" aria-label="QA swarm">
        <header className="modal-head">
          <h2>QA swarm · {project?.name ?? 'General workspace'}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <IconX />
          </button>
        </header>
        <div className="modal-body">
          <p className="muted small">
            Up to two other models each review the target in the sandbox, read-only, then read each other's reports and try to knock them down. Your
            current model (<b>{primaryModel}</b>) weighs both and gives the verdict as its next reply in this chat. The reviewers' chats appear in
            the sidebar as "QA swarm · …" so you can read their working.
          </p>
          <label className="field">
            <span>Target (path in this workspace)</span>
            <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="my-repo, src/, uploads/script.py …" list="swarm-repos" />
            <datalist id="swarm-repos">
              {repos.map((r) => (
                <option key={r.path} value={r.path}>
                  {r.name} ({r.branch ?? 'no branch'})
                </option>
              ))}
            </datalist>
            {repos.length > 1 && (
              <span className="chips">
                {repos.map((r) => (
                  <button key={r.path} type="button" className={`chip${target === r.path ? ' on' : ''}`} onClick={() => setTarget(r.path)}>
                    {r.name}
                  </button>
                ))}
              </span>
            )}
            {reposLoaded && repos.length === 0 && (
              <span className="muted small">
                No repos cloned in {project ? `"${project.name}"` : 'the general workspace'}. Clone one from Repositories first, or give a path to
                something that is here (an upload, a linked folder).
              </span>
            )}
          </label>
          <div className="row2">
            <label className="field">
              <span>Reviewer 1</span>
              <select value={a} onChange={(e) => setA(e.target.value)}>
                <option value="">— choose —</option>
                {others.filter((m) => m.id !== b).map(option)}
              </select>
            </label>
            <label className="field">
              <span>Reviewer 2 (optional)</span>
              <select value={b} onChange={(e) => setB(e.target.value)}>
                <option value="">— none —</option>
                {others.filter((m) => m.id !== a).map(option)}
              </select>
            </label>
          </div>
          <div className="field">
            <span>Look at</span>
            <div className="checks">
              {FOCUS.map((f) => (
                <label key={f.id} className="check" title={f.hint}>
                  <input
                    type="checkbox"
                    checked={focus.includes(f.id)}
                    onChange={(e) => setFocus((cur) => (e.target.checked ? [...cur, f.id] : cur.filter((x) => x !== f.id)))}
                  />
                  {f.label}
                </label>
              ))}
            </div>
          </div>
          <p className="muted small">
            Different model families catch different things; two reviewers from the same family mostly share blind spots. Cost: three to five
            full passes over the target, so pick models you can afford.
          </p>
          {stale && (
            <p className="small warn-line">
              <b>{stale.name} is {stale.behind} commit{stale.behind === 1 ? '' : 's'} behind {stale.upstream ?? 'origin'}.</b> The reviewers read
              this workspace copy, so they would review the older code.{' '}
              <button className="link" disabled={syncing} onClick={() => void syncNow()}>
                {syncing ? 'Syncing…' : 'Sync it first'}
              </button>
            </p>
          )}
          {err && <p className="error small">{err}</p>}
          <div className="row end">
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" onClick={start} disabled={busy}>
              {busy ? 'Starting…' : 'Start swarm'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** The top-bar pill while a swarm runs; polls until the verdict turn starts, then hands over to the chat. */
export function SwarmPill({ swarm, onUpdate, onFinalTurn, onOpen }: { swarm: Swarm; onUpdate: (s: Swarm | null) => void; onFinalTurn: (sessionId: string, turnId: string) => void; onOpen?: () => void }) {
  const [seenFinal, setSeenFinal] = useState(false)
  useEffect(() => {
    if (swarm.phase === 'done' || swarm.phase === 'error') return
    const t = setInterval(() => {
      void api
        .swarm(swarm.id)
        .then((r) => {
          onUpdate(r.swarm)
          if (r.swarm.finalTurnId && !seenFinal) {
            setSeenFinal(true)
            onFinalTurn(r.swarm.sessionId, r.swarm.finalTurnId)
          }
        })
        .catch(() => onUpdate(null))
    }, 3000)
    return () => clearInterval(t)
  }, [swarm.id, swarm.phase, seenFinal, onUpdate, onFinalTurn])
  const label =
    swarm.phase === 'review'
      ? 'reviewing'
      : swarm.phase === 'challenge'
        ? 'challenging'
        : swarm.phase === 'final'
          ? 'verdict'
          : swarm.phase === 'done'
            ? 'done'
            : 'failed'
  const detail = swarm.reviewers.map((r) => `${r.model}: ${r.status}${r.error ? ` (${r.error})` : ''}`).join('\n')
  return (
    <span className={`pill swarm-pill ${swarm.phase === 'error' ? 'bad' : swarm.phase === 'done' ? 'ok' : 'run'}`} title={`QA swarm on ${swarm.target}\n${detail}${swarm.error ? `\n${swarm.error}` : ''}`}>
      <button className="link" onClick={() => onOpen?.()} title="Watch the inquiry">
        swarm · {label}
      </button>
      {swarm.phase === 'done' || swarm.phase === 'error' ? (
        <button className="link small" onClick={() => onUpdate(null)} aria-label="Dismiss">
          ×
        </button>
      ) : null}
    </span>
  )
}
