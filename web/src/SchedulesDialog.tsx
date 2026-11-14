import { useEffect, useState } from 'react'
import { api, type Model, type Project, type Schedule, type ScheduleInput, type ScheduleSpec } from './api'
import { IconPlus, IconX } from './icons'

/**
 * Schedules (server/src/schedules.ts): prompts BitBull runs on its own at set times. Each one is
 * a dedicated agent with its own chat, where every run lands; in a project it works with that
 * project's files, instructions and TEAM.md. Runs are told nobody is watching, so anything that
 * publishes, sends, deletes or spends waits in the chat for your approval.
 */
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

type Draft = {
  id?: string
  name: string
  prompt: string
  projectId: string | null
  model: string
  mode: 'daily' | 'interval'
  time: string
  days: number[]
  every: number
  unit: 'minutes' | 'hours'
  telegram: boolean
}

const blank = (model: string, projectId: string | null): Draft => ({
  name: '',
  prompt: '',
  projectId,
  model,
  mode: 'daily',
  time: '08:00',
  days: [1, 2, 3, 4, 5],
  every: 2,
  unit: 'hours',
  telegram: false,
})

function fromSchedule(s: Schedule): Draft {
  const d = blank(s.model, s.projectId)
  const base = { ...d, id: s.id, name: s.name, prompt: s.prompt, telegram: s.telegram }
  if (s.spec.kind === 'daily') return { ...base, mode: 'daily', time: s.spec.time, days: s.spec.days }
  const m = s.spec.everyMinutes
  return { ...base, mode: 'interval', every: m % 60 === 0 ? m / 60 : m, unit: m % 60 === 0 ? 'hours' : 'minutes' }
}

function toInput(d: Draft): ScheduleInput {
  const spec: ScheduleSpec =
    d.mode === 'daily' ? { kind: 'daily', time: d.time, days: [...d.days].sort(), tz: TZ } : { kind: 'interval', everyMinutes: Math.round(d.every * (d.unit === 'hours' ? 60 : 1)) }
  return { name: d.name.trim(), prompt: d.prompt.trim(), projectId: d.projectId, model: d.model, spec, telegram: d.telegram }
}

const when = (ms: number | null) =>
  ms ? new Date(ms).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'

const STATUS: Record<string, string> = { running: 'Running now', done: 'Finished', error: 'Failed', aborted: 'Stopped', interrupted: 'Interrupted', skipped: 'Skipped' }

