import { api } from './api'

/**
 * Talks to the link helper on this PC (scripts/bitbull-wsl/link-helper.ps1). The BitBull app keeps
 * it running on Windows; without the app, start.ps1 starts it.
 * The page never sends a path: the helper opens a Windows folder picker and you choose there.
 * It only answers BitBull's own page, and only on the PC itself (localhost).
 */
const HELPER = 'http://localhost:8790'

export interface HelperLink {
  name: string
  state: 'mounted' | 'missing'
  /** live: the folder itself; filtered: a read-only copy without its secrets (refresh to update) */
  mode: 'live' | 'filtered'
  path: string
}

/** BitBull on a Mac: the helper is the BitBull app itself, folders open in Finder, links are copies. */
export const isMac = /Mac/i.test(navigator.userAgent)
export const fileManager = isMac ? 'Finder' : 'Explorer'
/** This page is open in the BitBull desktop app, which keeps the link helper running by itself. */
export const inDesktopApp = !!(window as unknown as { __BITBULL_DESKTOP?: unknown }).__BITBULL_DESKTOP
/** What starts the helper without the app, for the "no helper" notes. */
export const HELPER_CMD = isMac ? 'Open the BitBull app (it stays in the menu bar)' : 'powershell -ExecutionPolicy Bypass -File scripts\\bitbull-wsl\\start.ps1'

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

/** BitBull restarts after a link changes; wait until it answers again and (optionally) shows the link. */
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

export const HELPER_HINT = isMac
  ? 'Linking from the page needs the link helper, which on a Mac runs inside the BitBull app: open the app (it stays in the menu bar) and reload.'
  : inDesktopApp
    ? 'The BitBull app starts the link helper by itself: give it a few seconds and try again.'
    : 'Linking from the page needs the link helper on this PC. Open the BitBull app (it starts the helper by itself), or run start.ps1 once.'

/** Opens the folder picker on this PC; resolves once BitBull shows the new link. */
export async function linkFolder(onStep?: (s: string) => void) {
  onStep?.('Choose the folder in the window that opened on this PC…')
  const r = await post('/link', {})
  if (!r.ok) return r
  onStep?.(isMac ? `Linked ${r.path ?? ''}. Waiting for BitBull to show it…` : `Linked ${r.path ?? ''}. BitBull is restarting to see it…`)
  await waitForGm(r.name ?? undefined, true)
  return r
}

export async function unlinkFolder(name: string, onStep?: (s: string) => void) {
  onStep?.(`Confirm in the box that opened on this computer to remove ${name}…`)
  const r = await post('/unlink', { name })
  if (!r.ok) return r
  onStep?.(isMac ? `Removed ${name}.` : `Removed ${name}. BitBull is restarting…`)
  await waitForGm(name, false)
  return r
}

/** Filtered links (every link on a Mac): re-scan the folder and copy it again (no restart). */
export async function refreshFolder(name: string, onStep?: (s: string) => void) {
  onStep?.(`Refreshing ${name}: checking it for secrets and copying it again…`)
  return post('/refresh', { name })
}

/** Open a folder of BitBull's data in Explorer (the helper maps the distro path to \\wsl.localhost\…) or Finder. */
export async function openInExplorer(hostPath: string): Promise<{ ok: boolean; message?: string }> {
  if (!onThisPc()) return { ok: false, message: 'Only from this PC' }
  try {
    return await post('/open', { path: hostPath })
  } catch {
    return { ok: false, message: HELPER_HINT }
  }
}

/**
 * The vault key kept on this PC by the helper (Windows DPAPI, this user only). null when the
 * helper isn't running or this isn't the PC BitBull runs on; the vault then stays locked.
 */
export async function vaultKeyFromThisPc(): Promise<string | null> {
  if (!onThisPc()) return null
  try {
    // The helper now shows a consent dialog and waits for a person to click OK. 2.5s aborted
    // the request while they were still reading it (2026-11 swarm: deepseek). /status stays short.
    const r = await fetch(`${HELPER}/vault-key`, { signal: AbortSignal.timeout(90_000) })
    if (!r.ok) return null
    const j = (await r.json()) as { ok: boolean; key?: string }
    return j.ok && j.key && /^[0-9a-f]{64}$/.test(j.key) ? j.key : null
  } catch {
    return null
  }
}
