import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type Model, type ModelUsage } from './api'
import { IconCheck, IconChevron, IconEye, IconLock, IconSearch } from './icons'
import { ModelDog } from './dogs'

const FAMILY_LABEL: Record<Model['family'], string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  open: 'Open weights',
  other: 'Other',
}
const API_LABEL: Record<Model['api'], string> = {
  anthropic: 'Messages API',
  responses: 'Responses API',
  google: 'Gemini API',
  chat: 'Chat API',
}

/** Who made a model: from its id first (SayGM's ids name the family), then the gateway's owner, then the family. */
const MAKER_BY_ID: [RegExp, string][] = [
  [/claude|anthropic/i, 'Anthropic'],
  [/\bgpt|openai|\bo[1-9]\b|codex/i, 'OpenAI'],
  [/gemini|gemma|google/i, 'Google'],
  [/deepseek/i, 'DeepSeek'],
  [/kimi|moonshot/i, 'Moonshot'],
  [/glm|z-ai|zhipu/i, 'Z.ai'],
  [/qwen|qwq/i, 'Qwen'],
  [/llama|meta/i, 'Meta'],
  [/mistral|devstral|codestral|magistral/i, 'Mistral'],
  [/grok|x-ai|xai/i, 'xAI'],
  [/minimax/i, 'MiniMax'],
  [/nemotron|nvidia/i, 'NVIDIA'],
  [/command|cohere/i, 'Cohere'],
  [/phi-|microsoft/i, 'Microsoft'],
  [/nova|amazon/i, 'Amazon'],
]
export function makerOf(m: Model): string {
  for (const [re, name] of MAKER_BY_ID) if (re.test(m.id)) return name
  const owner = (m.provider ?? '').trim()
  for (const [re, name] of MAKER_BY_ID) if (owner && re.test(owner)) return name
  if (owner && !/saygm|system|library/i.test(owner)) return owner.charAt(0).toUpperCase() + owner.slice(1)
  return FAMILY_LABEL[m.family]
}

/** Your usage per model (for response speed), fetched once per page and refreshed after a turn. */
let usageLoad: Promise<Map<string, ModelUsage>> | null = null
export function modelUsageMap(refresh = false) {
  if (!usageLoad || refresh)
    usageLoad = api
      .modelUsage()
      .then((r) => new Map(r.usage.map((u) => [u.id, u])))
      .catch(() => new Map())
  return usageLoad
}
const speedLabel = (u?: ModelUsage) => (u?.firstTokenSeconds !== undefined ? `${u.firstTokenSeconds < 10 ? u.firstTokenSeconds.toFixed(1) : Math.round(u.firstTokenSeconds)} s` : null)

const MAKERS_KEY = 'bitbull-mp-makers'
const savedMakers = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(MAKERS_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}
type SortBy = 'name' | 'price' | 'speed'

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
  // makers ticked (none = all), remembered per browser
  const [makers, setMakers] = useState<string[]>(savedMakers)
  const [sortBy, setSortBy] = useState<SortBy>('name')
  const [usage, setUsage] = useState<Map<string, ModelUsage>>(new Map())
  useEffect(() => {
    if (open) void modelUsageMap(true).then(setUsage)
  }, [open])
  const toggleMaker = (name: string) =>
    setMakers((cur) => {
      const next = cur.includes(name) ? cur.filter((x) => x !== name) : [...cur, name]
      try {
        localStorage.setItem(MAKERS_KEY, JSON.stringify(next))
      } catch {
        /* private window */
      }
      setCursor(0)
      return next
    })
  const [cursor, setCursor] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const current = models.find((m) => m.id === value)

  // makers present, most models first
  const makerCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const x of models) m.set(makerOf(x), (m.get(makerOf(x)) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }, [models])
  // a saved maker that isn't in this catalogue any more must not hide everything
  const activeMakers = makers.filter((x) => makerCounts.some(([n]) => n === x))

  const filtered = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
    const price = (m: Model) => (m.price ? m.price.input + m.price.output : Infinity)
    const speed = (m: Model) => usage.get(m.id)?.firstTokenSeconds ?? Infinity
    return models
      .filter((m) => !activeMakers.length || activeMakers.includes(makerOf(m)))
      .filter((m) => {
        const hay = `${m.id} ${m.name} ${m.provider ?? ''} ${makerOf(m)} ${FAMILY_LABEL[m.family]}`.toLowerCase()
        return terms.every((t) => hay.includes(t))
      })
      .sort((a, b) =>
        sortBy === 'price'
          ? price(a) - price(b) || a.name.localeCompare(b.name)
          : sortBy === 'speed'
            ? speed(a) - speed(b) || price(a) - price(b)
            : makerOf(a).localeCompare(makerOf(b)) || a.name.localeCompare(b.name),
      )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models, q, makers, makerCounts, sortBy, usage])

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

  let lastMaker: string | null = null

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
          <div className="mp-makers" role="group" aria-label="Filter by maker">
            {makerCounts.map(([name, n]) => (
              <label key={name} className={`mp-maker ${activeMakers.includes(name) ? 'on' : ''}`}>
                <input type="checkbox" checked={activeMakers.includes(name)} onChange={() => toggleMaker(name)} />
                {name}
                <span className="mp-count">{n}</span>
              </label>
            ))}
            {activeMakers.length > 0 && (
              <button
                className="link small"
                onClick={() => {
                  setMakers([])
                  try {
                    localStorage.removeItem(MAKERS_KEY)
                  } catch {
                    /* private window */
                  }
                }}
              >
                All makers
              </button>
            )}
          </div>
          <div className="mp-sort">
            <span className="muted">Sort</span>
            <div className="seg mini">
              {(
                [
                  ['name', 'Maker'],
                  ['price', 'Cheapest'],
                  ['speed', 'Fastest'],
                ] as const
              ).map(([k, label]) => (
                <button key={k} className={sortBy === k ? 'on' : ''} onClick={() => (setSortBy(k), setCursor(0))}>
                  {label}
                </button>
              ))}
            </div>
            <span className="grow" />
            <span className="muted small">{filtered.length} shown</span>
          </div>
          <div className="mp-list" ref={listRef} role="listbox">
            {filtered.map((m, i) => {
              const maker = makerOf(m)
              const header = sortBy === 'name' && !q && maker !== lastMaker ? maker : null
              lastMaker = maker
              const u = usage.get(m.id)
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
                      <div
                        className={`mp-speed ${speedLabel(u) ? '' : 'none'}`}
                        title={
                          speedLabel(u)
                            ? `Time to the first word of a reply: the median of your last ${u!.speedSamples} repl${u!.speedSamples === 1 ? 'y' : 'ies'} on it${u!.avgSeconds ? ` · a whole turn averages ${u!.avgSeconds} s` : ''}`
                            : 'No speed yet: measured from your own replies once you use it'
                        }
                      >
                        {speedLabel(u) ? `⚡ ${speedLabel(u)} to first word` : 'speed: not used yet'}
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
            {!filtered.length && <div className="mp-empty">No models match “{q}”.</div>}
          </div>
          <div className="mp-foot">
            <span>Prices are SayGM's live in / out rates · −% is the saving against list price · ⚡ is from your own replies</span>
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