export function SchedulesDialog({
  projects,
  models,
  defaultModel,
  projectId,
  onClose,
  onOpenChat,
}: {
  projects: Project[]
  models: Model[]
  defaultModel: string
  projectId: string | null
  onClose: () => void
  onOpenChat: (sessionId: string) => void
}) {
  const [list, setList] = useState<Schedule[] | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** is a Telegram account paired (so results can be sent there) */
  const [paired, setPaired] = useState(false)

  const load = () =>
    void api
      .schedules()
      .then((r) => setList(r.schedules))
      .catch((e) => setMsg(e instanceof Error ? e.message : String(e)))
  useEffect(() => {
    load()
    void api.telegram().then((t) => setPaired(!!t.paired)).catch(() => {})
    const t = window.setInterval(load, 15_000)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => {
      window.clearInterval(t)
      window.removeEventListener('keydown', onKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true)
    setMsg(null)
    try {
      await fn()
      if (done) setMsg(done)
      load()
    } catch (e) {
      setMsg((e instanceof Error ? e.message : String(e)).replace(/^\d+ /, '').replace(/^\{"error":"(.*)"\}$/, '$1'))
    } finally {
      setBusy(false)
    }
  }

  const save = () => {
    if (!draft) return
    const input = toInput(draft)
    void act(async () => {
      if (draft.id) await api.updateSchedule(draft.id, input)
      else await api.createSchedule(input)
      setDraft(null)
    }, draft.id ? 'Saved' : 'Schedule created')
  }

  const valid = !!draft && draft.name.trim() && draft.prompt.trim() && (draft.mode === 'interval' ? draft.every * (draft.unit === 'hours' ? 60 : 1) >= 15 : draft.days.length > 0)

  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal sched-modal" role="dialog" aria-label="Schedules">
        <header className="modal-head">
          <h2>Schedules</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <IconX />
          </button>
        </header>
        <div className="modal-body">
          {!draft && (
            <>
              <p className="muted small">
                Prompts BitBull runs on its own, like a morning brief or a weekly review. Each schedule has its own chat where every run appears.
                Nobody is watching a run, so anything that publishes, sends, deletes or spends is left in that chat for you to approve. Runs only happen
                while BitBull is running; one that was missed runs when it starts again.
              </p>
              <div className="sched-list">
                {list?.length === 0 && <p className="muted">No schedules yet.</p>}
                {list?.map((s) => (
                  <div key={s.id} className={`sched-row ${s.enabled ? '' : 'off'}`}>
                    <div className="sched-main">
                      <strong>{s.name}</strong>
                      <span className="muted small">
                        {s.when}
                        {s.projectName ? ` · ${s.projectName}` : ''} · {s.model}
                        {s.telegram ? ' · results to Telegram' : ''}
                      </span>
                      <span className="small">
                        {s.enabled ? <>Next: {when(s.nextRunAt)}</> : 'Paused'}
                        {s.lastRunAt && (
                          <>
                            {' '}
                            · Last: {when(s.lastRunAt)}, {STATUS[s.lastStatus ?? ''] ?? s.lastStatus}
                          </>
                        )}
                      </span>
                      {s.lastNote && <span className="small lv-error-text">{s.lastNote}</span>}
                    </div>
                    <div className="sched-actions">
                      <label className="switch" title={s.enabled ? 'On: runs at its times' : 'Paused'}>
                        <input type="checkbox" checked={s.enabled} disabled={busy} onChange={(e) => void act(() => api.updateSchedule(s.id, { enabled: e.target.checked }))} />
                        <span>{s.enabled ? 'On' : 'Off'}</span>
                      </label>
                      <button className="btn sm" disabled={busy} onClick={() => void act(() => api.runSchedule(s.id), `${s.name} started`)}>
                        Run now
                      </button>
                      {s.sessionId && (
                        <button className="btn sm" onClick={() => onOpenChat(s.sessionId!)}>
                          Open chat
                        </button>
                      )}
                      <button className="btn sm" onClick={() => setDraft(fromSchedule(s))}>
                        Edit
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <button className="btn" onClick={() => setDraft(blank(defaultModel, projectId))}>
                <IconPlus size={14} /> New schedule
              </button>
            </>
          )}

          {draft && (
            <form
              className="sched-form"
              onSubmit={(e) => {
                e.preventDefault()
                if (valid) save()
              }}
            >
              <label>
                Name
                <input value={draft.name} maxLength={80} placeholder="Morning brief" onChange={(e) => setDraft({ ...draft, name: e.target.value })} autoFocus />
              </label>
              <label>
                What should it do?
                <textarea
                  rows={6}
                  value={draft.prompt}
                  maxLength={8000}
                  placeholder="Check my open GitHub pull requests and the Taostats numbers for subnet 59, and summarise what changed since the last run."
                  onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
                />
              </label>
              <div className="sched-when">
                <label>
                  When
                  <select value={draft.mode} onChange={(e) => setDraft({ ...draft, mode: e.target.value as Draft['mode'] })}>
                    <option value="daily">At a time of day</option>
                    <option value="interval">Every so often</option>
                  </select>
                </label>
                {draft.mode === 'daily' ? (
                  <>
                    <label>
                      Time
                      <input type="time" value={draft.time} onChange={(e) => setDraft({ ...draft, time: e.target.value })} />
                    </label>
                    <fieldset className="sched-days">
                      <legend>On</legend>
                      {DAYS.map((d, i) => (
                        <label key={d} className={draft.days.includes(i) ? 'on' : ''}>
                          <input
                            type="checkbox"
                            checked={draft.days.includes(i)}
                            onChange={(e) => setDraft({ ...draft, days: e.target.checked ? [...draft.days, i] : draft.days.filter((x) => x !== i) })}
                          />
                          {d}
                        </label>
                      ))}
                    </fieldset>
                  </>
                ) : (
                  <label>
                    Every
                    <span className="sched-every">
                      <input type="number" min={1} max={draft.unit === 'hours' ? 168 : 10080} value={draft.every} onChange={(e) => setDraft({ ...draft, every: Number(e.target.value) })} />
                      <select value={draft.unit} onChange={(e) => setDraft({ ...draft, unit: e.target.value as Draft['unit'] })}>
                        <option value="hours">hours</option>
                        <option value="minutes">minutes</option>
                      </select>
                    </span>
                  </label>
                )}
              </div>
              {draft.mode === 'daily' && <p className="muted small">Times are in your timezone ({TZ}).</p>}
              {draft.mode === 'interval' && draft.every * (draft.unit === 'hours' ? 60 : 1) < 15 && <p className="small lv-error-text">At least every 15 minutes.</p>}
              <div className="sched-when">
                <label>
                  Project
                  <select value={draft.projectId ?? ''} onChange={(e) => setDraft({ ...draft, projectId: e.target.value || null })}>
                    <option value="">None (general)</option>
                    {projects.filter((p) => !p.archived_at).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Model
                  <select value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })}>
                    {!models.some((m) => m.id === draft.model) && <option value={draft.model}>{draft.model}</option>}
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className={`sched-check ${paired ? '' : 'off'}`}>
                <input type="checkbox" checked={draft.telegram && paired} disabled={!paired} onChange={(e) => setDraft({ ...draft, telegram: e.target.checked })} />
                <span>
                  Send each result to my Telegram
                  {!paired && <span className="muted small"> (pair your Telegram under Settings → Integrations first)</span>}
                </span>
              </label>
              <p className="muted small">
                A cheap, fast model is usually enough for routine runs; each run's cost shows in its chat and under Usage. In a project with a TEAM.md,
                the run is done by that team.
              </p>
              <div className="row-actions">
                <button className="btn" type="submit" disabled={!valid || busy}>
                  {draft.id ? 'Save' : 'Create schedule'}
                </button>
                <button className="btn" type="button" onClick={() => setDraft(null)}>
                  Cancel
                </button>
                {draft.id && (
                  <button
                    className="btn danger"
                    type="button"
                    disabled={busy}
                    onClick={() => void act(async () => (await api.deleteSchedule(draft.id!), setDraft(null)), 'Deleted. Its chat is kept.')}
                  >
                    Delete
                  </button>
                )}
              </div>
            </form>
          )}
          {msg && <p className="small sched-msg">{msg}</p>}
        </div>
      </div>
    </div>
  )
}
