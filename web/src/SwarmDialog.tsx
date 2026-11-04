import { useEffect, useState } from 'react'
import { api, type Model, type Project, type RepoInfo, type Session, type Swarm } from './api'
import { IconX } from './icons'

const FOCUS: { id: Swarm['focus'][number]; label: string; hint: string }[] = [
  { id: 'integrity', label: 'Integrity', hint: 'does what it claims, correctly; hidden behaviour, fake tests' },
  { id: 'security', label: 'Security / exploitability', hint: 'injection, traversal, secrets, supply chain, network' },
  { id: 'efficiency', label: 'Efficiency', hint: 'hot spots, waste, scalability, cost' },
  { id: 'effectiveness', label: 'Effectiveness', hint: 'fit for purpose, API/UX, maintainability, coverage' },
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
  const [a, setA] = useState('')
  const [b, setB] = useState('')
  const [focus, setFocus] = useState<Swarm['focus']>(['integrity', 'security', 'efficiency', 'effectiveness'])
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void api
      .repos(project?.id ?? 'general')
      .then((r) => {
        setRepos(r.repos)
        if (r.repos.length === 1) setTarget(r.repos[0].path)
      })
      .catch(() => {})
  }, [project])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const others = models.filter((m) => m.id !== primaryModel)
  const option = (m: Model) => (
    <option key={m.id} value={m.id}>
      {m.name || m.id}
      {m.provider ? ` · ${m.provider}` : ''}
    </option>
  )
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
export function SwarmPill({ swarm, onUpdate, onFinalTurn }: { swarm: Swarm; onUpdate: (s: Swarm | null) => void; onFinalTurn: (sessionId: string, turnId: string) => void }) {
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
      swarm · {label}
      {swarm.phase === 'done' || swarm.phase === 'error' ? (
        <button className="link small" onClick={() => onUpdate(null)} aria-label="Dismiss">
          ×
        </button>
      ) : null}
    </span>
  )
}
