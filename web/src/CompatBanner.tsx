import { useEffect, useState } from 'react'
import { api, type CompatNotice } from './api'
import { IconX } from './icons'

/**
 * Compatibility notices (server/src/compat.ts): SayGM or Ditto changed something BitBull relies
 * on, a key lapsed, or a newer BitBull is out. Shown above the chat until dismissed on this
 * computer; a notice comes back only if it changes (its id does).
 */
const KEY = 'bitbull.compat.dismissed'
const UPDATE_GUIDE = 'https://www.bitbull.tech/guide/everyday#updates-and-compatibility-notices'

function dismissed(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

export function CompatBanner({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [notices, setNotices] = useState<CompatNotice[]>([])
  const [hidden, setHidden] = useState<string[]>(dismissed)

  useEffect(() => {
    const load = () => void api.compat().then((r) => setNotices(r.notices)).catch(() => {})
    // the server's first check runs shortly after it starts
    const first = window.setTimeout(load, 30_000)
    load()
    const every = window.setInterval(load, 60 * 60 * 1000)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(every)
    }
  }, [])

  const dismiss = (id: string) => {
    const next = [...hidden.filter((h) => notices.some((n) => n.id === h)), id]
    setHidden(next)
    try {
      localStorage.setItem(KEY, JSON.stringify(next))
    } catch {
      /* private window: dismissed for this visit only */
    }
  }

  const shown = notices.filter((n) => !hidden.includes(n.id)).slice(0, 3)
  if (!shown.length) return null
  return (
    <div className="compat" role="status">
      {shown.map((n) => (
        <div key={n.id} className={`compat-item lv-${n.level}`}>
          <div className="compat-text">
            <strong>{n.title}</strong>
            <span>{n.detail}</span>
          </div>
          {n.action === 'update' && (
            <a className="btn sm" href={UPDATE_GUIDE} target="_blank" rel="noreferrer" title="Pull the latest BitBull and deploy it">
              How to update
            </a>
          )}
          {(n.action === 'reconnect-ditto' || n.action === 'settings') && (
            <button className="btn sm" onClick={onOpenSettings}>
              {n.action === 'reconnect-ditto' ? 'Reconnect Ditto' : 'Open Settings'}
            </button>
          )}
          <button className="icon-btn" onClick={() => dismiss(n.id)} aria-label="Dismiss" title="Dismiss on this computer">
            <IconX size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}
