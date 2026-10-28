import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { getToken } from './api'
import { IconChevronRight, IconX } from './icons'

export type Level = 'debug' | 'info' | 'warn' | 'error'
export interface ActivityEvent {
  id: number
  ts: string
  level: Level
  source: string
  message: string
  sessionId?: string
  sessionTitle?: string
  detail?: string
  /** client-side only: raised in this browser, not by the server */
  local?: boolean
  /** toasts only: how many times this same error arrived */
  count?: number
}

/* ---------------- store: one live feed shared by the dock, the full view and toasts ---------------- */

const MAX = 1500
let events: ActivityEvent[] = []
let lastSeenErrorId = (() => {
  try {
    return Number(localStorage.getItem('gm-activity-seen') ?? 0) || 0
  } catch {
    return 0
  }
})()
let localUnseen = 0
let toasts: ActivityEvent[] = []
let connected = false
let localId = -1
const subs = new Set<() => void>()
let snapshot = { events, toasts, unseen: 0, connected }
const emit = () => {
  snapshot = { events, toasts, unseen: events.filter((e) => e.level === 'error' && e.id > lastSeenErrorId && !e.local).length + localUnseen, connected }
  subs.forEach((f) => f())
}

const liveSubs = new Set<(e: ActivityEvent) => void>()
/** Called for each event as it arrives live (not for history). */
export function onLiveActivity(fn: (e: ActivityEvent) => void) {
  liveSubs.add(fn)
  return () => {
    liveSubs.delete(fn)
  }
}

function add(e: ActivityEvent, live: boolean) {
  if (!e.local && events.some((x) => x.id === e.id)) return
  if (live) liveSubs.forEach((f) => f(e))
  events = [...events, e].slice(-MAX)
  // Only events that arrive while the page is open pop up; history doesn't
  if (live && e.level === 'error') {
    // The same error repeating (e.g. a retry loop) bumps one toast instead of stacking new ones
    const same = toasts.find((t) => t.source === e.source && t.message === e.message)
    toasts = same ? toasts.map((t) => (t === same ? { ...t, count: (t.count ?? 1) + 1, ts: e.ts } : t)) : [...toasts, e].slice(-3)
  }
  if (e.local && e.level === 'error') localUnseen++
  emit()
}

/** Errors raised in the browser (failed requests etc.) join the same feed. */
export function reportLocal(message: string, detail?: string, level: Level = 'error') {
  add({ id: localId--, ts: new Date().toISOString(), level, source: 'ui', message, detail, local: true }, true)
}

export function dismissToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id)
  emit()
}

export function clearToasts() {
  toasts = []
  emit()
}

export function markErrorsSeen() {
  const maxId = events.reduce((m, e) => (e.local ? m : Math.max(m, e.id)), lastSeenErrorId)
  lastSeenErrorId = maxId
  localUnseen = 0
  try {
    localStorage.setItem('gm-activity-seen', String(maxId))
  } catch {
    /* ignore */
  }
  toasts = []
  emit()
}

/* ---------------- selection for review ---------------- */

let selected = new Set<number>()
const selSubs = new Set<() => void>()
let selSnap = selected
const selEmit = () => {
  selSnap = new Set(selected)
  selSubs.forEach((f) => f())
}
export function toggleSelected(id: number) {
  if (selected.has(id)) selected.delete(id)
  else selected.add(id)
  selEmit()
}
export function clearSelected() {
  selected = new Set()
  selEmit()
}
export function useSelected() {
  return useSyncExternalStore(
    (f) => {
      selSubs.add(f)
      return () => selSubs.delete(f)
    },
    () => selSnap,
  )
}

/** Put text into the chat composer (Chat listens), so the user can add notes before sending. */
export function composeInChat(text: string) {
  window.dispatchEvent(new CustomEvent('gm:compose', { detail: text }))
}

export type ReviewMode = 'explain' | 'debug' | 'review'
const ASKS: Record<ReviewMode, string> = {
  explain: 'Explain what happened in these activity log entries, in plain terms, and whether anything needs my attention.',
  debug: 'Find the root cause of the problem in these activity log entries and propose a fix. Use the debugger subagent if you need to reproduce it.',
  review: 'Review these activity log entries with the reviewer and challenger subagents in parallel: what went wrong or looks risky, and what should change.',
}

