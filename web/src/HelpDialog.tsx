import { useEffect, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { IconX } from './icons'

/**
 * Help: the user guide and reference pages from the repo's help/ folder (served at /help/).
 * Guide pages are Markdown (help/guide/<slug>.md, listed in help/guide/index.json); reference
 * pages are self-contained HTML shown in a frame. The agent reads the same folder through the
 * bitbull-guide skill, so "Ask BitBull" answers from what is shown here. help/README.md says how
 * the pages are made and how to add one.
 */
type GuidePage = { slug: string; title: string; description: string; order: number }
const REFERENCE: Array<{ file: string; title: string; blurb: string }> = [
  { file: 'system-map.html', title: 'System map', blurb: 'What runs where, a message start to finish, what keeps it safe' },
]
type Shown = { kind: 'guide'; slug: string } | { kind: 'ref'; file: string }

const SITE_GUIDE = 'https://www.bitbull.tech/guide'

/** What goes into the message box when a question is asked from Help. */
export const helpQuestion = (q: string) =>
  `A question about using BitBull. Answer from the user guide (bitbull-guide skill: the pages in /app/help/guide and /app/help/system-map.html), in plain steps, and name the guide page it comes from. If the guide doesn't cover it, say so.\n\n${q.trim()}`

export function HelpDialog({ onClose, onAsk }: { onClose: () => void; onAsk: (question: string) => void }) {
  const [pages, setPages] = useState<GuidePage[]>([])
  const [shown, setShown] = useState<Shown>({ kind: 'ref', file: REFERENCE[0].file })
  const [body, setBody] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [question, setQuestion] = useState('')
  const article = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // the guide's page list; without it (an older build's help folder) the reference pages still show
  useEffect(() => {
    void fetch('/help/guide/index.json')
      .then((r) => (r.ok ? r.json() : []))
      .then((list: GuidePage[]) => {
        const ok = Array.isArray(list) ? list.filter((p) => p && /^[a-z0-9-]+$/.test(p.slug)).sort((a, b) => a.order - b.order) : []
        setPages(ok)
        if (ok.length) setShown({ kind: 'guide', slug: ok[0].slug })
      })
      .catch(() => {})
  }, [])

  const slug = shown.kind === 'guide' ? shown.slug : null
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

  /** Guide links are written for the website (/guide/<slug>, /system-map): keep them inside Help. */
  const link = ({ href, children }: { href?: string; children?: ReactNode }) => {
    const inGuide = /^\/guide\/([a-z0-9-]+)/.exec(href ?? '')
    if (inGuide && pages.some((p) => p.slug === inGuide[1]))
      return (
        <a href={href} onClick={(e) => (e.preventDefault(), setShown({ kind: 'guide', slug: inGuide[1] }))}>
          {children}
        </a>
      )
    if (href?.startsWith('/system-map'))
      return (
        <a href={href} onClick={(e) => (e.preventDefault(), setShown({ kind: 'ref', file: 'system-map.html' }))}>
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

  const ask = () => {
    if (!question.trim()) return
    onAsk(question)
  }
  const current = shown.kind === 'guide' ? pages.find((p) => p.slug === shown.slug) : undefined

  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal help-modal" role="dialog" aria-label="Help">
        <header className="modal-head">
          <h2>Help</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <IconX />
          </button>
        </header>
        <div className="help-body">
          <nav className="help-nav" aria-label="Help pages">
            <form
              className="help-ask"
              onSubmit={(e) => {
                e.preventDefault()
                ask()
              }}
            >
              <label htmlFor="help-q">Ask BitBull how to do something</label>
              <textarea
                id="help-q"
                rows={3}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    ask()
                  }
                }}
                placeholder="e.g. How do I link a folder from my PC?"
              />
              <button className="btn sm" type="submit" disabled={!question.trim()}>
                Ask in a new chat
              </button>
              <span className="muted small">Opens a chat with your question; BitBull answers from this guide.</span>
            </form>

            {pages.length > 0 && <p className="help-group">The guide</p>}
            {pages.map((p) => (
              <button
                key={p.slug}
                className={`help-item ${shown.kind === 'guide' && shown.slug === p.slug ? 'on' : ''}`}
                onClick={() => setShown({ kind: 'guide', slug: p.slug })}
                title={p.description}
              >
                <strong>{p.title}</strong>
              </button>
            ))}
            <p className="help-group">Reference</p>
            {REFERENCE.map((p) => (
              <button
                key={p.file}
                className={`help-item ${shown.kind === 'ref' && shown.file === p.file ? 'on' : ''}`}
                onClick={() => setShown({ kind: 'ref', file: p.file })}
                title={p.blurb}
              >
                <strong>{p.title}</strong>
              </button>
            ))}
            <div className="help-links">
              <a href={shown.kind === 'guide' ? `${SITE_GUIDE}/${shown.slug}` : `/help/${shown.file}`} target="_blank" rel="noreferrer">
                Open this page in a new tab
              </a>
            </div>
          </nav>

          {shown.kind === 'ref' ? (
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
        </div>
      </div>
    </div>
  )
}
