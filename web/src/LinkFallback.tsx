import { useState } from 'react'

/**
 * The address behind a button or link, shown in full with a Copy button, for when the link
 * doesn't open a browser (an older BitBull app ignores links; some browsers block new tabs).
 * Nothing here depends on the link working: the address can be read, selected or copied.
 */
export function LinkFallback({ url, what }: { url: string; what: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      /* no clipboard access: the address is on screen to select by hand */
    }
  }
  return (
    <p className="link-fallback small muted">
      If {what} doesn't open in your browser, copy this address into it:
      <span className="link-fallback-row">
        <code>{url}</code>
        <button type="button" className="btn sm" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </span>
    </p>
  )
}