export function logBlock(list: ActivityEvent[]) {
  return list
    .map((e) => {
      const head = `${e.ts} ${e.level.toUpperCase()} [${e.source}]${e.sessionTitle ? ` (chat: ${e.sessionTitle})` : ''} ${e.message}`
      const d = e.detail ? `\n${e.detail.length > 1500 ? e.detail.slice(0, 1500) + '\n…(truncated)' : e.detail}` : ''
      return head + d
    })
    .join('\n')
}

export function askAboutEvents(list: ActivityEvent[], mode: ReviewMode) {
  if (!list.length) return
  composeInChat(`${ASKS[mode]}\n\n\`\`\`log\n${logBlock(list)}\n\`\`\`\n\nMy notes: `)
  clearSelected()
}

let started = false
function start() {
  if (started) return
  started = true
  let after = 0
  let backlogDone = false
  const open = () => {
    const es = new EventSource(`/api/activity/stream?after=${after}&token=${encodeURIComponent(getToken())}`)
    // On the first connection, events in the first moment are history being replayed; don't toast those
    const t = setTimeout(() => (backlogDone = true), 1500)
    es.onopen = () => {
      connected = true
      emit()
    }
    es.onmessage = (m) => {
      try {
        const e = JSON.parse(m.data) as ActivityEvent
        after = Math.max(after, e.id)
        add(e, backlogDone)
      } catch {
        /* ignore malformed */
      }
    }
    es.onerror = () => {
      es.close()
      clearTimeout(t)
      // After a drop, what the next connection replays happened while we were away, so it is
      // news (toast it). If nothing ever arrived (after = 0), the replay is still old history.
      backlogDone = after > 0
      if (connected) {
        connected = false
        emit()
      }
      setTimeout(open, 3000)
    }
  }
  open()
}

export function useActivity() {
  useEffect(start, [])
  return useSyncExternalStore(
    (f) => {
      subs.add(f)
      return () => subs.delete(f)
    },
    () => snapshot,
  )
}

/* ---------------- presentation helpers ---------------- */

const time = (ts: string) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

function Row({ e, open, onToggle, picked }: { e: ActivityEvent; open: boolean; onToggle: () => void; picked: boolean }) {
  return (
    <div className={`act-row lv-${e.level} ${picked ? 'picked' : ''}`} data-askable="activity">
      <input
        type="checkbox"
        className="act-pick"
        checked={picked}
        onChange={() => toggleSelected(e.id)}
        aria-label="Select for review"
        title="Select for agent review"
      />
      <button className="act-line" onClick={onToggle} disabled={!e.detail}>
        <span className="act-time">{time(e.ts)}</span>
        <span className={`act-lv lv-${e.level}`}>{e.level}</span>
        <span className="act-src">{e.source}</span>
        <span className="act-msg">{e.message}</span>
        {e.sessionTitle && <span className="act-chat" title={e.sessionTitle}>{e.sessionTitle}</span>}
        {e.detail && <IconChevronRight size={12} className={`chev ${open ? 'open' : ''}`} />}
      </button>
      {open && e.detail && <pre className="act-detail">{e.detail}</pre>}
    </div>
  )
}

/** Bar shown when entries are ticked: send them to the agent. */
function ReviewBar({ events }: { events: ActivityEvent[] }) {
  const sel = useSelected()
  if (!sel.size) return null
  const list = events.filter((e) => sel.has(e.id))
  return (
    <div className="review-bar">
      <b>{sel.size} selected</b>
      <span className="muted small">Ask the agent to</span>
      <button className="btn sm" onClick={() => askAboutEvents(list, 'explain')}>Explain</button>
      <button className="btn sm" onClick={() => askAboutEvents(list, 'debug')}>Debug</button>
      <button className="btn sm primary" onClick={() => askAboutEvents(list, 'review')}>Review with subagents</button>
      <span className="grow" />
      <button className="link" onClick={clearSelected}>Clear</button>
    </div>
  )
}

/* ---------------- dock: collapsed bar at the bottom of the chat ---------------- */

type DockFilter = 'all' | 'problems' | 'chat'
const DOCK_KEY = 'gm-activity-dock'

