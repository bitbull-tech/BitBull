import { useEffect, useMemo, useState } from 'react'
import { api, type Model, type ModelDetail } from './api'
import { IconSearch, IconX } from './icons'
import { ModelDog } from './dogs'

/**
 * Everything SayGM publishes about a model, without going to SayGM: one sortable table of
 * the whole catalogue, and the gateway's own record for whichever row you select.
 * Opened from the model picker ("See all models") via a bitbull:browse-models event.
 */

const money = (n?: number) => (typeof n === 'number' ? (n >= 10 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`) : '—')
const ctx = (n?: number) => (typeof n === 'number' ? (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)) : '—')
const API_LABEL: Record<Model['api'], string> = { anthropic: 'Messages', responses: 'Responses', google: 'generateContent', chat: 'chat.completions' }

type Key = 'name' | 'provider' | 'api' | 'contextLength' | 'in' | 'out' | 'savingsPct'
const COLS: { key: Key; label: string; num?: boolean; title?: string }[] = [
  { key: 'name', label: 'Model' },
  { key: 'provider', label: 'Maker' },
  { key: 'api', label: 'API', title: "The native API SayGM serves it on — richer tool calling than chat.completions" },
  { key: 'contextLength', label: 'Context', num: true },
  { key: 'in', label: 'In', num: true, title: 'USD per million input tokens' },
  { key: 'out', label: 'Out', num: true, title: 'USD per million output tokens' },
  { key: 'savingsPct', label: 'Saving', num: true, title: 'Below list price, blended 3:1 input:output' },
]

const valueOf = (m: Model, k: Key): string | number => {
  switch (k) {
    case 'in':
      return m.price?.input ?? Infinity
    case 'out':
      return m.price?.output ?? Infinity
    case 'contextLength':
      return m.contextLength ?? -1
    case 'savingsPct':
      return m.savingsPct ?? -1
    case 'provider':
      return m.provider ?? ''
    default:
      return m[k] ?? ''
  }
}

export function ModelsDialog({ models, current, onPick, onClose }: { models: Model[]; current?: string; onPick?: (id: string) => void; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<{ key: Key; dir: 1 | -1 }>({ key: 'name', dir: 1 })
  const [only, setOnly] = useState<{ tools: boolean; vision: boolean; tee: boolean }>({ tools: false, vision: false, tee: false })
  const [sel, setSel] = useState<string | null>(current ?? null)
  const [detail, setDetail] = useState<ModelDetail | null>(null)
  const [detailErr, setDetailErr] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (!sel) return
    let gone = false
    setDetail(null)
    setDetailErr(null)
    void api
      .model(sel)
      .then((r) => !gone && setDetail(r.model))
      .catch((e) => !gone && setDetailErr(e instanceof Error ? e.message : String(e)))
    return () => {
      gone = true
    }
  }, [sel])

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const list = models.filter((m) => {
      if (only.tools && !m.tools) return false
      if (only.vision && !m.vision) return false
      if (only.tee && !m.confidential) return false
      if (!needle) return true
      return `${m.id} ${m.name} ${m.provider ?? ''} ${m.family} ${m.tier ?? ''}`.toLowerCase().includes(needle)
    })
    return list.sort((a, b) => {
      const x = valueOf(a, sort.key)
      const y = valueOf(b, sort.key)
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))
      return c * sort.dir
    })
  }, [models, q, only, sort])

  const picked = detail ?? models.find((m) => m.id === sel) ?? null

  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal models-modal" role="dialog" aria-label="Models">
        <header className="modal-head">
          <h2>Models · {models.length} on SayGM</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <IconX />
          </button>
        </header>
        <div className="models-bar">
          <label className="models-search">
            <IconSearch size={15} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, id, maker, tier…" />
          </label>
          <div className="models-filters">
            <label className="check">
              <input type="checkbox" checked={only.tools} onChange={(e) => setOnly((o) => ({ ...o, tools: e.target.checked }))} /> Tools
            </label>
            <label className="check">
              <input type="checkbox" checked={only.vision} onChange={(e) => setOnly((o) => ({ ...o, vision: e.target.checked }))} /> Vision
            </label>
            <label className="check" title="Runs in a trusted execution environment: private inference">
              <input type="checkbox" checked={only.tee} onChange={(e) => setOnly((o) => ({ ...o, tee: e.target.checked }))} /> TEE
            </label>
          </div>
        </div>
        <div className="models-body">
          <div className="models-table-wrap">
            <table className="models-table">
              <thead>
                <tr>
                  {COLS.map((c) => (
                    <th
                      key={c.key}
                      title={c.title}
                      className={`${c.num ? 'num' : ''} ${sort.key === c.key ? 'sorted' : ''}`}
                      onClick={() => setSort((s) => ({ key: c.key, dir: s.key === c.key ? ((s.dir * -1) as 1 | -1) : 1 }))}
                    >
                      {c.label}
                      {sort.key === c.key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => (
                  <tr key={m.id} className={`${m.id === sel ? 'sel' : ''} ${m.id === current ? 'cur' : ''}`} onClick={() => setSel(m.id)}>
                    <td>
                      <ModelDog id={m.id} family={m.family} size={22} /> {m.name}
                      <div className="models-id">{m.id}</div>
                    </td>
                    <td>{m.provider ?? '—'}</td>
                    <td>{API_LABEL[m.api]}</td>
                    <td className="num">{ctx(m.contextLength)}</td>
                    <td className="num">{money(m.price?.input)}</td>
                    <td className="num">{money(m.price?.output)}</td>
                    <td className="num">{m.savingsPct ? `−${m.savingsPct}%` : '—'}</td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr>
                    <td colSpan={COLS.length} className="muted">
                      Nothing matches those filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <aside className="models-detail">
            {!picked ? (
              <p className="muted small">Pick a model to see everything SayGM publishes about it.</p>
            ) : (
              <>
                <h3 className="models-detail-title">
                  <ModelDog id={picked.id} family={picked.family} size={40} /> {picked.name}
                </h3>
                <code className="models-id">{picked.id}</code>
                <dl>
                  <dt>Maker</dt>
                  <dd>{picked.provider ?? '—'}</dd>
                  <dt>Family</dt>
                  <dd>{picked.family}</dd>
                  <dt>API</dt>
                  <dd>{API_LABEL[picked.api]}</dd>
                  <dt>Tier</dt>
                  <dd>{picked.tier ?? '—'}</dd>
                  <dt>Context</dt>
                  <dd>{picked.contextLength ? picked.contextLength.toLocaleString() : '—'} tokens</dd>
                  <dt>Tools</dt>
                  <dd>{picked.tools ? 'yes' : 'no'}</dd>
                  <dt>Vision</dt>
                  <dd>{picked.vision ? 'yes' : 'no'}</dd>
                  <dt>Private (TEE)</dt>
                  <dd>{picked.confidential ? 'yes' : 'no'}</dd>
                  <dt>SayGM price</dt>
                  <dd>
                    {picked.price ? `${money(picked.price.input)} in / ${money(picked.price.output)} out per M` : '—'}
                    {picked.price?.cacheRead !== undefined ? ` · ${money(picked.price.cacheRead)} cache read` : ''}
                  </dd>
                  <dt>List price</dt>
                  <dd>{picked.retail ? `${money(picked.retail.input)} in / ${money(picked.retail.output)} out per M` : '—'}</dd>
                  <dt>Saving</dt>
                  <dd>{picked.savingsPct ? `−${picked.savingsPct}% blended` : '—'}</dd>
                </dl>
                {onPick && picked.id !== current && (
                  <button className="btn primary" onClick={() => onPick(picked.id)}>
                    Use this model in this chat
                  </button>
                )}
                <h4>From the gateway</h4>
                {detailErr ? (
                  <p className="error small">{detailErr}</p>
                ) : !detail ? (
                  <p className="muted small">Loading…</p>
                ) : detail.raw ? (
                  <pre className="models-raw">{JSON.stringify(detail.raw, null, 2)}</pre>
                ) : (
                  <p className="muted small">SayGM sent nothing beyond the fields above.</p>
                )}
              </>
            )}
          </aside>
        </div>
        <div className="modal-foot muted small">
          Prices are SayGM's live rates in USD per million tokens; the saving compares them with the maker's list price, blended 3:1 input:output.
        </div>
      </div>
    </div>
  )
}
