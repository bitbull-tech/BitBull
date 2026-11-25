import { useEffect, useState } from 'react'
import { api, type DebatePoint, type Model, type Swarm, type SwarmRooms } from './api'
import { IconX } from './icons'
import { dogFor } from './dogs'

import upperPipe from './assets/detectives/upper-pipe.webp'
import forePipe from './assets/detectives/fore-pipe.webp'
import upperGlass from './assets/detectives/upper-glass.webp'
import foreGlass from './assets/detectives/fore-glass.webp'
import torso from './assets/detectives/torso.webp'
import h1 from './assets/detectives/head-1.webp'
import h2 from './assets/detectives/head-2.webp'
import h3 from './assets/detectives/head-3.webp'
import h4 from './assets/detectives/head-4.webp'
import h5 from './assets/detectives/head-5.webp'
import h6 from './assets/detectives/head-6.webp'
import h7 from './assets/detectives/head-7.webp'
import h8 from './assets/detectives/head-8.webp'
import h9 from './assets/detectives/head-9.webp'
import c1 from './assets/detectives/collar-1.webp'
import c2 from './assets/detectives/collar-2.webp'
import c3 from './assets/detectives/collar-3.webp'
import c4 from './assets/detectives/collar-4.webp'
import c5 from './assets/detectives/collar-5.webp'
import c6 from './assets/detectives/collar-6.webp'
import c7 from './assets/detectives/collar-7.webp'
import c8 from './assets/detectives/collar-8.webp'
import c9 from './assets/detectives/collar-9.webp'

/**
 * What the swarm is doing, while it does it.
 *
 * The framing is a detective one because that is honestly what happens: two investigators work
 * the case separately, then cross-examine each other, then the handler delivers a verdict.
 *
 * The reviewers are BitBull's bulldog dressed as Sherlock Holmes — deerstalker, monocle, pipe,
 * magnifying glass and the τ tag — in nine collar colours (art supplied by Tom, cut out of one
 * sheet). Each model gets one from a hash of its id, so it always looks the same, and the two in a
 * room never wear collars you could confuse.
 *
 * Each one is a jointed puppet cut from Tom's parts sheet: both arms in two pieces (upper arm fixed
 * at the shoulder, forearm turning at the elbow), one torso and a head per collar colour. While
 * working the pipe lifts for a puff (held clear of the face) and the smoke drifts off, the glass sweeps with
 * a glint across the lens, and the head tilts as if thinking; the two lean in during
 * cross-examination, and at the end there is a hop and a nod, or a head-shake with the glass let
 * fall. The right upper arm is the left one mirrored (no τ on it); the blue, green and orange
 * collars are recoloured from other heads so all nine sit on the same torso. Never mirror a whole
 * figure: that would flip the τ. Coordinates are the rig's own pixels (242 × 217), the same for all.
 */

/* ---------------- identity ---------------- */

function hash(s: string) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

const HEADS = [h1, h2, h3, h4, h5, h6, h7, h8, h9]
const COLLARS = [c1, c2, c3, c4, c5, c6, c7, c8, c9]
const DETECTIVES = HEADS
/** blue, green, orange, green, pink, teal, maroon, teal, purple: the two greens and two teals look alike */
const LOOK_ALIKE = [[0], [1, 3], [2], [4], [5, 7], [6], [8]]
const groupOf = (i: number) => LOOK_ALIKE.findIndex((g) => g.includes(i))

/** One detective per reviewer: stable per model, and never two that look alike in the same room. */
function castFor(models: string[]): number[] {
  const used = new Set<number>()
  return models.map((m) => {
    let i = dogFor(m) // the same dog as the model's icon everywhere else, unless the room already has its look-alike
    for (let k = 0; k < DETECTIVES.length && used.has(groupOf(i)); k++) i = (i + 1) % DETECTIVES.length
    used.add(groupOf(i))
    return i
  })
}

const KNOWN: Record<string, string> = {
  deepseek: 'DeepSeek', gpt: 'GPT', glm: 'GLM', mimo: 'MiMo', qwen: 'Qwen', kimi: 'Kimi',
  gemini: 'Gemini', gemma: 'Gemma', claude: 'Claude', o3: 'O3',
}
/** "qwen3.8-27b" -> "Qwen", "deepseek-v4.1-flash" -> "DeepSeek" */
function surname(model: string) {
  const first = model.toLowerCase().split(/[^a-z0-9]+/)[0] || model
  const stem = first.replace(/\d.*$/, '')
  const key = stem.length >= 2 ? stem : first
  return KNOWN[key] ?? key.charAt(0).toUpperCase() + key.slice(1)
}
const TITLES = ['Inspector', 'Detective', 'Sergeant', 'Consulting Detective', 'Professor', 'Detective Inspector']
const persona = (model: string) => `${TITLES[hash(model) % TITLES.length]} ${surname(model)}`

