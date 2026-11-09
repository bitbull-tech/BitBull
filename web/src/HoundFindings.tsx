/**
 * QA Hound's findings, as the verdict's last block (```qa-hound … ```) arrives in the chat: a table
 * with severity and the handler's confidence score, findings under the thresholds the run used
 * folded away as "held back". The server keeps its own checked copy (server/src/hound.ts); this
 * only displays what the reply says, typed and capped like anything a model wrote.
 */
import { useState } from 'react'
import type { Severity } from './api'

const SEV: Severity[] = ['low', 'medium', 'high', 'critical']
const VERDICT: Record<string, string> = { use: 'Use as is', 'fix-first': 'Fix first', 'do-not-use': 'Do not use' }

interface Row {
  severity: Severity
  confidence: number
  path: string
  line?: number
  title: string
  fix?: string
  status?: string
  foundBy: string[]
}

const s = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : '')

/** null when the text isn't a complete findings block (still streaming, or malformed). */
export function parseHoundBlock(text: string): { verdict?: string; minSeverity: Severity; minConfidence: number; rows: Row[] } | null {
  let j: Record<string, unknown>
  try {
    j = JSON.parse(text)
  } catch {
    return null
  }
  if (!j || typeof j !== 'object' || !Array.isArray(j.findings)) return null
  const minSeverity = SEV.includes(j.minSeverity as Severity) ? (j.minSeverity as Severity) : 'low'
  const minConfidence = typeof j.minConfidence === 'number' ? Math.max(0, Math.min(100, j.minConfidence)) : 70
  const rows: Row[] = []
  for (const f of (j.findings as unknown[]).slice(0, 100)) {
    if (!f || typeof f !== 'object') continue
    const r = f as Record<string, unknown>
    const title = s(r.title, 200)
    if (!title) continue
    rows.push({
      severity: SEV.includes(String(r.severity).toLowerCase() as Severity) ? (String(r.severity).toLowerCase() as Severity) : 'low',
      confidence: typeof r.confidence === 'number' ? Math.max(0, Math.min(100, Math.round(r.confidence))) : 0,
      path: s(r.path, 300),
      line: typeof r.line === 'number' && r.line > 0 ? Math.floor(r.line) : undefined,
      title,
      fix: s(r.fix, 400) || undefined,
      status: s(r.status, 20) || undefined,
      foundBy: Array.isArray(r.foundBy) ? r.foundBy.map((x) => s(x, 60)).filter(Boolean).slice(0, 4) : [],
    })
  }
  rows.sort((a, b) => SEV.indexOf(b.severity) - SEV.indexOf(a.severity) || b.confidence - a.confidence)
  return { verdict: typeof j.verdict === 'string' ? j.verdict : undefined, minSeverity, minConfidence, rows }
}

export function HoundFindings({ text }: { text: string }) {
  const [showHeld, setShowHeld] = useState(false)
  const data = parseHoundBlock(text)
  if (!data) return null
  const passes = (r: Row) => SEV.indexOf(r.severity) >= SEV.indexOf(data.minSeverity) && r.confidence >= data.minConfidence
  const shown = data.rows.filter(passes)
  const held = data.rows.filter((r) => !passes(r))
  const table = (rows: Row[]) => (
    <table className="hound-table">
      <thead>
        <tr>
          <th>Severity</th>
          <th title="How sure the verdict is that it is real, after checking (0–100)">Confidence</th>
          <th>Where</th>
          <th>Finding</th>
          <th>Fix</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            <td>
              <span className={`sev sev-${r.severity}`}>{r.severity}</span>
            </td>
            <td>
              <span className="conf" title={r.status ? `${r.status}${r.foundBy.length ? ` · found by ${r.foundBy.join(', ')}` : ''}` : undefined}>
                <i style={{ width: `${r.confidence}%` }} />
                <b>{r.confidence}</b>
              </span>
            </td>
            <td>
              <code>
                {r.path}
                {r.line ? `:${r.line}` : ''}
              </code>
            </td>
            <td>{r.title}</td>
            <td className="muted">{r.fix}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
  return (
    <div className="hound-findings">
      <div className="hound-findings-head">
        <b>🐶 {data.verdict ? VERDICT[data.verdict] ?? data.verdict : 'Findings'}</b>
        <span className="muted small">
          {shown.length} shown · {held.length} held back (below {data.minSeverity} severity or {data.minConfidence}% confidence)
        </span>
      </div>
      {shown.length ? table(shown) : <p className="muted small">Nothing above the thresholds.</p>}
      {held.length > 0 && (
        <button className="linkish small" onClick={() => setShowHeld((v) => !v)}>
          {showHeld ? 'Hide' : 'Show'} the {held.length} held back
        </button>
      )}
      {showHeld && <div className="hound-held">{table(held)}</div>}
    </div>
  )
}
