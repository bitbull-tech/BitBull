import { useEffect, useState } from 'react'

export type ThemePref = 'system' | 'light' | 'dark'
const KEY = 'bitbob-theme'

const read = (): ThemePref => {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return 'system'
  }
}

/** Applies data-theme on <html>; "system" removes it so prefers-color-scheme wins. */
export function applyTheme(pref: ThemePref) {
  const root = document.documentElement
  if (pref === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', pref)
}

export function useTheme() {
  const [pref, setPref] = useState<ThemePref>(read)
  useEffect(() => {
    applyTheme(pref)
    try {
      localStorage.setItem(KEY, pref)
    } catch {
      /* ignore */
    }
  }, [pref])
  return [pref, setPref] as const
}

// Apply before first paint to avoid a flash of the wrong theme
applyTheme(read())