/** Said before the first tool call, while there is nothing real to show yet. */
const QUIPS = [
  'A most singular codebase.',
  'One does not guess. One reads the file.',
  'The obvious fix is the one to distrust.',
  'Let us see what the logs confess.',
  'Every symlink has a story. Most of them lie.',
  'Data first; theories after.',
  'Curious. The test passes, yet proves nothing.',
  'The game is afoot.',
]
/** The same, for a document rather than code: a roadmap, a spec, a plan. */
const DOC_QUIPS = [
  'A most singular document.',
  'One does not guess. One reads the page.',
  'A date with no owner is a wish.',
  'What the plan leaves out is the first clue.',
  'Data first; theories after.',
  'Curious. Every milestone depends on the one after it.',
  'The confident paragraph is the one to check.',
  'The game is afoot.',
]
/** One file of prose (a roadmap, a spec, notes), as far as its name says. */
export const isDocument = (target: string) => /\.(md|markdown|txt|rst|adoc|docx?|pdf|rtf|odt|csv|tsv)$/i.test(target.trim())
const quip = (model: string, phase: string, target: string) => {
  const list = isDocument(target) ? DOC_QUIPS : QUIPS
  return list[hash(model + phase) % list.length]
}

/* ---------------- the detective ---------------- */

const VB = { w: 242, h: 217 }
const LENS = { cx: 213, cy: 54, r: 21 }
const PIPE = { x: 25, y: 30 } // inside the drawn smoke, so ours grows out of it rather than floating above
/** Rotation centres: the elbows (forearms turn there) and the neck. The pipe forearm is drawn
 *  already turned out at the elbow, and only swings ±3° from there, so it never crosses the face. */
const PIVOT = { pipe: '52px 164px', glass: '214px 164px', neck: '133px 137px' }

