import { useEffect, useMemo, useState } from 'react'
import { api, type Model, type UsageReport } from './api'
import { IconX } from './icons'

/**
 * Usage: estimated spending per day and per model, from the cost BitBull records with every
 * reply (server/src/usage.ts). The SayGM balance needs SayGM's account access (Sign in with
 * SayGM), so it is shown as coming. SayGM's own usage page is the bill.
 */
const RANGES = [7, 30, 90] as const
const usd = (n: number) => (n === 0 ? '$0' : n < 0.01 ? '<$0.01' : n < 100 ? `$${n.toFixed(2)}` : `$${Math.round(n).toLocaleString()}`)
const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n))
const dayLabel = (d: string, opts: Intl.DateTimeFormatOptions) => new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', ...opts })

/** A round axis maximum and three gridlines, so the scale reads at a glance. */
function niceMax(v: number) {
  if (v <= 0) return 1
  const p = 10 ** Math.floor(Math.log10(v))
  const n = v / p
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p
}

function DailyChart({ report, names }: { report: UsageReport; names: Map<string, string> }) {
  const [hover, setHover] = useState<number | null>(null)
  const W = 720
  const H = 200
  const pad = { l: 46, r: 8, t: 10, b: 24 }
  const days = report.byDay
  const max = niceMax(Math.max(...days.map((d) => d.cost)))
  const slot = (W - pad.l - pad.r) / days.length
  const bw = Math.max(2, Math.min(28, slot - 2)) // a 2px gap between bars, never wider than 28
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max)
  const base = H - pad.b
  const ticks = [0, max / 2, max]
  const labelEvery = Math.ceil(days.length / 8)
  const h = hover !== null ? days[hover] : null
  return (
    <div className="usage-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Estimated spend per day, ${report.from} to ${report.to}`} onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line className="usage-grid" x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} />
            <text className="usage-axis" x={pad.l - 6} y={y(t) + 4} textAnchor="end">
              {usd(t)}
            </text>
          </g>
        ))}
        {days.map((d, i) => {
          const x = pad.l + i * slot + (slot - bw) / 2
          const top = y(d.cost)
          const hgt = base - top
          const r = Math.min(4, bw / 2, hgt)
          return (
            <g key={d.date} onMouseEnter={() => setHover(i)}>
              {/* hit area: the whole column, bigger than the bar */}
              <rect x={pad.l + i * slot} y={pad.t} width={slot} height={base - pad.t} fill="transparent" />
              {hgt > 0.5 && (
                <path
                  className={`usage-bar ${hover === i ? 'on' : ''}`}
                  d={`M${x},${base} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${base} Z`}
                />
              )}
              {i % labelEvery === 0 && (
                <text className="usage-axis" x={x + bw / 2} y={H - 6} textAnchor="middle">
                  {dayLabel(d.date, { day: 'numeric', month: 'short' })}
                </text>
              )}
            </g>
          )
        })}
        <line className="usage-base" x1={pad.l} x2={W - pad.r} y1={base} y2={base} />
      </svg>
      {h && (
        <div
          className="usage-tip"
          style={(() => {
            // beside the bar, on whichever side has room, so it never runs off the chart
            const at = ((pad.l + (hover! + 0.5) * slot) / W) * 100
            return at > 60 ? { right: `${100 - at + 1.5}%` } : { left: `${at + 1.5}%` }
          })()}
        >
          <strong>{dayLabel(h.date, { weekday: 'short', day: 'numeric', month: 'short' })}</strong>
          <span>
            {usd(h.cost)} · {h.replies} {h.replies === 1 ? 'reply' : 'replies'}
          </span>
          {Object.entries(h.byModel)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 4)
            .map(([m, c]) => (
              <span key={m} className="muted">
                {names.get(m) ?? m}: {usd(c)}
              </span>
            ))}
        </div>
      )}
    </div>
  )
}

export function UsageDialog({ models, onClose }: { models: Model[]; onClose: () => void }) {
  const [days, setDays] = useState<(typeof RANGES)[number]>(30)
  const [report, setReport] = useState<UsageReport | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const names = useMemo(() => new Map(models.map((m) => [m.id, m.name])), [models])

  useEffect(() => {
    setErr(null)
    void api.usage(days).then(setReport, (e) => setErr(e instanceof Error ? e.message : String(e)))
  }, [days])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const active = report?.byDay.filter((d) => d.replies > 0).length ?? 0
  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal usage-modal" role="dialog" aria-label="Usage">
        <header className="modal-head">
          <h2>Usage</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <IconX />
          </button>
        </header>
        <div className="modal-body">
          <div className="usage-bar-row">
            <div className="usage-tabs" role="tablist" aria-label="Period">
              {RANGES.map((r) => (
                <button key={r} role="tab" aria-selected={days === r} className={days === r ? 'on' : ''} onClick={() => setDays(r)}>
                  {r} days
                </button>
              ))}
            </div>
            <span className="muted small">SayGM balance: shown here once Sign in with SayGM is available</span>
          </div>
          {err && <p className="lv-error-text">{err}</p>}
          {report && (
            <>
              <div className="usage-tiles">
                <div>
                  <span className="muted small">Spent, {days} days</span>
                  <strong>{usd(report.total.cost)}</strong>
                </div>
                <div>
                  <span className="muted small">Per active day</span>
                  <strong>{usd(active ? report.total.cost / active : 0)}</strong>
                </div>
                <div>
                  <span className="muted small">Replies</span>
                  <strong>{report.total.replies.toLocaleString()}</strong>
                </div>
                <div>
                  <span className="muted small">Tokens in / out</span>
                  <strong>
                    {tokens(report.total.inputTokens)} / {tokens(report.total.outputTokens)}
                  </strong>
                </div>
              </div>
              <h3>Per day</h3>
              {report.total.replies ? <DailyChart report={report} names={names} /> : <p className="muted">Nothing in this period yet.</p>}
              <h3>Per model</h3>
              {report.byModel.length ? (
                <div className="usage-table-wrap">
                  <table className="usage-table">
                    <thead>
                      <tr>
                        <th>Model</th>
                        <th>Replies</th>
                        <th>Tokens in / out</th>
                        <th>Spent</th>
                        <th>Share</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.byModel.map((m) => (
                        <tr key={m.model}>
                          <td>
                            {names.get(m.model) ?? m.model}
                            <code>{m.model}</code>
                          </td>
                          <td>{m.replies.toLocaleString()}</td>
                          <td>
                            {tokens(m.inputTokens)} / {tokens(m.outputTokens)}
                          </td>
                          <td>{usd(m.cost)}</td>
                          <td>{report.total.cost ? `${Math.round((m.cost / report.total.cost) * 100)}%` : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="muted">No replies in this period.</p>
              )}
              <p className="muted small">
                Estimates from SayGM's live prices when each reply was made{report.unpriced ? `; ${report.unpriced} replies had no price and count as $0` : ''}.
                Your SayGM usage page is the bill.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
