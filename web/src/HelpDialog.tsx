import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api } from './api'
import { IconX } from './icons'

/**
 * Help: the user guide (the same pages as bitbull.tech/guide) with a help chat beside it.
 *
 * Guide pages are Markdown in the repo's help/ folder (help/guide/<slug>.md, listed in
 * help/guide/index.json), served at /help/; the system map is a self-contained HTML page shown
 * in a frame. The chat on the right asks BitBull itself, which answers from the same pages through
 * the bitbull-guide skill.
 *
 * Help is somewhere you come back to: the page you were on, what you were typing and the
 * conversation are kept when the window is closed (and across reloads), so you can go and try a
 * suggestion and pick up where you left off. An answer still arriving when you close it is there
 * when you return. help/README.md says how the pages are made.
 */
type GuidePage = { slug: string; title: string; description: string; order: number }
type Shown = { kind: 'guide'; slug: string } | { kind: 'ref'; file: string }
type Msg = { role: 'user' | 'assistant'; text: string; error?: boolean }
type HelpState = { shown: Shown | null; draft: string; sessionId: string | null; msgs: Msg[]; busy: boolean }

const REFERENCE: Array<{ file: string; title: string; blurb: string }> = [
  { file: 'system-map.html', title: 'System map', blurb: 'What runs where, a message start to finish, what keeps it safe' },
]
const SITE_GUIDE = 'https://www.bitbull.tech/guide'
const KEY = 'bitbull-help'
const MAX_MSGS = 40

/** The first message of a help conversation tells the model where the answers live. */
const firstMessage = (q: string) =>
  `A question about using BitBull. Answer from the user guide (bitbull-guide skill: the pages in /app/help/guide and /app/help/system-map.html), in plain steps, and name the guide page it comes from, linking it as /guide/<slug>. If the guide doesn't cover it, say so. Keep answering my follow-up questions the same way.\n\n${q.trim()}`

// ---- kept outside the component, so closing Help forgets nothing ----
function load(): HelpState {
  const empty: HelpState = { shown: null, draft: '', sessionId: null, msgs: [], busy: false }
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<HelpState> | null
    if (!v || typeof v !== 'object') return empty
    return {
      shown: v.shown && typeof v.shown === 'object' ? (v.shown as Shown) : null,
      draft: typeof v.draft === 'string' ? v.draft : '',
      sessionId: typeof v.sessionId === 'string' ? v.sessionId : null,
      msgs: Array.isArray(v.msgs) ? v.msgs.filter((m) => m && typeof m.text === 'string').slice(-MAX_MSGS) : [],
      busy: false,
    }
  } catch {
    return empty
  }
}
let state = load()
const listeners = new Set<() => void>()
function set(patch: Partial<HelpState>) {
  state = { ...state, ...patch }
  try {
    const { busy: _busy, ...keep } = state
    localStorage.setItem(KEY, JSON.stringify({ ...keep, msgs: keep.msgs.slice(-MAX_MSGS) }))
  } catch {
    /* private window: kept for this visit only */
  }
  listeners.forEach((l) => l())
}
const useHelp = () =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => state,
  )

/** Ask BitBull; runs to the end even if Help is closed meanwhile. */
async function ask(question: string) {
  const q = question.trim()
  if (!q || state.busy) return
  const first = !state.sessionId
  set({ msgs: [...state.msgs, { role: 'user', text: q }], draft: '', busy: true })
  const send = (sessionId: string | null) => api.helpChat(sessionId ? q : firstMessage(q), sessionId ?? undefined)
  try {
    let res
    try {
      res = await send(state.sessionId)
    } catch (e) {
      // the help chat was deleted from the sidebar: start a new one
      if (first || !/^404|not found/i.test(e instanceof Error ? e.message : '')) throw e
      res = await send(null)
    }
    const text = res.text.trim() || res.errors[0] || 'No answer came back. Try again.'
    set({ sessionId: res.sessionId, msgs: [...state.msgs, { role: 'assistant', text, error: !res.text.trim() }], busy: false })
  } catch (e) {
    const raw = e instanceof Error ? e.message.replace(/^\d+ /, '') : String(e)
    const text = /already running/.test(raw) ? 'BitBull is still answering the last question. Give it a moment and ask again.' : `Couldn't get an answer: ${raw.slice(0, 300)}`
    set({ msgs: [...state.msgs, { role: 'assistant', text, error: true }], busy: false })
  }
}

