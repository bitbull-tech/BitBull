import { useEffect, useState } from 'react'
import { assetUrl, getBrand } from './brand'
import defaultMark from './assets/bitbob-mark.png'

/** True when the page is currently rendering in dark mode, and updates when that changes. */
function useDark() {
  const read = () => {
    const attr = document.documentElement.getAttribute('data-theme')
    if (attr === 'dark') return true
    if (attr === 'light') return false
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
  }
  const [dark, setDark] = useState(read)
  useEffect(() => {
    const update = () => setDark(read())
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
    mq?.addEventListener('change', update)
    // The theme toggle sets data-theme on <html>
    const obs = new MutationObserver(update)
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => {
      mq?.removeEventListener('change', update)
      obs.disconnect()
    }
  }, [])
  return dark
}

/**
 * The operator's logo; else their text mark if brand.json sets one; else BitBob's own mark
 * (the hard hat).
 * `onDark` forces the dark logo: the sidebar is dark whatever the theme.
 */
export function BrandMark({ className = 'brand-mark', onDark }: { className?: string; onDark?: boolean }) {
  const dark = useDark()
  const brand = getBrand()
  const src = assetUrl((onDark ?? dark ? brand.logoDark : null) ?? brand.logo) ?? (brand.mark ? null : defaultMark)
  return (
    <div className={`${className}${src ? ' has-img' : ''}`} aria-hidden="true">
      {src ? <img src={src} alt="" /> : brand.mark}
    </div>
  )
}
