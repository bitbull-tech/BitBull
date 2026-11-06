import { useEffect, useState } from 'react'
import { api, type Swarm } from './api'
import { IconX } from './icons'

/**
 * What the swarm is doing, while it does it.
 *
 * The framing is a detective one because that is honestly what happens: two investigators work
 * the case separately, then cross-examine each other, then the handler delivers a verdict. Each
 * reviewer gets a sleuth assembled from a small kit of SVG parts, chosen deterministically from
 * a hash of the model id — so a model always looks like itself, nobody has to draw sixty
 * portraits, and no vendor's logo or trademark appears anywhere. Colours come from the existing
 * family tokens, so it themes itself in light and dark.
 */

/* ---------------- the kit ---------------- */

const HATS = ['deerstalker', 'bowler', 'top', 'none'] as const
const EYES = ['monocle', 'pince', 'round', 'none'] as const
const FACE = ['pipe', 'moustache', 'both', 'none'] as const
type Hat = (typeof HATS)[number]
type Eye = (typeof EYES)[number]
type Face = (typeof FACE)[number]

/** Stable per model id: the same model is always the same character. */
function hash(s: string) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h)
}
function look(model: string): { hat: Hat; eye: Eye; face: Face } {
  const h = hash(model)
  return { hat: HATS[h % HATS.length], eye: EYES[(h >> 3) % EYES.length], face: FACE[(h >> 6) % FACE.length] }
}
/** Family from the model id, for the colour only — the picker's own fam- tokens. */
function famOf(id: string) {
  if (/claude|anthropic/i.test(id)) return 'anthropic'
  if (/^(gpt|o\d)/i.test(id)) return 'openai'
  if (/gemini|gemma/i.test(id)) return 'google'
  if (/qwen|glm|deepseek|kimi|mimo|llama|mistral|oss/i.test(id)) return 'open'
  return 'other'
}

function Sleuth({ model, busy, verdict }: { model: string; busy: boolean; verdict?: 'pass' | 'fail' }) {
  const { hat, eye, face } = look(model)
  const smoking = busy && (face === 'pipe' || face === 'both')
  return (
    <svg className={`sleuth fam-${famOf(model)} ${busy ? 'busy' : ''}`} viewBox="0 0 80 88" role="img" aria-label={`${model} reviewing`}>
      {/* shoulders */}
      <path className="ink" d="M14 86c0-13 11-20 26-20s26 7 26 20" />
      {/* head */}
      <circle className="ink head" cx="40" cy="40" r="20" />
      {hat === 'deerstalker' && (
        <g className="ink">
          <path d="M16 30c4-12 12-18 24-18s20 6 24 18z" />
          <path d="M10 30h60" />
          <path d="M18 24c-6 1-9 5-8 9M62 24c6 1 9 5 8 9" />
        </g>
      )}
      {hat === 'bowler' && (
        <g className="ink">
          <path d="M22 28c0-10 7-16 18-16s18 6 18 16z" />
          <path d="M14 28h52" />
        </g>
      )}
      {hat === 'top' && (
        <g className="ink">
          <path d="M26 28V8h28v20" />
          <path d="M16 28h48" />
        </g>
      )}
      {/* eyes */}
      <circle className="ink dot" cx="33" cy="40" r="1.6" />
      <circle className="ink dot" cx="47" cy="40" r="1.6" />
      {eye === 'monocle' && (
        <g className="ink">
          <circle cx="47" cy="40" r="7" />
          <path d="M53 45l5 9" />
        </g>
      )}
      {eye === 'pince' && (
        <g className="ink">
          <circle cx="33" cy="40" r="6" />
          <circle cx="47" cy="40" r="6" />
          <path d="M39 40h2" />
        </g>
      )}
      {eye === 'round' && (
        <g className="ink">
          <circle cx="32" cy="40" r="7" />
          <circle cx="48" cy="40" r="7" />
          <path d="M39 40h2M25 39l-6-2M55 39l6-2" />
        </g>
      )}
      {(face === 'moustache' || face === 'both') && <path className="ink" d="M32 50c3 3 13 3 16 0" />}
      {(face === 'pipe' || face === 'both') && (
        <g className="ink">
          <path d="M44 54c6 0 9 2 11 5" />
          <path d="M55 59c3 0 5-2 5-5" />
        </g>
      )}
      {smoking && (
        <g className="smoke">
          <circle cx="62" cy="50" r="2.4" />
          <circle cx="65" cy="44" r="3" />
          <circle cx="62" cy="37" r="3.6" />
        </g>
      )}
      {verdict && (
        <g className={`stamp ${verdict}`}>
          <circle cx="64" cy="76" r="11" />
          {verdict === 'pass' ? <path d="M58 76l4 4 8-9" /> : <path d="M59 71l10 10M69 71l-10 10" />}
        </g>
      )}
    </svg>
  )
}

/* ---------------- the room ---------------- */

const PHASE_LINE: Record<Swarm['phase'], string> = {
  review: 'Working the case separately. Neither has seen the other’s notes.',
  challenge: 'Cross-examination: each has read the other’s report and is trying to knock it down.',
  final: 'Your handler is weighing both and writing the verdict.',
  done: 'Verdict delivered — it’s in the chat.',
  error: 'The investigation broke down.',
}

export function SwarmTheatre({ swarm, onUpdate, onClose, onOpenSession }: { swarm: Swarm; onUpdate: (s: Swarm | null) => void; onClose: () => void; onOpenSession?: (id: string) => void }) {
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
            return (
              <div className="detective" key={r.sessionId}>
                <Sleuth model={r.model} busy={busy} verdict={verdict as 'pass' | 'fail' | undefined} />
                <div className="bubble" data-empty={!r.note && !r.error}>
                  {r.error ? <span className="error">{r.error}</span> : r.note ? r.note : busy ? 'Thinking…' : r.status === 'done' ? 'Case closed.' : 'Waiting to begin.'}
                </div>
                <div className="who">
                  <b>{r.model}</b>
                  <span className="muted">{r.status}</span>
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
            {mins ? `${mins}m ${elapsed % 60}s` : `${elapsed}s`} · {s.focus.length} area{s.focus.length === 1 ? '' : 's'} · handler {s.primaryModel}
          </span>
          {s.error && <span className="error small">{s.error}</span>}
        </div>
      </div>
    </div>
  )
}