export function ActivityDock({ sessionId, onOpenFull }: { sessionId?: string; onOpenFull: () => void }) {
  const { events, unseen, connected } = useActivity()
  const sel = useSelected()
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(DOCK_KEY) === 'open'
    } catch {
      return false
    }
  })
  const [filter, setFilter] = useState<DockFilter>('all')
  const [expanded, setExpanded] = useState<number | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const toggle = () =>
    setOpen((o) => {
      try {
        localStorage.setItem(DOCK_KEY, o ? 'closed' : 'open')
      } catch {
        /* ignore */
      }
      return !o
    })

  const shown = useMemo(
    () =>
      events
        .filter((e) => e.level !== 'debug')
        .filter((e) => (filter === 'problems' ? e.level === 'error' || e.level === 'warn' : filter === 'chat' ? e.sessionId === sessionId : true))
        .slice(-150),
    [events, filter, sessionId],
  )
  const last = events.filter((e) => e.level !== 'debug').at(-1)

  useEffect(() => {
    const el = listRef.current
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 60) el.scrollTop = el.scrollHeight
  }, [shown.length, open])

  return (
    <div className={`act-dock ${open ? 'open' : ''}`}>
      <div className="act-bar" onClick={toggle} role="button" aria-expanded={open}>
        <IconChevronRight size={13} className={`chev ${open ? 'open' : ''}`} />
        <b>Activity</b>
        <span className={`dot ${connected ? 'ok' : 'run'}`} title={connected ? 'Live' : 'Reconnecting…'} />
        {unseen > 0 && (
          <button
            className="act-badge"
            title="Show errors"
            onClick={(ev) => {
              ev.stopPropagation()
              setFilter('problems')
              if (!open) toggle()
            }}
          >
            {unseen} error{unseen > 1 ? 's' : ''}
          </button>
        )}
        <span className={`act-last lv-${last?.level ?? 'info'}`}>{last ? `${last.source} · ${last.message}` : 'Nothing yet'}</span>
        <button
          className="link"
          onClick={(ev) => {
            ev.stopPropagation()
            onOpenFull()
          }}
        >
          Full log
        </button>
      </div>
      {open && (
        <div className="act-body">
          <div className="seg mini act-filters">
            {(
              [
                ['all', 'All'],
                ['problems', 'Errors & warnings'],
                ['chat', 'This chat'],
              ] as const
            ).map(([id, label]) => (
              <button key={id} className={filter === id ? 'on' : ''} onClick={() => setFilter(id)} disabled={id === 'chat' && !sessionId}>
                {label}
              </button>
            ))}
            {unseen > 0 && (
              <button onClick={markErrorsSeen} title="Clear the error badge">
                Mark seen
              </button>
            )}
          </div>
          <ReviewBar events={events} />
          <div className="act-list" ref={listRef}>
            {shown.length === 0 && <p className="muted small pad">Nothing here yet.</p>}
            {shown.map((e) => (
              <Row key={e.id} e={e} picked={sel.has(e.id)} open={expanded === e.id} onToggle={() => setExpanded(expanded === e.id ? null : e.id)} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/* ---------------- full view: every event, searchable ---------------- */

export function ActivityView({ onClose, initialLevel }: { onClose: () => void; initialLevel?: Level }) {
  const { events } = useActivity()
  const sel = useSelected()
  const [level, setLevel] = useState<Level | 'all'>(initialLevel ?? 'all')
  const [source, setSource] = useState('all')
  const [q, setQ] = useState('')
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [follow, setFollow] = useState(true)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const sources = useMemo(() => Array.from(new Set(events.map((e) => e.source))).sort(), [events])
  const order: Level[] = ['debug', 'info', 'warn', 'error']
  const shown = events.filter(
    (e) =>
      (level === 'all' || order.indexOf(e.level) >= order.indexOf(level)) &&
      (source === 'all' || e.source === source) &&
      (!q || `${e.message} ${e.detail ?? ''} ${e.sessionTitle ?? ''}`.toLowerCase().includes(q.toLowerCase())),
  )
  const counts = { error: events.filter((e) => e.level === 'error').length, warn: events.filter((e) => e.level === 'warn').length }

  useEffect(() => {
    if (follow && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [shown.length, follow])

  const download = () => {
    const text = shown.map((e) => `${e.ts} ${e.level.toUpperCase()} [${e.source}]${e.sessionTitle ? ` (${e.sessionTitle})` : ''} ${e.message}${e.detail ? `\n${e.detail}` : ''}`).join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
    a.download = `gm-activity-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.log`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal act-modal" role="dialog" aria-label="Activity log">
        <header className="modal-head">
          <h2>Activity</h2>
          <span className="muted small">
            {events.length} events · <span className="lv-error-text">{counts.error} errors</span> · {counts.warn} warnings
          </span>
          <span className="grow" />
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <IconX />
          </button>
        </header>
        <div className="act-tools">
          <input placeholder="Search messages, tool calls, chats…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select value={level} onChange={(e) => setLevel(e.target.value as Level | 'all')} aria-label="Level">
            <option value="all">All levels</option>
            <option value="info">Info and above</option>
            <option value="warn">Warnings and errors</option>
            <option value="error">Errors only</option>
          </select>
          <select value={source} onChange={(e) => setSource(e.target.value)} aria-label="Source">
            <option value="all">All sources</option>
            {sources.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <label className="check">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow
          </label>
          <button className="btn" onClick={() => setExpanded(expanded.size ? new Set() : new Set(shown.filter((e) => e.detail).map((e) => e.id)))}>
            {expanded.size ? 'Collapse all' : 'Expand all'}
          </button>
          <button className="btn" onClick={download}>Download</button>
          <button className="btn" onClick={markErrorsSeen}>Mark errors seen</button>
        </div>
        <div className="act-review-wrap">
          <ReviewBar events={events} />
        </div>
        <div className="act-list full" ref={listRef}>
          {shown.length === 0 && <p className="muted small pad">No matching events.</p>}
          {shown.map((e) => (
            <Row
              key={e.id}
              e={e}
              picked={sel.has(e.id)}
              open={expanded.has(e.id)}
              onToggle={() =>
                setExpanded((s) => {
                  const n = new Set(s)
                  if (n.has(e.id)) n.delete(e.id)
                  else n.add(e.id)
                  return n
                })
              }
            />
          ))}
        </div>
        <p className="muted small act-foot">
          Kept on the server in <code>data/logs/activity.jsonl</code> (last 2,000 events here; secrets are redacted). Raw server output is in{' '}
          <code>data/logs/server.log</code>.
        </p>
      </div>
    </div>
  )
}

/* ---------------- error toasts ---------------- */

export function ErrorToasts({ onOpen }: { onOpen: () => void }) {
  const { toasts } = useActivity()
  if (!toasts.length) return null
  return (
    <div className="toasts" role="status" aria-live="assertive">
      {toasts.map((t) => (
        <div key={t.id} className="toast err">
          <div className="toast-head">
            <b>Error · {t.source}</b>
            {(t.count ?? 1) > 1 && <span className="act-badge">×{t.count}</span>}
            {t.sessionTitle && <span className="muted small">{t.sessionTitle}</span>}
            <span className="grow" />
            <button className="icon-btn sm" onClick={() => dismissToast(t.id)} aria-label="Dismiss">
              <IconX size={13} />
            </button>
          </div>
          <div className="toast-msg">{t.message}</div>
          <button
            className="link"
            onClick={() => {
              dismissToast(t.id)
              onOpen()
            }}
          >
            Open activity log
          </button>
        </div>
      ))}
    </div>
  )
}

/* ---------------- highlight text → ask the agent ---------------- */

/**
 * Select text in a reply or in the activity log and a small "Ask agent" button appears next to
 * it. The excerpt goes into the composer as a quote, ready for your note.
 */
export function SelectionAsk() {
  const [pos, setPos] = useState<{ x: number; y: number; text: string; kind: string } | null>(null)
  useEffect(() => {
    const onUp = () =>
      setTimeout(() => {
        const sel = window.getSelection()
        const text = sel?.toString().trim() ?? ''
        if (!sel || !text || sel.rangeCount === 0) return setPos(null)
        const node = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement
        const host = node?.closest('[data-askable]')
        if (!host) return setPos(null)
        const r = sel.getRangeAt(0).getBoundingClientRect()
        setPos({ x: Math.min(r.right, window.innerWidth - 220), y: Math.max(8, r.top - 40), text: text.slice(0, 6000), kind: host.getAttribute('data-askable') ?? '' })
      }, 0)
    const onDown = (e: MouseEvent) => {
      if (!(e.target as Element)?.closest?.('.sel-ask')) setPos(null)
    }
    document.addEventListener('mouseup', onUp)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('mouseup', onUp)
      document.removeEventListener('mousedown', onDown)
    }
  }, [])
  if (!pos) return null
  const what = pos.kind === 'reply' ? 'this part of your reply' : 'this part of the activity log'
  const quote = pos.text
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n')
  const go = (ask: string) => {
    composeInChat(`${ask} ${what}:\n\n${quote}\n\nMy notes: `)
    window.getSelection()?.removeAllRanges()
    setPos(null)
  }
  return (
    <div className="sel-ask" style={{ left: pos.x, top: pos.y }}>
      <span className="muted small">Ask agent:</span>
      <button className="btn sm" onClick={() => go('Explain')}>Explain</button>
      <button className="btn sm" onClick={() => go('Review and challenge')}>Review</button>
      <button className="btn sm" onClick={() => go('Fix the problem in')}>Fix</button>
    </div>
  )
}
