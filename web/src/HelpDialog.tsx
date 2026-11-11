import { useEffect, useState } from 'react'
import { IconX } from './icons'

/**
 * Help: the pages in the repo's help/ folder (served at /help/), shown in a frame. The agent reads
 * the same folder, so what you see here is what it can tell you about. help/README.md says how to
 * add a page; add it to this list too.
 */
export const HELP_PAGES: Array<{ file: string; title: string; blurb: string }> = [
  { file: 'system-map.html', title: 'System map', blurb: 'What runs where, a message start to finish, what keeps it safe' },
]

const GUIDE = 'https://www.bitbull.tech/guide/getting-started'

export function HelpDialog({ onClose }: { onClose: () => void }) {
  const [page, setPage] = useState(HELP_PAGES[0])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

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
            {HELP_PAGES.map((p) => (
              <button key={p.file} className={`help-item ${p.file === page.file ? 'on' : ''}`} onClick={() => setPage(p)}>
                <strong>{p.title}</strong>
                <span>{p.blurb}</span>
              </button>
            ))}
            <div className="help-links">
              <a href={`/help/${page.file}`} target="_blank" rel="noreferrer">Open this page in a new tab</a>
              <a href={GUIDE} target="_blank" rel="noreferrer">The full guide on bitbull.tech</a>
              <span className="muted small">You can also ask BitBull: it reads these pages too.</span>
            </div>
          </nav>
          <iframe className="help-frame" title={page.title} src={`/help/${page.file}`} />
        </div>
      </div>
    </div>
  )
}
