import { useEffect, useState, type CSSProperties } from 'react'
import { api, type Swarm } from './api'
import { IconX } from './icons'

/**
 * What the swarm is doing, while it does it.
 *
 * The framing is a detective one because that is honestly what happens: two investigators work
 * the case separately, then cross-examine each other, then the handler delivers a verdict.
 *
 * Each reviewer is a Victorian sleuth assembled from a kit — deerstalker (most often), bowler or
 * topper; monocle or spectacles; handlebar, walrus or mutton chops; a calabash pipe, a magnifying
 * glass, or both — chosen deterministically from a hash of the model id, so a model always looks
 * like itself and nobody has to draw sixty portraits. The coat is the model family's colour from
 * the existing --fam-* tokens. No vendor logo or wordmark appears anywhere: the persona is the
 * family name with a rank in front of it, which is ours to make up.
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

const HATS = ['deerstalker', 'deerstalker', 'deerstalker', 'bowler', 'topper'] as const
const CLOTH = [
  { base: '#7a5c3e', check: '#3d2b1c' }, // houndstooth brown
  { base: '#6b6a3f', check: '#3f3e22' }, // moss tweed
  { base: '#6f6a64', check: '#3b3734' }, // grey plaid
  { base: '#8a4e2e', check: '#4a2716' }, // chestnut
]
const SKIN = ['#f2d4b7', '#e3b48f', '#c98e66', '#8d5a3b']
const EYEWEAR = ['monocle', 'monocle', 'spectacles', 'none'] as const
const WHISKERS = ['handlebar', 'walrus', 'mutton', 'none'] as const
const PROPS = ['pipe', 'pipe', 'magnifier', 'both'] as const

function look(model: string) {
  const h = hash(model)
  return {
    hat: HATS[h % HATS.length],
    cloth: CLOTH[(h >>> 3) % CLOTH.length],
    skin: SKIN[(h >>> 6) % SKIN.length],
    eye: EYEWEAR[(h >>> 9) % EYEWEAR.length],
    whiskers: WHISKERS[(h >>> 12) % WHISKERS.length],
    prop: PROPS[(h >>> 15) % PROPS.length],
    id: h.toString(36),
  }
}

/** Family, for the coat colour only — the picker's own --fam-* tokens. */
function famOf(id: string) {
  if (/claude|anthropic/i.test(id)) return 'anthropic'
  if (/^(gpt|o\d)/i.test(id)) return 'openai'
  if (/gemini|gemma/i.test(id)) return 'google'
  if (/qwen|glm|deepseek|kimi|mimo|llama|mistral|oss/i.test(id)) return 'open'
  return 'other'
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

/* ---------------- the sleuth ---------------- */

function Sleuth({ model, busy, verdict }: { model: string; busy: boolean; verdict?: 'pass' | 'fail' }) {
  const k = look(model)
  const pid = `cloth-${k.id}`
  const pipe = k.prop === 'pipe' || k.prop === 'both'
  const glass = k.prop === 'magnifier' || k.prop === 'both'
  const style = { '--coat': `var(--fam-${famOf(model)}, #7a7a7a)` } as CSSProperties
  const hatBrim = 'M30 60c10 6 50 6 60 0-2 5-12 9-30 9s-28-4-30-9z'
  return (
    <svg className={`sleuth ${busy ? 'busy' : ''}`} style={style} viewBox="0 0 120 150" role="img" aria-label={persona(model)}>
      <defs>
        <pattern id={pid} width="6" height="6" patternUnits="userSpaceOnUse">
          <rect width="6" height="6" fill={k.cloth.base} />
          <path d="M0 0h3v3H0zM3 3h3v3H3z" fill={k.cloth.check} opacity=".55" />
        </pattern>
      </defs>

      {/* coat, Inverness cape, collar and cravat */}
      <path className="coat" d="M12 150c2-26 20-40 48-40s46 14 48 40z" />
      <path className="cape" d="M20 150c3-20 18-32 40-32s37 12 40 32z" />
      <path d="M50 110l10 16 10-16z" fill="#f4f1ea" />
      <path className="cravat" d="M56 112l4 7 4-7z" />

      {/* neck, ears, head */}
      <rect x="53" y="94" width="14" height="18" rx="4" fill={k.skin} />
      <ellipse cx="38" cy="72" rx="4" ry="6" fill={k.skin} />
      <ellipse cx="82" cy="72" rx="4" ry="6" fill={k.skin} />
      <ellipse cx="60" cy="72" rx="22" ry="25" fill={k.skin} />
      {k.whiskers === 'mutton' && (
        <g className="hair">
          <path d="M38 68c0 13 6 21 12 23l-2-15z" />
          <path d="M82 68c0 13-6 21-12 23l2-15z" />
        </g>
      )}

      {/* brows, eyes, nose, mouth */}
      <path className="line" d="M47 63h9M64 63h9" />
      <circle className="eye" cx="52" cy="70" r="2" />
      <circle className="eye" cx="68" cy="70" r="2" />
      <path className="line thin" d="M60 72c-1 5-2 7 1 8" />
      {(k.whiskers === 'none' || k.whiskers === 'mutton') && <path className="line thin" d="M54 86c3 2 9 2 12 0" />}
      {k.whiskers === 'handlebar' && (
        <path className="hair" d="M60 83c-4-3-11-3-15 1 3-1 6 0 8 1 3 1 5 0 7-2 2 2 4 3 7 2 2-1 5-2 8-1-4-4-11-4-15-1z" />
      )}
      {k.whiskers === 'walrus' && <path className="hair" d="M48 82c4-3 20-3 24 0 0 5-5 7-12 7s-12-2-12-7z" />}

      {/* eyewear */}
      {k.eye === 'monocle' && (
        <g>
          <circle className="glass" cx="68" cy="70" r="6.5" />
          <path className="chain" d="M74 74c4 8 2 18-4 30" />
        </g>
      )}
      {k.eye === 'spectacles' && (
        <g>
          <circle className="glass" cx="52" cy="70" r="6" />
          <circle className="glass" cx="68" cy="70" r="6" />
          <path className="line thin" d="M58 70h4" />
        </g>
      )}

      {/* headwear */}
      {k.hat === 'deerstalker' && (
        <g>
          <path className="hat" d="M36 60c0-22 11-34 24-34s24 12 24 34z" fill={`url(#${pid})`} />
          <path className="hat" d={hatBrim} fill={`url(#${pid})`} />
          <path className="seam" d="M60 27v33M45 36c4 8 4 16 3 24M75 36c-4 8-4 16-3 24" />
          {/* the ear flaps, tied up over the crown */}
          <path className="bow" d="M53 30c-4-6-1-10 7-6 8-4 11 0 7 6" />
        </g>
      )}
      {k.hat === 'bowler' && (
        <g>
          <path className="hat dark" d="M38 58c0-20 9-28 22-28s22 8 22 28z" />
          <path className="hat dark" d="M30 58c10 5 50 5 60 0-2 4-12 7-30 7s-28-3-30-7z" />
          <path className="band" d="M39 54h42" />
        </g>
      )}
      {k.hat === 'topper' && (
        <g>
          <path className="hat dark" d="M42 56V20c0-3 36-3 36 0v36z" />
          <path className="hat dark" d="M30 58c10 5 50 5 60 0-2 4-12 7-30 7s-28-3-30-7z" />
          <path className="band" d="M42 50h36" />
        </g>
      )}

      {/* a calabash pipe, smoking while it works */}
      {pipe && (
        <g>
          <path className="stem" d="M64 86c8 4 16 4 20-2" />
          <path className="bowl" d="M80 74h12l-2 12c-1 4-7 4-8 0z" />
          {busy && <ellipse className="ember" cx="86" cy="74" rx="5" ry="1.6" />}
        </g>
      )}
      {pipe && busy && (
        <g className="smoke">
          <circle cx="87" cy="67" r="3" />
          <circle cx="91" cy="59" r="3.8" />
          <circle cx="88" cy="50" r="4.6" />
        </g>
      )}

      {/* the magnifying glass, sweeping while it works */}
      {glass && (
        <g className={`magnifier ${busy ? 'sweep' : ''}`}>
          <path className="handle" d="M84 136l12-16" />
          <circle className="lens" cx="100" cy="112" r="10" />
        </g>
      )}

      {verdict && (
        <g className={`stamp ${verdict}`}>
          <circle cx="24" cy="128" r="13" />
          {verdict === 'pass' ? <path d="M17 128l5 5 9-10" /> : <path d="M18 122l12 12M30 122l-12 12" />}
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

  const elapsed = Math.round((Date.now() - s.startedAt) / 1000)
  const mins = Math.floor(elapsed / 60)

  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal theatre" role="dialog" aria-label="QA swarm progress">
        <header className="modal-head">
          <h2>The inquiry · {s.target}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <IconX />
          </button>
        </header>
        <p className="theatre-phase">{PHASE_LINE[s.phase]}</p>

        <div className={`theatre-room phase-${s.phase}`}>
          {s.reviewers.map((r) => {
            const busy = r.status === 'reviewing' || r.status === 'challenging'
            const verdict = r.status === 'done' ? 'pass' : r.status === 'error' ? 'fail' : undefined
            const said = r.error
              ? null
              : r.note ?? (busy ? quip(r.model, r.status) : r.status === 'done' ? 'Case closed.' : 'Awaiting the brief.')
            return (
              <div className="detective" key={r.sessionId}>
                <Sleuth model={r.model} busy={busy} verdict={verdict} />
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
      </div>
    </div>
  )
}
