import { api } from './api'

/**
 * Talks to the link helper on this PC (scripts/bitbob-wsl/link-helper.ps1, started by start.ps1).
 * The page never sends a path: the helper opens a Windows folder picker and you choose there.
 * It only answers BitBob's own page, and only on the PC itself (localhost).
 */
const HELPER = 'http://localhost:8790'

export interface HelperLink {
  name: string
  state: 'mounted' | 'missing'
  /** live: the folder itself; filtered: a read-only copy without its secrets (refresh to update) */
  mode: 'live' | 'filtered'
  path: string
}

export const onThisPc = () => ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)

export async function helperStatus(): Promise<{ links: HelperLink[] } | null> {
  if (!onThisPc()) return null
  try {
    const r = await fetch(`${HELPER}/status`, { signal: AbortSignal.timeout(2500) })
    if (!r.ok) return null
    const j = (await r.json()) as { ok: boolean; links?: HelperLink[] }
    return j.ok ? { links: j.links ?? [] } : null
  } catch {
    return null
  }
}

async function post(path: string, body: unknown) {
  const r = await fetch(`${HELPER}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return (await r.json()) as { ok: boolean; cancelled?: boolean; name?: string; path?: string; message?: string }
}

/** BitBob restarts after a link changes; wait until it answers again and (optionally) shows the link. */
async function waitForGm(name?: string, present = true) {
  const until = Date.now() + 90_000
  await new Promise((r) => setTimeout(r, 3000))
  while (Date.now() < until) {
    try {
      const r = await api.links()
      const has = !!name && r.links.some((l) => l.name === name)
      if (!name || has === present) return true
    } catch {
      /* restarting */
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  return false
}

export const HELPER_HINT =
  'Linking from the page needs the link helper on this PC. start.ps1 starts it; or run: powershell -ExecutionPolicy Bypass -STA -File scripts\\bitbob-wsl\\link-helper.ps1'

/** Opens the folder picker on this PC; resolves once BitBob shows the new link. */
export async function linkFolder(onStep?: (s: string) => void) {
  onStep?.('Choose the folder in the window that opened on this PC…')
  const r = await post('/link', {})
  if (!r.ok) return r
  onStep?.(`Linked ${r.path ?? ''}. BitBob is restarting to see it…`)
  await waitForGm(r.name ?? undefined, true)
  return r
}

export async function unlinkFolder(name: string, onStep?: (s: string) => void) {
  onStep?.(`Confirm in the Windows box to remove ${name}…`)
  const r = await post('/unlink', { name })
  if (!r.ok) return r
  onStep?.(`Removed ${name}. BitBob is restarting…`)
  await waitForGm(name, false)
  return r
}

/** Filtered links only: re-scan the folder on Windows and copy it again (no restart). */
export async function refreshFolder(name: string, onStep?: (s: string) => void) {
  onStep?.(`Refreshing ${name}: checking it for secrets and copying it again…`)
  return post('/refresh', { name })
}
