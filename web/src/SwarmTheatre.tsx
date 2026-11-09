import { useEffect, useState } from 'react'
import { api, type Swarm } from './api'
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
const quip = (model: string, phase: string) => QUIPS[hash(model + phase) % QUIPS.length]

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
  challenge: 'Cross-examination: each has read the other’s report and is trying to knock it down.',
  final: 'The Chief Inspector is weighing both files and writing the verdict.',
  done: 'Verdict delivered — it’s in the chat.',
  error: 'The investigation broke down.',
}

export function SwarmTheatre({
  swarm,
  onUpdate,
  onClose,
  onOpenSession,
}: {
  swarm: Swarm
  onUpdate: (s: Swarm | null) => void
  onClose: () => void
  onOpenSession?: (id: string) => void
}) {
  const [s, setS] = useState(swarm)
  useEffect(() => setS(swarm), [swarm])

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

  const cast = castFor(s.reviewers.map((r) => r.model))
  const elapsed = Math.round((Date.now() - s.startedAt) / 1000)
  const mins = Math.floor(elapsed / 60)

  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal theatre" role="dialog" aria-label="QA Hound progress">
        <header className="modal-head">
          <h2>The inquiry · {s.target}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <IconX />
          </button>
        </header>
        <p className="theatre-phase">{PHASE_LINE[s.phase]}</p>
        {s.options && (
          <div className="theatre-meter" title="Spend so far against the run's hard budget (the reviewers stop at 75%, the rest is for the verdict)">
            <div className="voice-meter">
              <i style={{ width: `${Math.min(100, (100 * (s.spentUsd ?? 0)) / s.options.budgetUsd)}%` }} />
            </div>
            <span className="muted small">
              ${(s.spentUsd ?? 0).toFixed(3)} of ${s.options.budgetUsd.toFixed(2)} · limit {s.options.maxMinutes} min
              {s.stopped ? ` · stopped: ${s.stopped}` : ''}
            </span>
          </div>
        )}

        <div className={`theatre-room phase-${s.phase}`}>
          {s.reviewers.map((r, slot) => {
            const busy = r.status === 'reviewing' || r.status === 'challenging'
            const verdict = r.status === 'done' ? 'pass' : r.status === 'error' ? 'fail' : undefined
            const said = r.error
              ? null
              : r.note ?? (busy ? quip(r.model, r.status) : r.status === 'done' ? 'Case closed.' : 'Awaiting the brief.')
            return (
              <div className="detective" key={r.sessionId}>
                <Detective n={cast[slot]} slot={slot} model={r.model} busy={busy} verdict={verdict} />
                <div className="bubble" data-quip={!r.note && !r.error}>
                  {r.error ? <span className="error">{r.error}</span> : said}
                </div>
                <div className="who">
                  <b className="persona">{persona(r.model)}</b>
                  <span className="model-id">{r.model}</span>
                  <span className="muted">{r.status}</span>
                  {r.effort && (
                    <span className={thin(r.effort) && r.status === 'done' ? 'evidence thin' : 'evidence'}>
                      {r.effort.files} file{r.effort.files === 1 ? '' : 's'} · {r.effort.tools} tool call{r.effort.tools === 1 ? '' : 's'}
                      {thin(r.effort) && r.status === 'done' ? ' — too little to trust' : ''}
                    </span>
                  )}
                  {onOpenSession && (
                    <button className="link" onClick={() => onOpenSession(r.sessionId)}>
                      read its working
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        <div className="theatre-foot">
          <span className="muted small">
            Chief Inspector {surname(s.primaryModel)} presiding · {mins ? `${mins}m ${elapsed % 60}s` : `${elapsed}s`} · {s.focus.length} area
            {s.focus.length === 1 ? '' : 's'}
          </span>
          {s.error && <span className="error small">{s.error}</span>}
        </div>
        {s.findings && (
          <div className="theatre-findings small">
            <b>{s.findings.filter((f) => f.shown).length} finding{s.findings.filter((f) => f.shown).length === 1 ? '' : 's'} shown</b>
            {s.findings.some((f) => !f.shown) && <span className="muted"> · {s.findings.filter((f) => !f.shown).length} held back</span>}
            {s.pr && (
              <>
                {' · '}
                <a href={s.pr.url} target="_blank" rel="noreferrer">
                  {s.pr.event === 'APPROVE' ? 'approved' : s.pr.event === 'REQUEST_CHANGES' ? 'changes requested' : 'commented'} on PR #{s.pr.number}
                </a>
              </>
            )}
            {s.prError && <span className="error"> · PR not posted: {s.prError}</span>}
          </div>
        )}
      </div>
    </div>
  )
}
