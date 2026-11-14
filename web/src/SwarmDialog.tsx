import { useEffect, useState } from 'react'
import { api, type HoundOptions, type Model, type Project, type RepoInfo, type Session, type Severity, type Swarm } from './api'
import { IconX } from './icons'
import { priceLabel } from './ModelPicker'
import houndArt from './assets/qa-hound.webp'

const FOCUS: { id: Swarm['focus'][number]; label: string; hint: string }[] = [
  { id: 'attack-vectors', label: 'Attack vectors', hint: 'how a hostile input, contributor, dependency or prompt-injected agent could abuse it; entry point → impact' },
  { id: 'correctness', label: 'Correctness', hint: 'does what it claims; logic errors, races, data loss, misleading behaviour, tests that don’t test' },
  { id: 'code-quality', label: 'Code quality', hint: 'duplication, structure, naming, dead code, error handling, coverage' },
  { id: 'performance', label: 'Performance', hint: 'hot spots, waste, memory/I-O, scalability, leaks' },
  { id: 'user-experience', label: 'User experience', hint: 'fit for purpose, first-run and everyday workflows, error messages, docs, real-world use' },
]

const SEVERITY: Severity[] = ['low', 'medium', 'high', 'critical']
const OPTS_KEY = 'bitbull-hound-options'
const DEFAULTS: HoundOptions = { budgetUsd: 2, maxMinutes: 45, minSeverity: 'low', minConfidence: 70, include: [], exclude: [], pr: false, prBlocking: 'high' }
/** The last settings used, per browser: a convenience, the server checks them again. */
function savedOptions(): HoundOptions {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(OPTS_KEY) ?? '{}') as Partial<HoundOptions>) }
  } catch {
    return DEFAULTS
  }
}
const lines = (t: string) => t.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)

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
  const [opts, setOpts] = useState<HoundOptions>(savedOptions)
  const [include, setInclude] = useState(opts.include.join('\n'))
  const [exclude, setExclude] = useState(opts.exclude.join('\n'))
  const set = (patch: Partial<HoundOptions>) => setOpts((o) => ({ ...o, ...patch }))

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
      const options: HoundOptions = { ...opts, include: lines(include), exclude: lines(exclude) }
      try {
        localStorage.setItem(OPTS_KEY, JSON.stringify(options))
      } catch {
        /* private window */
      }
      const r = await api.startSwarm({ sessionId: session.id, target: target.trim(), models: chosen, focus, options })
      onStarted(r.swarm)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal swarm-modal" role="dialog" aria-label="QA Hound">
        <header className="modal-head">
          <h2>QA Hound · {project?.name ?? 'General workspace'}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <IconX />
          </button>
        </header>
        <div className="modal-body">
          <div className="hound-intro">
            <img className="hound-art" src={houndArt} alt="" draggable={false} />
            <div>
          <p className="hound-lead">
            <b>QA Hound</b> - unleash multiple LLMs on your designated repo, folder or file to review, challenge each other and summarise a
            verdict and recommendations.
          </p>
          <p className="muted small">
            Up to two other models each review the target in the sandbox, read-only, then read each other's reports and try to knock them down. Your
            current model (<b>{primaryModel}</b>) weighs both and gives the verdict as its next reply in this chat. The reviewers' chats appear in
            the sidebar as "QA Hound · …" so you can read their working.
          </p>
            </div>
          </div>
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
          {/* one under the other: side by side, a long model name pushed the second out of view */}
          <div className="reviewers">
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
          <div className="hound-opts">
            <div className="hound-opts-title">Limits and filters</div>
            <div className="row3">
              <label className="field">
                <span>Budget for the whole run (USD)</span>
                <input type="number" min={0.05} max={100} step={0.05} value={opts.budgetUsd} onChange={(e) => set({ budgetUsd: Number(e.target.value) })} />
              </label>
              <label className="field">
                <span>Time limit (minutes)</span>
                <input type="number" min={5} max={120} step={5} value={opts.maxMinutes} onChange={(e) => set({ maxMinutes: Number(e.target.value) })} />
              </label>
              <label className="field">
                <span>Minimum severity</span>
                <select value={opts.minSeverity} onChange={(e) => set({ minSeverity: e.target.value as Severity })}>
                  {SEVERITY.map((x) => (
                    <option key={x} value={x}>
                      {x === 'low' ? 'low and above (all)' : x === 'critical' ? 'critical only' : `${x} and above`}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="muted small">
              Hard caps: the reviewers stop at 75% of the budget and 80% of the time, the rest is kept for the verdict, and the verdict stops at the
              limit. A run that hits a cap ends with what it has, marked partial.
            </p>
            <label className="field">
              <span>
                Minimum confidence: <b>{opts.minConfidence}%</b>
              </span>
              <input type="range" min={0} max={100} step={5} value={opts.minConfidence} onChange={(e) => set({ minConfidence: Number(e.target.value) })} />
              <span className="muted small">
                Your model scores every finding 0–100 for how sure it is, after checking, that it is real. Below this a finding is still listed,
                as held back, but not counted in the verdict or posted to the PR.
              </span>
            </label>
            <div className="row2">
              <label className="field">
                <span>Only these paths (one glob a line)</span>
                <textarea rows={2} value={include} onChange={(e) => setInclude(e.target.value)} placeholder={'src/**\nserver/**/*.ts'} />
              </label>
              <label className="field">
                <span>Never these</span>
                <textarea rows={2} value={exclude} onChange={(e) => setExclude(e.target.value)} placeholder={'**/*.test.ts\ndocs/**'} />
              </label>
            </div>
            <label className="check">
              <input type="checkbox" checked={opts.pr} onChange={(e) => set({ pr: e.target.checked })} />
              Post the verdict on the pull request
            </label>
            {opts.pr && (
              <div className="hound-pr">
                <span className="muted small">
                  The target's repo, its current branch's open PR on GitHub (your GitHub token). Request changes when a shown finding is
                </span>
                <select value={opts.prBlocking} onChange={(e) => set({ prBlocking: e.target.value as Severity })}>
                  {SEVERITY.map((x) => (
                    <option key={x} value={x}>
                      {x} or worse
                    </option>
                  ))}
                </select>
                <span className="muted small">, approve when none is, just comment when the run was partial.</span>
              </div>
            )}
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
              {busy ? 'Starting…' : 'Unleash the hounds'}
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
    <span className={`pill swarm-pill ${swarm.phase === 'error' ? 'bad' : swarm.phase === 'done' ? 'ok' : 'run'}`} title={`QA Hound on ${swarm.target}\n${detail}${swarm.error ? `\n${swarm.error}` : ''}`}>
      <button className="link" onClick={() => onOpen?.()} title="Watch the inquiry">
        QA Hound · {label}
      </button>
      {swarm.phase === 'done' || swarm.phase === 'error' ? (
        <button className="link small" onClick={() => onUpdate(null)} aria-label="Dismiss">
          ×
        </button>
      ) : null}
    </span>
  )
}