function Detective({ n, slot, model, busy, verdict }: { n: number; slot: number; model: string; busy: boolean; verdict?: 'pass' | 'fail' }) {
  const clip = `lens-${slot}`
  const img = (href: string) => <image href={href} width={VB.w} height={VB.h} />
  return (
    <svg className={`sleuth ${busy ? 'busy' : ''} ${verdict ?? ''}`} viewBox={`0 0 ${VB.w} ${VB.h}`} role="img" aria-label={persona(model)}>
      <defs>
        <clipPath id={clip}>
          <circle cx={LENS.cx} cy={LENS.cy} r={LENS.r} />
        </clipPath>
        {/* soft-edged puffs read as smoke; hard circles read as dots */}
        <filter id={`soft-${slot}`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="2.4" />
        </filter>
      </defs>
      <g className="rig">
        {img(upperPipe)}
        {img(upperGlass)}
        {img(torso)}
        <g className="head" style={{ transformOrigin: PIVOT.neck }}>
          {img(HEADS[n])}
        </g>
        {/* over the head on the right, where the band rises behind the cheek; on the left its end is
            already cut away where the jaw covers it, so it never runs into the mouth */}
        {img(COLLARS[n])}
        <g className="limb pipe" style={{ transformOrigin: PIVOT.pipe }}>
          {img(forePipe)}
          {busy && (
            <g className="smoke" filter={`url(#soft-${slot})`}>
              <circle cx={PIPE.x} cy={PIPE.y} r="7" />
              <circle cx={PIPE.x} cy={PIPE.y} r="7" />
              <circle cx={PIPE.x} cy={PIPE.y} r="7" />
            </g>
          )}
        </g>
        <g className="limb glass" style={{ transformOrigin: PIVOT.glass }}>
          {img(foreGlass)}
          {busy && (
            <g clipPath={`url(#${clip})`}>
              <g transform={`rotate(28 ${LENS.cx} ${LENS.cy})`}>
                <rect className="glint" x={LENS.cx - 4} y={LENS.cy - 32} width="8" height="64" />
              </g>
            </g>
          )}
        </g>
      </g>
      {verdict && (
        <g className={`stamp ${verdict}`}>
          <circle cx="133" cy="192" r="17" />
          {verdict === 'pass' ? <path d="M124 192l6 6 12-13" /> : <path d="M126 185l14 14M140 185l-14 14" />}
        </g>
      )}
    </svg>
  )
}

/* ---------------- the room ---------------- */

/** Mirrors the server's floor: a report behind this much evidence has not reviewed anything. */
const thin = (e: { tools: number; files: number }) => e.files < 5 || e.tools < 8

const PHASE_LINE: Record<Swarm['phase'], string> = {
  review: 'Working the case separately. Neither has seen the other’s notes.',
  challenge: 'Cross-examination: each is attacking the other’s findings point by point, and defending its own.',
  final: 'The Chief Inspector is weighing both files and writing the verdict.',
  done: 'Verdict delivered — it’s in the chat.',
  error: 'The investigation broke down.',
}

const short = (h?: string | null, n = 12) => (h ? h.replace(/^sha256:/, '').slice(0, n) : '')

/** The confidential sandbox and the clean-machine certificate, when the run used them. */
function RoomsPanel({ s }: { s: Swarm & SwarmRooms }) {
  const c = s.certificate
  const sandboxAsked = (s.options as { sandbox?: boolean } | undefined)?.sandbox
  const cleanAsked = (s.options as { cleanMachine?: { enabled?: boolean } } | undefined)?.cleanMachine?.enabled
  if (!sandboxAsked && !cleanAsked) return null
  return (
    <div className="theatre-checks small">
      {sandboxAsked && (
        <p>
          <b>Confidential sandbox: </b>
          {s.sandbox?.sandboxId && !s.sandboxError ? (
            <span>
              reviewers could run the code in room <span className="mono">{s.sandbox.sandboxId}</span>, network closed
              {s.sandbox.imageDigest ? <> · image <span className="mono">{short(s.sandbox.imageDigest)}</span></> : null}
              {s.sandbox.deleted ? ` · deleted${s.sandbox.receiptHead?.n != null ? `, receipt head n=${s.sandbox.receiptHead.n}` : ''}` : ''}
            </span>
          ) : s.sandboxError ? (
            <span className="error">ran read-only: {s.sandboxError}</span>
          ) : (
            <span className="muted">waiting for your approval of the room</span>
          )}
        </p>
      )}
      {cleanAsked && (
        <>
          <b>Clean-machine test{c ? `: ${c.result === 'pass' ? 'passed' : c.result === 'fail' ? 'failed' : 'incomplete'}` : ''}</b>
          {!c && s.cleanMachine !== 'done' && <span className="muted"> · running (you approve the room first)</span>}
          {!c && s.cleanMachineError && <span className="error"> · no certificate: {s.cleanMachineError}</span>}
          {c && (
            <>
              <ul>
                {c.commands.map((x) => (
                  <li key={x.step} className={x.ok ? 'ok' : x.state === 'not_run' ? '' : 'bad'} title={x.command}>
                    <span aria-hidden="true">{x.ok ? '✓' : x.state === 'not_run' ? '·' : '✗'}</span> {x.step}{' '}
                    <span className="mono">{x.command.length > 60 ? `${x.command.slice(0, 60)}…` : x.command}</span>
                    {x.state === 'not_run' ? ' · not run' : ` · exit ${x.exitCode ?? x.state}`}
                    {x.durationMs != null ? ` · ${(x.durationMs / 1000).toFixed(1)} s` : ''}
                  </li>
                ))}
              </ul>
              <span className="muted">
                {c.repo.path} at <span className="mono">{short(c.repo.commit)}</span>
                {c.repo.uncommittedChanges ? ` (${c.repo.uncommittedChanges} uncommitted changes not included)` : ''} · image{' '}
                {c.room.imageDigest ? <span className="mono">{short(c.room.imageDigest)}</span> : 'digest not reported'} · network{' '}
                {c.room.network === 'closed' ? 'closed' : `only ${c.room.allowHosts.join(', ')}`} · receipt head{' '}
                {c.receiptHead.n != null ? <span className="mono">n={c.receiptHead.n} {short(c.receiptHead.sha256)}</span> : 'not available'} · verify{' '}
                {c.verify.ok === true ? 'passed' : c.verify.ok === false ? <span className="error">failed</span> : 'not available'}
                {c.room.createReceiptUrl && (
                  <>
                    {' · '}
                    <a href={c.room.createReceiptUrl} target="_blank" rel="noreferrer">
                      public receipt
                    </a>
                  </>
                )}
                {c.room.maxSpendUsd ? ` · room hold up to $${c.room.maxSpendUsd} (not model spend)` : ''}
              </span>
              <br />
              <span className="muted">
                {c.files ? (
                  <>
                    Saved in the project workspace: <span className="mono">{c.files.md}</span>, <span className="mono">{c.files.json}</span>
                    {c.evidence.path ? (
                      <>
                        {' '}
                        and the evidence bundle for the offline verifier, <span className="mono">{c.evidence.path}</span>
                      </>
                    ) : (
                      ` (evidence bundle not saved: ${c.evidence.error ?? 'unknown'})`
                    )}
                    .
                  </>
                ) : (
                  'The certificate could not be saved.'
                )}{' '}
                It shows these commands ran in a fresh confidential sandbox at this commit with these results; not that the code is safe.
              </span>
            </>
          )}
        </>
      )}
    </div>
  )
}

const STEPS: Array<{ id: 'review' | 'challenge' | 'final'; label: string; hint: string }> = [
  { id: 'review', label: 'Review', hint: 'each works the case alone' },
  { id: 'challenge', label: 'Cross-examination', hint: 'point by point, up to 3 rounds' },
  { id: 'final', label: 'Verdict', hint: 'the Chief Inspector weighs both' },
]
const NEXT: Record<Swarm['phase'], string> = {
  review: 'Next: they cross-examine each other, point by point, for up to three rounds.',
  challenge: 'Next: the Chief Inspector weighs both files and writes the verdict in the chat.',
  final: 'Next: the verdict lands in the chat this started from.',
  done: '',
  error: '',
}
const FOCUS_NAME: Record<Swarm['focus'][number], string> = {
  'attack-vectors': 'Attack vectors',
  correctness: 'Correctness',
  'code-quality': 'Code quality',
  performance: 'Performance',
  'user-experience': 'User experience',
}
const VERDICT: Record<NonNullable<Swarm['verdict']>, { text: string; cls: string }> = {
  use: { text: 'Use it as it is', cls: 'ok' },
  'fix-first': { text: 'Fix first', cls: 'warn' },
  'do-not-use': { text: 'Do not use', cls: 'bad' },
}
const SAYS: Record<NonNullable<Swarm['verdict']>, string> = { use: 'use it', 'fix-first': 'fix first', 'do-not-use': 'do not use' }
const clock = (sec: number) => (sec >= 60 ? `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s` : `${sec}s`)
const STATUS: Record<Swarm['reviewers'][number]['status'], string> = { pending: 'waiting for the brief', reviewing: 'reviewing', challenging: 'cross-examining', done: 'case closed', error: 'failed' }

const STANCE: Record<DebatePoint['turns'][number]['stance'], string> = { agree: 'agrees', refute: 'objects', 'cant-tell': 'can’t tell', hold: 'holds', concede: 'concedes' }
const POINT_GROUPS: Array<{ status: DebatePoint['status']; title: string; hint: string }> = [
  { status: 'disputed', title: 'Still disputed', hint: 'They didn’t settle these. The Chief Inspector decides each one.' },
  { status: 'open', title: 'In play', hint: 'Waiting for an answer in the next round.' },
  { status: 'confirmed', title: 'Confirmed', hint: 'The other one checked it and agrees.' },
  { status: 'dropped', title: 'Dropped', hint: 'Whoever raised it conceded.' },
]

/**
 * The cross-examination as one back-and-forth: every point either reviewer raised, who attacked
 * it, who held and who conceded. The full working is still in their two chats.
 */
function Debate({ s }: { s: Swarm }) {
  const points = s.debate ?? []
  const [show, setShow] = useState<DebatePoint['status'] | 'all'>('all')
  if (!points.length) return null
  const who = (i: number) => (s.reviewers[i] ? persona(s.reviewers[i].model) : `Reviewer ${i + 1}`)
  const count = (st: DebatePoint['status']) => points.filter((p) => p.status === st).length
  const running = s.phase === 'challenge'
  return (
    <section className="theatre-debate" aria-label="The cross-examination">
      <div className="debate-head">
        <b>The cross-examination</b>
        <span className="muted small">
          {running ? `round ${s.round ?? 1} of up to 3` : `${s.round ?? 1} round${(s.round ?? 1) === 1 ? '' : 's'}`} · {points.length} point{points.length === 1 ? '' : 's'}
        </span>
        <span className="grow" />
        <div className="debate-filter" role="tablist" aria-label="Show">
          <button type="button" role="tab" aria-selected={show === 'all'} className={show === 'all' ? 'on' : ''} onClick={() => setShow('all')}>
            All
          </button>
          {POINT_GROUPS.filter((g) => count(g.status) > 0).map((g) => (
            <button type="button" role="tab" key={g.status} aria-selected={show === g.status} className={`${g.status} ${show === g.status ? 'on' : ''}`} onClick={() => setShow(g.status)} title={g.hint}>
              {g.title} {count(g.status)}
            </button>
          ))}
        </div>
      </div>
      <div className="debate-list">
        {POINT_GROUPS.filter((g) => (show === 'all' || show === g.status) && count(g.status) > 0).map((g) => (
          <div key={g.status} className={`debate-group ${g.status}`}>
            <div className="debate-group-title">
              {g.title} <span className="muted small">{g.hint}</span>
            </div>
            {points
              .filter((p) => p.status === g.status)
              .map((p) => (
                <details key={p.id} className="debate-point" open={g.status === 'disputed' || g.status === 'open'}>
                  <summary>
                    <span className="point-id">{p.id}</span>
                    {p.severity && <span className={`sev ${p.severity}`}>{p.severity}</span>}
                    <span className="point-what">{p.what}</span>
                  </summary>
                  <div className="point-body">
                    <span className="muted small">
                      Raised by {who(p.owner)}
                      {p.raised ? ` in round ${p.raised}, as something the other missed` : ' in its report'}
                      {p.location ? ` · ${p.location}` : ''}
                    </span>
                    {p.turns.length === 0 && <span className="muted small">{running ? 'Not answered yet.' : 'The other one never answered it.'}</span>}
                    {p.turns.map((t, i) => (
                      <div key={i} className={`point-turn ${t.by === p.owner ? 'own' : 'other'} ${t.stance}`}>
                        <span className="turn-who">
                          <span className="muted">R{t.round}</span> {who(t.by)} <b>{STANCE[t.stance]}</b>
                        </span>
                        <span className="turn-why">{t.why || 'No reason given.'}</span>
                      </div>
                    ))}
                  </div>
                </details>
              ))}
          </div>
        ))}
      </div>
    </section>
  )
}

const CAUSE_TITLE: Record<NonNullable<Swarm['cause']>, string> = {
  network: 'The connection dropped',
  model: 'A model refused',
  budget: 'The budget ran out',
  time: 'The time limit ran out',
  stopped: 'You stopped it',
  restart: 'BitBull was restarted',
  other: 'It didn’t finish',
}
const hhmmss = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

/** A seat's model, from every model on offer (and the current one, even if it has since gone). */
function SeatSelect({ models, value, onChange }: { models: Model[]; value: string; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {!models.some((m) => m.id === value) && <option value={value}>{value}</option>}
      {models.map((m) => (
        <option key={m.id} value={m.id}>
          {m.name}
          {m.gateway === 'ditto-router' ? ' · Ditto Router' : ''}
        </option>
      ))}
    </select>
  )
}

/**
 * A run that failed: what went wrong, and picking it up again. A seat that keeps its model keeps
 * the report it had finished; change a seat's model and that seat runs again.
 */
function PickUp({ s, models, onResumed }: { s: Swarm; models: Model[]; onResumed: (next: Swarm) => void }) {
  const [seats, setSeats] = useState(s.reviewers.map((r) => r.model))
  const [judge, setJudge] = useState(s.primaryModel)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const plan = s.reviewers.map((r, i) => {
    const same = seats[i] === r.model
    const has = r.hasReport && r.status !== 'error'
    return same && has ? 'keeps its report' : same ? 'runs again (it didn’t finish)' : 'runs again on the new model'
  })
  const allKept = plan.every((p) => p === 'keeps its report')
  const go = async () => {
    setBusy(true)
    setErr(null)
    try {
      const r = await api.resumeSwarm(s.id, { models: seats, primaryModel: judge })
      onResumed(r.swarm)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }
  return (
    <div className="theatre-pickup">
      <div className="pickup-head">
        <b>{CAUSE_TITLE[s.cause ?? 'other']}</b>
        <span>{s.advice}</span>
      </div>
      <div className="pickup-seats">
        {s.reviewers.map((r, i) => (
          <label key={r.sessionId}>
            <span>{persona(r.model)}</span>
            <SeatSelect models={models} value={seats[i]} onChange={(v) => setSeats((cur) => cur.map((x, k) => (k === i ? v : x)))} />
            <small className={plan[i] === 'keeps its report' ? 'ok' : ''}>{plan[i]}</small>
          </label>
        ))}
        <label>
          <span>The verdict</span>
          <SeatSelect models={models} value={judge} onChange={setJudge} />
          <small>{allKept && s.reviewers.every((r) => r.hasRebuttal || s.reviewers.length < 2) ? 'the only thing left to run' : 'runs after the reviewers'}</small>
        </label>
      </div>
      {err && <p className="error small">{err}</p>}
      <div className="pickup-actions">
        <span className="muted small">It starts with a fresh budget (${s.options.budgetUsd.toFixed(2)}) and time limit ({s.options.maxMinutes} min) for what is left to do.</span>
        <button className="btn primary" disabled={busy || new Set(seats).size !== seats.length} onClick={() => void go()}>
          {busy ? 'Starting…' : 'Pick up again'}
        </button>
      </div>
    </div>
  )
}

export function SwarmTheatre({
  swarm,
  models = [],
  onUpdate,
  onClose,
  onOpenSession,
}: {
  swarm: Swarm
  /** every model on offer, for "pick up again" with a different one */
  models?: Model[]
  onUpdate: (s: Swarm | null) => void
  onClose: () => void
  onOpenSession?: (id: string) => void
}) {
  const [s, setS] = useState(swarm)
  useEffect(() => setS(swarm), [swarm])
  const [stopping, setStopping] = useState(false)
  const running = s.phase !== 'done' && s.phase !== 'error'
  // the clock ticks every second; the run itself is asked about every two
  const [, setNow] = useState(0)
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setNow((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [running])

  useEffect(() => {
    if (s.phase === 'done' || s.phase === 'error') return
    const t = setInterval(() => {
      void api
        .swarm(s.id)
        .then((r) => {
          setS(r.swarm)
          onUpdate(r.swarm)
        })
        .catch(() => {})
    }, 2000)
    return () => clearInterval(t)
  }, [s.id, s.phase, onUpdate])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const stop = async () => {
    if (!confirm('Stop this review? The reviewers are halted and no verdict is written. What they have written so far stays in their chats.')) return
    setStopping(true)
    try {
      const r = await api.stopSwarm(s.id)
      setS(r.swarm)
      onUpdate(r.swarm)
    } catch {
      setStopping(false)
    }
  }

  const cast = castFor(s.reviewers.map((r) => r.model))
  const elapsed = Math.max(0, Math.round(((s.finishedAt ?? Date.now()) - s.startedAt) / 1000))
  const limitSec = (s.options?.maxMinutes ?? 0) * 60
  const spent = s.spentUsd ?? 0
  const budget = s.options?.budgetUsd ?? 0
  const pct = (a: number, b: number) => (b > 0 ? Math.min(100, Math.round((100 * a) / b)) : 0)
  const cut = s.target.replace(/\/+$/, '').lastIndexOf('/')
  const name = s.target.replace(/\/+$/, '').slice(cut + 1) || s.target
  const folder = cut >= 0 ? s.target.slice(0, cut + 1) : ''
  const single = s.reviewers.length < 2
  // where a failed run stopped: the first stage whose work isn't all there
  const failedAt = !s.reviewers.some((r) => r.hasReport && r.status !== 'error') ? 0 : !single && !s.reviewers.every((r) => r.hasRebuttal) && s.reviewers.filter((r) => r.status !== 'error').length > 1 ? 1 : 2
  const stepAt = s.phase === 'done' ? 3 : s.phase === 'error' ? failedAt : STEPS.findIndex((x) => x.id === s.phase)
  const shown = s.findings?.filter((f) => f.shown) ?? []
  const serious = shown.filter((f) => f.severity === 'critical' || f.severity === 'high').length

  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal theatre" role="dialog" aria-label="QA Hound progress">
        <header className="modal-head theatre-head">
          <div className="theatre-title">
            <h2 title={s.target}>
              The inquiry · <span className="theatre-name">{name}</span>
            </h2>
            <div className="theatre-sub">
              {folder && <span className="mono theatre-folder" title={s.target}>{folder}</span>}
              {s.focus.map((f) => (
                <span className="chip" key={f}>
                  {FOCUS_NAME[f] ?? f}
                </span>
              ))}
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <IconX />
          </button>
        </header>

        <ol className="theatre-steps" aria-label="Stages">
          {STEPS.map((st, i) => {
            const skipped = st.id === 'challenge' && single
            const state = skipped ? 'skipped' : stepAt > i ? 'done' : stepAt === i ? (s.phase === 'error' ? 'failed' : 'now') : 'todo'
            return (
              <li key={st.id} className={state} aria-current={state === 'now' ? 'step' : undefined}>
                <span className="step-dot">{state === 'done' ? '✓' : state === 'failed' ? '!' : i + 1}</span>
                <span className="step-text">
                  <b>{st.label}</b>
                  <small>{skipped ? 'needs two reviewers' : state === 'failed' ? 'stopped here' : st.hint}</small>
                </span>
              </li>
            )
          })}
        </ol>

        <div className={`theatre-now ${s.phase}`} role="status">
          <span>{PHASE_LINE[s.phase]}</span>
          {running && <span className="muted">{s.stopAsked || stopping ? 'Stopping…' : NEXT[s.phase]}</span>}
          {s.error && <span className="error">{s.error}</span>}
        </div>

        {s.options && (
          <div className="theatre-bars">
            <div className="theatre-bar" title="How long it has run, against the time limit you set">
              <span className="bar-label">Time</span>
              <div className="voice-meter">
                <i style={{ width: `${pct(elapsed, limitSec)}%` }} />
              </div>
              <span className="bar-num">
                {clock(elapsed)} of {s.options.maxMinutes} min
              </span>
            </div>
            <div className="theatre-bar" title="Spend so far against the run's hard budget (the reviewers stop at 75%, the rest is kept for the verdict)">
              <span className="bar-label">Spend</span>
              <div className="voice-meter">
                <i style={{ width: `${pct(spent, budget)}%` }} />
              </div>
              <span className="bar-num">
                ${spent.toFixed(spent < 0.1 ? 3 : 2)} of ${budget.toFixed(2)}
              </span>
            </div>
            {running && (
              <span className="muted small theatre-eta">
                {spent === 0 && elapsed > 20 ? 'Spend shows once a model reports its usage. ' : ''}
                {isDocument(s.target) ? 'One document is usually done in a few minutes.' : 'A repo or folder can take a good while; these are limits, not a forecast.'}
                {s.stopped && !s.stopAsked ? ` Stopped early: ${s.stopped}.` : ''}
              </span>
            )}
          </div>
        )}

        <div className={`theatre-room phase-${s.phase}`}>
          {s.reviewers.map((r, slot) => {
            const busy = r.status === 'reviewing' || r.status === 'challenging'
            const verdict = r.status === 'done' ? 'pass' : r.status === 'error' ? 'fail' : undefined
            const said = r.error ? null : r.note ?? (busy ? quip(r.model, r.status, s.target) : r.status === 'done' ? 'Case closed.' : 'Awaiting the brief.')
            const rec = r.final ?? r.initial
            return (
              <div className={`detective ${r.status}`} key={r.sessionId}>
                <Detective n={cast[slot]} slot={slot} model={r.model} busy={busy} verdict={verdict} />
                <div className="who">
                  <b className="persona">{persona(r.model)}</b>
                  <span className="model-id" title={r.model}>{r.model}</span>
                  <span className={`status ${r.status}`}>
                    {busy && <span className="pound-dot" />}
                    {r.kept && r.status === 'done' ? 'report kept from before' : STATUS[r.status]}
                  </span>
                  <div className="bubble" data-quip={!r.note && !r.error} title={r.note ?? undefined}>
                    <span className="bubble-text">{r.error ? <span className="error">{r.error}</span> : said}</span>
                  </div>
                  <div className="facts">
                    {r.effort && (
                      <span className={thin(r.effort) && r.status === 'done' && !isDocument(s.target) ? 'evidence thin' : 'evidence'}>
                        {r.effort.files} file{r.effort.files === 1 ? '' : 's'} read · {r.effort.tools} tool call{r.effort.tools === 1 ? '' : 's'}
                        {thin(r.effort) && r.status === 'done' && !isDocument(s.target) ? ' — too little to trust' : ''}
                      </span>
                    )}
                    {r.found && (
                      <span className="found">
                        <b>
                          {r.found.total} finding{r.found.total === 1 ? '' : 's'}
                        </b>
                        {r.found.serious > 0 ? `, ${r.found.serious} serious` : ''}
                        {rec ? ` · says ${SAYS[rec]}` : ''}
                      </span>
                    )}
                    {!r.found && rec && <span className="found">Says {SAYS[rec]}</span>}
                  </div>
                  {onOpenSession && (
                    <button className="link" onClick={() => onOpenSession(r.sessionId)}>
                      {r.hasReport ? 'read its report' : 'read its working'}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        <Debate s={s} />

        {s.phase === 'done' && (
          <div className={`theatre-verdict ${s.verdict ? VERDICT[s.verdict].cls : ''}`}>
            <div>
              <span className="muted small">The verdict</span>
              <b>{s.verdict ? VERDICT[s.verdict].text : 'Delivered'}</b>
              <span className="small">
                {s.findings ? `${shown.length} finding${shown.length === 1 ? '' : 's'}${serious ? `, ${serious} serious` : ''}` : 'No findings list could be read from it'}
                {s.findings?.some((f) => !f.shown) ? ` · ${s.findings.filter((f) => !f.shown).length} held back` : ''}
                {s.stopped ? ` · partial: ${s.stopped}` : ''}
              </span>
            </div>
            <button className="btn primary" onClick={() => (onOpenSession ? onOpenSession(s.sessionId) : onClose())}>
              Read the full verdict
            </button>
          </div>
        )}

        {s.phase === 'error' && s.resumable && (
          <PickUp
            key={s.id}
            s={s}
            models={models}
            onResumed={(next) => {
              setS(next)
              onUpdate(next)
            }}
          />
        )}
        {s.phase === 'error' && s.resumedBy && <p className="muted small theatre-hint">This run was picked up again; the new one carries on from it.</p>}

        <div className="theatre-foot">
          <span className="muted small">
            Chief Inspector {surname(s.primaryModel)} presiding · {clock(elapsed)} · {s.focus.length} area{s.focus.length === 1 ? '' : 's'}
          </span>
          <span className="grow" />
          {s.phase === 'error' && onOpenSession && (
            <button className="btn" onClick={() => onOpenSession(s.sessionId)} title="The chat this review was started from says why there is no verdict and where the reviewers' reports are">
              Open the chat
            </button>
          )}
          {running && (
            <>
              <button className="btn" onClick={onClose} title="Close this window. The review carries on, and the QA Hound button in the top bar shows how it is going.">
                Keep working
              </button>
              <button className="btn danger" disabled={stopping || !!s.stopAsked} onClick={() => void stop()}>
                {stopping || s.stopAsked ? 'Stopping…' : 'Stop'}
              </button>
            </>
          )}
        </div>
        {running && <p className="muted small theatre-hint">Close this any time: the review carries on, the QA Hound button in the top bar shows progress, and the verdict arrives in the chat.</p>}

        {s.pr || s.prError ? (
          <div className="theatre-findings small">
            {s.pr && (
              <a href={s.pr.url} target="_blank" rel="noreferrer">
                {s.pr.event === 'APPROVE' ? 'Approved' : s.pr.event === 'REQUEST_CHANGES' ? 'Changes requested' : 'Commented'} on PR #{s.pr.number}
              </a>
            )}
            {s.prError && <span className="error">PR not posted: {s.prError}</span>}
          </div>
        ) : null}
        {s.checks && s.checks.length > 0 && (
          <div className="theatre-checks small">
            <b>What BitBull checked itself</b>
            <ul>
              {s.checks.map((c) => (
                <li key={c.id} className={c.ok ? 'ok' : 'bad'}>
                  <span aria-hidden="true">{c.ok ? '✓' : '✗'}</span> {c.text.replace(/`/g, '')}
                </li>
              ))}
            </ul>
            {s.options.pr && s.options.prApprove && s.checks.some((c) => !c.ok) && <span className="muted">Not all passed, so the pull request was not approved.</span>}
          </div>
        )}
        {s.log && s.log.length > 0 && (
          <details className="theatre-log" open={s.phase === 'error' || s.log.some((l) => l.level !== 'info')}>
            <summary>
              What happened{' '}
              <span className="muted small">
                {s.log.length} line{s.log.length === 1 ? '' : 's'}
                {s.log.some((l) => l.level === 'warn') ? ` · ${s.log.filter((l) => l.level === 'warn').length} retried` : ''}
                {s.resumedFrom ? ' · picked up from an earlier run' : ''}
              </span>
            </summary>
            <ol>
              {s.log.map((l, i) => (
                <li key={i} className={l.level}>
                  <span className="mono">{hhmmss(l.at)}</span>
                  <span>{l.text}</span>
                </li>
              ))}
            </ol>
            <span className="muted small">The same lines are in the Activity log, with the engines’ own messages around them.</span>
          </details>
        )}
        <RoomsPanel s={s as Swarm & SwarmRooms} />
      </div>
    </div>
  )
}