export function HelpDialog({ onClose, onOpenChat }: { onClose: () => void; onOpenChat: (sessionId: string) => void }) {
  const help = useHelp()
  const [pages, setPages] = useState<GuidePage[] | null>(null)
  const [body, setBody] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const article = useRef<HTMLDivElement>(null)
  const thread = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // the guide's page list
  useEffect(() => {
    void fetch('/help/guide/index.json')
      .then((r) => (r.ok && (r.headers.get('content-type') ?? '').includes('json') ? r.json() : []))
      .then((list: GuidePage[]) => setPages(Array.isArray(list) ? list.filter((p) => p && /^[a-z0-9-]+$/.test(p.slug)).sort((a, b) => a.order - b.order) : []))
      .catch(() => setPages([]))
  }, [])

  // the page shown: where you left off if it still exists, else the first guide page
  const known = (s: Shown | null) => !!s && (s.kind === 'guide' ? !!pages?.some((p) => p.slug === s.slug) : REFERENCE.some((r) => r.file === s.file))
  const shown: Shown | null = !pages ? null : known(help.shown) ? help.shown : pages.length ? { kind: 'guide', slug: pages[0].slug } : null
  const show = (s: Shown) => set({ shown: s })

  const slug = shown?.kind === 'guide' ? shown.slug : null
  useEffect(() => {
    if (!slug) return
    let gone = false
    setBody(null)
    setFailed(false)
    void fetch(`/help/guide/${slug}.md`)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((t) => {
        if (gone) return
        setBody(t)
        article.current?.scrollTo(0, 0)
      })
      .catch(() => !gone && setFailed(true))
    return () => {
      gone = true
    }
  }, [slug])

  useEffect(() => {
    thread.current?.scrollTo(0, thread.current.scrollHeight)
  }, [help.msgs.length, help.busy])

  /** Guide links are written for the website (/guide/<slug>, /system-map): keep them inside Help. */
  const link = ({ href, children }: { href?: string; children?: ReactNode }) => {
    const inGuide = /^(?:https:\/\/www\.bitbull\.tech)?\/guide\/([a-z0-9-]+)/.exec(href ?? '')
    if (inGuide && pages?.some((p) => p.slug === inGuide[1]))
      return (
        <a href={href} onClick={(e) => (e.preventDefault(), show({ kind: 'guide', slug: inGuide[1] }))}>
          {children}
        </a>
      )
    if (href?.startsWith('/system-map'))
      return (
        <a href={href} onClick={(e) => (e.preventDefault(), show({ kind: 'ref', file: 'system-map.html' }))}>
          {children}
        </a>
      )
    if (href?.startsWith('#')) return <span>{children}</span>
    return (
      <a href={href?.startsWith('/') ? `https://www.bitbull.tech${href}` : href} target="_blank" rel="noreferrer">
        {children}
      </a>
    )
  }

  const current = shown?.kind === 'guide' ? pages?.find((p) => p.slug === shown.slug) : undefined

  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal help-modal" role="dialog" aria-label="Help">
        <header className="modal-head">
          <h2>Help</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close: your place and your questions are kept">
            <IconX />
          </button>
        </header>
        <div className="help-body">
          <nav className="help-nav" aria-label="Guide pages">
            {!!pages?.length && <p className="help-group">The guide</p>}
            {pages?.map((p) => (
              <button
                key={p.slug}
                className={`help-item ${shown?.kind === 'guide' && shown.slug === p.slug ? 'on' : ''}`}
                onClick={() => show({ kind: 'guide', slug: p.slug })}
                title={p.description}
              >
                {p.title}
              </button>
            ))}
            {!!pages?.length && <p className="help-group">Reference</p>}
            {!!pages?.length &&
              REFERENCE.map((p) => (
                <button
                  key={p.file}
                  className={`help-item ${shown?.kind === 'ref' && shown.file === p.file ? 'on' : ''}`}
                  onClick={() => show({ kind: 'ref', file: p.file })}
                  title={p.blurb}
                >
                  {p.title}
                </button>
              ))}
            {shown && (
              <div className="help-links">
                <a href={shown.kind === 'guide' ? `${SITE_GUIDE}/${shown.slug}` : `/help/${shown.file}`} target="_blank" rel="noreferrer">
                  Open this page in a new tab
                </a>
              </div>
            )}
          </nav>

          {!shown ? (
            <div className="help-article">
              {pages && (
                <div className="md">
                  <p>
                    The guide pages aren't in this build of BitBull. Read them at{' '}
                    <a href={`${SITE_GUIDE}/getting-started`} target="_blank" rel="noreferrer">
                      bitbull.tech/guide
                    </a>
                    , or update BitBull to have them here. You can still ask a question on the right.
                  </p>
                </div>
              )}
            </div>
          ) : shown.kind === 'ref' ? (
            <iframe className="help-frame" title="Help page" src={`/help/${shown.file}`} />
          ) : (
            <div className="help-article" ref={article}>
              {current && (
                <header>
                  <h1>{current.title}</h1>
                  <p className="muted">{current.description}</p>
                </header>
              )}
              {failed && <p className="lv-error-text">Couldn't load this page.</p>}
              {body !== null && (
                <div className="md">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: link }}>
                    {body}
                  </ReactMarkdown>
                </div>
              )}
            </div>
          )}

          <section className="help-chat" aria-label="Ask BitBull">
            <div className="help-chat-head">
              <strong>Ask BitBull</strong>
              {help.msgs.length > 0 && (
                <span className="help-chat-actions">
                  {help.sessionId && (
                    <button className="link" onClick={() => onOpenChat(help.sessionId!)} title="Carry on in the main chat window">
                      Open as a chat
                    </button>
                  )}
                  <button className="link" onClick={() => set({ msgs: [], sessionId: null })} disabled={help.busy} title="Start a new help conversation">
                    Clear
                  </button>
                </span>
              )}
            </div>
            <div className="help-thread" ref={thread}>
              {!help.msgs.length && (
                <p className="muted small">
                  Ask how to do something and BitBull answers from this guide. Close Help to try it out: your question, the answers and the page you
                  were on are here when you come back.
                </p>
              )}
              {help.msgs.map((m, i) => (
                <div key={i} className={`help-msg ${m.role}${m.error ? ' err' : ''}`}>
                  {m.role === 'assistant' && !m.error ? (
                    <div className="md">
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: link }}>
                        {m.text}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    m.text
                  )}
                </div>
              ))}
              {help.busy && <div className="help-msg assistant pending">Looking it up in the guide…</div>}
            </div>
            <form
              className="help-ask"
              onSubmit={(e) => {
                e.preventDefault()
                void ask(help.draft)
              }}
            >
              <textarea
                rows={3}
                value={help.draft}
                onChange={(e) => set({ draft: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void ask(help.draft)
                  }
                }}
                placeholder="e.g. How do I link a folder from my PC?"
                aria-label="Your question"
              />
              <button className="btn sm" type="submit" disabled={!help.draft.trim() || help.busy}>
                {help.busy ? 'Answering…' : 'Ask'}
              </button>
            </form>
          </section>
        </div>
      </div>
    </div>
  )
}
