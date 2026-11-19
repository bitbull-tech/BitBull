import { useEffect, useMemo, useState } from 'react'
import { api, type HoundBench, type Model, type PoundConfig, type PoundJob, type PoundRole, type Project } from './api'
import { ModelDog } from './dogs'
import { IconX } from './icons'
import { makerOf, priceLabel } from './ModelPicker'
import alphaFull from './assets/pound/alpha.webp'
import alphaHead from './assets/pound/alpha-head.webp'
import coderFull from './assets/pound/coder.webp'
import coderHead from './assets/pound/coder-head.webp'
import reviewerFull from './assets/pound/reviewer.webp'
import reviewerHead from './assets/pound/reviewer-head.webp'
import testerFull from './assets/pound/tester.webp'
import testerHead from './assets/pound/tester-head.webp'
import researcherFull from './assets/pound/researcher.webp'
import researcherHead from './assets/pound/researcher-head.webp'

/**
 * The Dog Pound: a project's team of dogs, each on the model you pick for the job. The costume
 * is the job (suit, hoodie, judge's robes, hi-vis, deerstalker); the small detective beside a
 * chosen model is that model's own dog, by its maker's collar colour, as everywhere else.
 */
export const POUND_ROLES: Array<{ id: PoundRole; label: string; does: string; head: string; full: string }> = [
  { id: 'alpha', label: 'Alpha Dog', does: 'Plans the work, hands it out and reports back to you. This is the chat you talk to.', head: alphaHead, full: alphaFull },
  { id: 'coder', label: 'Code Dog', does: 'Writes the change.', head: coderHead, full: coderFull },
  { id: 'reviewer', label: 'Review Dog', does: 'Scrutinises the change. Read-only: it can’t edit or run anything.', head: reviewerHead, full: reviewerFull },
  { id: 'tester', label: 'Test Dog', does: 'Writes and runs tests.', head: testerHead, full: testerFull },
  { id: 'researcher', label: 'Dig Dog', does: 'Digs through code, docs and the web. Read-only.', head: researcherHead, full: researcherFull },
]
const roleOf = (id: PoundRole) => POUND_ROLES.find((r) => r.id === id) ?? POUND_ROLES[0]

const EMPTY: PoundConfig = { enabled: false, models: { alpha: '', coder: '', reviewer: '', tester: '', researcher: '' }, separateChats: true, autoReview: true }

const cost = (m: Model) => (m.price ? m.price.input + m.price.output : 0)
/** The priciest model of a family: a rough stand-in for "its strongest", which the owner can change. */
const topOf = (models: Model[], family: Model['family'], not: string[] = []) =>
  models.filter((m) => m.family === family && m.tools !== false && !not.includes(m.id)).sort((a, b) => cost(b) - cost(a))[0]?.id ?? ''

/** One click: a different maker for planning, coding and reviewing, so they don't share blind spots. */
export function mixedPreset(models: Model[], fallback: string): PoundConfig['models'] {
  const a = topOf(models, 'anthropic') || fallback
  const o = topOf(models, 'openai') || fallback
  const g = topOf(models, 'google') || topOf(models, 'openai', [o]) || fallback
  return { alpha: a, coder: o, reviewer: g, tester: o, researcher: g }
}

