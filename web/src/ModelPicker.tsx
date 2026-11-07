import { useEffect, useMemo, useRef, useState } from 'react'
import type { Model } from './api'
import { IconCheck, IconChevron, IconEye, IconLock, IconSearch } from './icons'
import { ModelDog } from './dogs'

const FAMILY_LABEL: Record<Model['family'], string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  open: 'Open weights',
  other: 'Other',
}
const FAMILY_ORDER: Model['family'][] = ['anthropic', 'openai', 'google', 'open', 'other']
const API_LABEL: Record<Model['api'], string> = {
  anthropic: 'Messages API',
  responses: 'Responses API',
  google: 'Gemini API',
  chat: 'Chat API',
}

export const money = (n: number) => `$${n > 0 && n < 0.1 ? n.toFixed(3) : n.toFixed(2)}`

export function priceLabel(m?: Model) {
  if (!m?.price) return ''
  return `${money(m.price.input)} / ${money(m.price.output)}`
}

export function ModelPicker({
  models,
  value,
  onChange,
}: {
  models: Model[]
  value: string
  onChange: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [fam, setFam] = useState<Model['family'] | 'all'>('all')
  const [cursor, setCursor] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const current = models.find((m) => m.id === value)

  const filtered = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
    return models
      .filter((m) => fam === 'all' || m.family === fam)
      .filter((m) => {
        const hay = `${m.id} ${m.name} ${m.provider ?? ''} ${FAMILY_LABEL[m.family]}`.toLowerCase()
        return terms.every((t) => hay.includes(t))
      })
      .sort((a, b) => FAMILY_ORDER.indexOf(a.family) - FAMILY_ORDER.indexOf(b.family) || a.name.localeCompare(b.name))
  }, [models, q, fam])

  useEffect(() => {
    if (!open) return
    setCursor(Math.max(0, filtered.findIndex((m) => m.id === value)))
    setTimeout(() => inputRef.current?.focus(), 0)
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Keep the highlighted row visible by scrolling only the list (scrollIntoView would
  // also scroll the popover itself and hide the search box and tabs)
  useEffect(() => {
    const list = listRef.current
    const row = list?.querySelector<HTMLElement>(`[data-idx="${cursor}"]`)
    if (!list || !row) return
    const top = row.offsetTop // list is the offsetParent (position: relative)
    if (top < list.scrollTop) list.scrollTop = top - 28
    else if (top + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + row.offsetHeight - list.clientHeight + 6
  }, [cursor, open])

  const choose = (id: string) => {
    onChange(id)
    setOpen(false)
    setQ('')
  }

  const families = FAMILY_ORDER.filter((f) => models.some((m) => m.family === f))
  let lastFam: string | null = null

  return (
    <div className="mp" ref={rootRef}>
      <button className="mp-trigger" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}>
        <ModelDog id={current?.id ?? value} family={current?.family} size={20} />
        <span className="mp-name">{current?.name ?? value}</span>
        {current?.price && <span className="mp-price">{priceLabel(current)}</span>}
        <IconChevron size={14} />
      </button>
      {open && (
        <div className="mp-pop" role="dialog" aria-label="Choose a model">
          <div className="mp-search">
            <IconSearch size={15} />
            <input
              ref={inputRef}
              value={q}
              placeholder={`Search ${models.length} models…`}
              onChange={(e) => {
                setQ(e.target.value)
                setCursor(0)
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setCursor((c) => Math.min(filtered.length - 1, c + 1))
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setCursor((c) => Math.max(0, c - 1))
                } else if (e.key === 'Enter' && filtered[cursor]) {
                  e.preventDefault()
                  choose(filtered[cursor].id)
                } else if (e.key === 'Escape') setOpen(false)
              }}
            />
          </div>
          <div className="mp-tabs">
            {(['all', ...families] as const).map((f) => (
              <button key={f} className={fam === f ? 'on' : ''} onClick={() => setFam(f)}>
                {f === 'all' ? 'All' : FAMILY_LABEL[f]}
              </button>
            ))}
          </div>
          <div className="mp-list" ref={listRef} role="listbox">
            {filtered.map((m, i) => {
              const header = fam === 'all' && !q && m.family !== lastFam ? FAMILY_LABEL[m.family] : null
              lastFam = m.family
              return (
                <div key={m.id}>
                  {header && <div className="mp-group">{header}</div>}
                  <div
                    data-idx={i}
                    role="option"
                    aria-selected={m.id === value}
                    className={`mp-row ${i === cursor ? 'cur' : ''} ${m.id === value ? 'sel' : ''}`}
                    onMouseEnter={() => setCursor(i)}
                    onClick={() => choose(m.id)}
                  >
                    <ModelDog id={m.id} family={m.family} size={26} />
                    <div className="mp-main">
                      <div className="mp-title">
                        {m.name}
                        {m.id === value && <IconCheck size={14} />}
                      </div>
                      <div className="mp-sub">
                        <code>{m.id}</code>
                        <span className="tag">{API_LABEL[m.api]}</span>
                        {m.vision && (
                          <span className="tag" title="Accepts images">
                            <IconEye size={11} /> Vision
                          </span>
                        )}
                        {m.confidential && (
                          <span className="tag tee" title="Private inference in a trusted execution environment">
                            <IconLock size={11} /> TEE
                          </span>
                        )}
                        {m.tools && (
                          <span className="tag" title="Supports tool calling (the agent needs this)">
                            Tools
                          </span>
                        )}
                        {m.contextLength ? (
                          <span className="tag" title={`${m.contextLength.toLocaleString()} token context window`}>
                            {m.contextLength >= 1000 ? `${Math.round(m.contextLength / 1000)}k` : m.contextLength}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <div className="mp-cost">
                      {m.price ? (
                        <>
                          <div>{priceLabel(m)}</div>
                          <div className="mp-cost-sub">
                            per M tokens{m.savingsPct ? <b> · −{m.savingsPct}%</b> : null}
                          </div>
                        </>
                      ) : (
                        <div className="mp-cost-sub">—</div>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
            {!filtered.length && <div className="mp-empty">No models match “{q}”.</div>}
          </div>
          <div className="mp-foot">
            <span>Prices are SayGM's live in / out rates · −% is the saving against list price</span>
            <button
              className="link"
              onClick={() => {
                setOpen(false)
                window.dispatchEvent(new CustomEvent('bitbull:browse-models'))
              }}
            >
              See all models
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