function ModelSelect({ models, value, onChange, none }: { models: Model[]; value: string; onChange: (id: string) => void; none: string }) {
  const groups = useMemo(() => {
    const by = new Map<string, Model[]>()
    for (const m of models) by.set(makerOf(m), [...(by.get(makerOf(m)) ?? []), m])
    return [...by.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
  }, [models])
  const known = !value || models.some((m) => m.id === value)
  return (
    <select className="pound-select" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{none}</option>
      {!known && <option value={value}>{value} (not on offer right now)</option>}
      {groups.map(([maker, list]) => (
        <optgroup key={maker} label={maker}>
          {list.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
              {m.gateway === 'ditto-router' ? ' · Ditto Router' : ''}
              {priceLabel(m) ? ` · ${priceLabel(m)}` : ''}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}

export function PoundDialog({
  project,
  models,
  defaultModel,
  startWith,
  onClose,
  onSaved,
}: {
  project: Project
  models: Model[]
  defaultModel: string
  /** open with the pound switched on and the mixed preset filled in (a new Dog Pound project) */
  startWith?: 'mixed'
  onClose: () => void
  onSaved: (p: PoundConfig) => void
}) {
  const [cfg, setCfg] = useState<PoundConfig | null>(null)
  const [bench, setBench] = useState<HoundBench | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void api
      .pound(project.id)
      .then((r) => setCfg(startWith === 'mixed' && !r.pound.enabled ? { ...r.pound, enabled: true, models: mixedPreset(models, defaultModel) } : r.pound))
      .catch(() => setCfg(startWith === 'mixed' ? { ...EMPTY, enabled: true, models: mixedPreset(models, defaultModel) } : EMPTY))
    void api.houndBench().then(setBench).catch(() => {})
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id])

  const infoOf = (id: string) => models.find((m) => m.id === id)
  const set = (role: PoundRole, id: string) => setCfg((c) => (c ? { ...c, models: { ...c.models, [role]: id } } : c))

  const save = async () => {
    if (!cfg) return
    setSaving(true)
    setError(null)
    try {
      const r = await api.savePound(project.id, cfg)
      onSaved(r.pound)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save')
    } finally {
      setSaving(false)
    }
  }

  const sameFamily = (() => {
    if (!cfg?.models.coder || !cfg.models.reviewer) return false
    const a = infoOf(cfg.models.coder)
    const b = infoOf(cfg.models.reviewer)
    return !!a && !!b && makerOf(a) === makerOf(b)
  })()
  const grade = (id: string) => bench?.results.find((r) => r.model === id)
  const working = cfg ? POUND_ROLES.filter((r) => r.id !== 'alpha' && cfg.models[r.id]).length : 0

  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal pound-modal" role="dialog" aria-label="Dog Pound">
        <header className="modal-head">
          <h2>
            Dog Pound <span className="muted pound-for">· {project.name}</span>
          </h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <IconX />
          </button>
        </header>
        {!cfg ? (
          <div className="modal-body">
            <p className="muted">Loading…</p>
          </div>
        ) : (
          <div className="modal-body pound-body">
            <p className="pound-lede">
              A team of dogs for this project, each on the model you choose for the job. You talk to the Alpha Dog; it hands tasks to the others and reports back.
              A different maker for coding and for reviewing catches more, because models from one maker tend to miss the same things.
            </p>
            <label className="int-row pound-on">
              <input type="checkbox" checked={cfg.enabled} onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })} />
              <div>
                <b>Use a Dog Pound in this project</b>
                <small>Off: chats here work as they always have. Nothing below applies.</small>
              </div>
            </label>

            <div className={`pound-rows ${cfg.enabled ? '' : 'off'}`}>
              <div className="pound-presets">
                <span className="muted small">Fill in:</span>
                <button type="button" className="btn sm" disabled={!cfg.enabled} onClick={() => setCfg({ ...cfg, models: mixedPreset(models, defaultModel) })} title="A different maker for planning, coding and reviewing">
                  Mixed makers
                </button>
                <button
                  type="button"
                  className="btn sm"
                  disabled={!cfg.enabled}
                  onClick={() => {
                    const m = cfg.models.alpha || defaultModel
                    setCfg({ ...cfg, models: { alpha: m, coder: m, reviewer: m, tester: m, researcher: m } })
                  }}
                  title="Every dog on the Alpha Dog's model"
                >
                  All on one model
                </button>
                <button type="button" className="btn sm" disabled={!cfg.enabled} onClick={() => setCfg({ ...cfg, models: { ...EMPTY.models } })}>
                  Clear
                </button>
              </div>
              {POUND_ROLES.map((r) => {
                const id = cfg.models[r.id]
                const g = r.id === 'reviewer' && id ? grade(id) : undefined
                return (
                  <div key={r.id} className={`pound-row ${id || r.id === 'alpha' ? '' : 'out'}`}>
                    <img className="pound-head" src={r.head} width={64} height={64} alt="" draggable={false} />
                    <div className="pound-who">
                      <b>{r.label}</b>
                      <small>{r.does}</small>
                    </div>
                    <div className="pound-pick">
                      <div className="pound-pick-line">
                        {id ? <ModelDog id={id} family={infoOf(id)?.family} size={22} /> : <span className="pound-nodog" />}
                        <ModelSelect models={models} value={id} onChange={(v) => set(r.id, v)} none={r.id === 'alpha' ? 'Whatever model the chat is on' : 'Not in this pound'} />
                      </div>
                      {g && (
                        <small className={g.grade ? 'pound-ok' : 'pound-warn'}>
                          QA Hound benchmark: {g.error ? 'did not finish' : `${g.caught} of ${g.total} found, ${g.falseAlarms} false alarm${g.falseAlarms === 1 ? '' : 's'}`}
                          {g.grade ? ' (passed)' : ' (not passed)'}
                        </small>
                      )}
                      {r.id === 'reviewer' && sameFamily && <small className="pound-warn">Same maker as the Code Dog: they tend to miss the same things. A different maker reviews better.</small>}
                      {r.id === 'alpha' && id && <small className="muted">New chats in this project start on this model.</small>}
                    </div>
                  </div>
                )
              })}

              <label className="int-row">
                <input type="checkbox" disabled={!cfg.enabled} checked={cfg.autoReview} onChange={(e) => setCfg({ ...cfg, autoReview: e.target.checked })} />
                <div>
                  <b>Review every Code Dog’s work</b>
                  <small>BitBull itself sends each piece of the Code Dog’s work to the Review Dog before it goes back to the Alpha Dog, so the review can’t be skipped. Needs a Review Dog.</small>
                </div>
              </label>
              <label className="int-row">
                <input type="checkbox" disabled={!cfg.enabled} checked={cfg.separateChats} onChange={(e) => setCfg({ ...cfg, separateChats: e.target.checked })} />
                <div>
                  <b>Each dog works in a chat of its own</b>
                  <small>On: every task shows in the sidebar as “Code Dog · …”, so you can watch it work. Off: you only see the Alpha Dog’s chat; the others’ work is kept in the Archive.</small>
                </div>
              </label>
              {cfg.enabled && !working && <p className="pound-warn small">No dog has a model yet, so the Alpha Dog has nobody to hand work to.</p>}
              <p className="muted small">
                Each dog is a model run of its own and costs what that model costs; a coding task with a review is two runs. The dogs work in this project’s workspace
                with its usual limits, and stop when you stop the chat.
              </p>
            </div>
            {error && <p className="error">{error}</p>}
            <div className="form-actions">
              <span className="grow" />
              <button type="button" className="btn" onClick={onClose}>
                Cancel
              </button>
              <button type="button" className="btn primary" disabled={saving} onClick={() => void save()}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

const mins = (ms: number) => (ms < 90_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`)

/** Under the chat: which dogs this chat has put to work, on which model, and what they cost. */
export function PoundStrip({ sessionId, busy, onOpen }: { sessionId: string; busy: boolean; onOpen?: (sessionId: string) => void }) {
  const [jobs, setJobs] = useState<PoundJob[]>([])
  const [open, setOpen] = useState(true)
  const anyRunning = jobs.some((j) => !j.finishedAt)
  useEffect(() => {
    let dead = false
    const load = () =>
      void api
        .poundJobs(sessionId)
        .then((r) => !dead && setJobs(r.jobs))
        .catch(() => {})
    load()
    if (!busy && !anyRunning) return () => void (dead = true)
    const t = setInterval(load, 3000)
    return () => {
      dead = true
      clearInterval(t)
    }
  }, [sessionId, busy, anyRunning])
  if (!jobs.length) return null
  const runs = jobs.flatMap((j) => j.runs.map((r) => ({ ...r, task: j.task, key: `${j.id}-${r.sessionId}` })))
  const total = runs.reduce((n, r) => n + r.costUsd, 0)
  const at = runs.filter((r) => r.status === 'running')
  return (
    <div className="pound-strip" role="region" aria-label="Dog Pound">
      <button type="button" className="pound-strip-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <b>Dog Pound</b>
        <span className="muted">
          {at.length ? `${at.map((r) => r.label).join(', ')} working` : `${runs.length} task${runs.length === 1 ? '' : 's'} done`}
          {total > 0 ? ` · $${total.toFixed(total < 0.1 ? 3 : 2)}` : ''}
        </span>
        <span className="grow" />
        <span className="muted small">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className="pound-strip-list">
          {runs.map((r) => (
            <button type="button" key={r.key} className={`pound-run ${r.status}`} onClick={() => onOpen?.(r.sessionId)} title={`${r.task}\n\nOpen this dog’s chat`}>
              <img src={roleOf(r.role).head} width={30} height={30} alt="" draggable={false} />
              <span className="pound-run-text">
                <b>{r.label}</b>
                <small>
                  <ModelDog id={r.model} size={13} /> <span>{r.model}</span>
                </small>
              </span>
              <span className="pound-run-state">
                <span className="pound-run-word">
                  {r.status === 'running' ? <span className="pound-dot" /> : null}
                  {r.status === 'running' ? 'working' : r.status === 'done' ? 'done' : r.status === 'stopped' ? 'stopped' : 'failed'}
                </span>
                <small>
                  {mins(r.ms)}
                  {r.costUsd > 0 ? ` · $${r.costUsd.toFixed(r.costUsd < 0.1 ? 3 : 2)}` : ''}
                </small>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
