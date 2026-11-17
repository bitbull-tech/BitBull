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
  /** changes are allowed here for at least one project */
  write?: boolean
  /** and deleting, for at least one */
  delete?: boolean
  since?: string
  /** which project may do what here (project id, or "general"): a permission is for one project's chats */
  grants?: Record<string, { write: boolean; delete: boolean; since?: string }>
}

/** What one project may do in a linked folder. */
export const grantFor = (h: HelperLink | undefined | null, project: string | null | undefined) => h?.grants?.[project || 'general']
/** The projects with changes allowed in a folder. */
export const grantedProjects = (h: HelperLink | undefined | null) => Object.keys(h?.grants ?? {})

/** BitBull on a Mac: the helper is the BitBull app itself, folders open in Finder, links are copies. */
export const isMac = /Mac/i.test(navigator.userAgent)
export const fileManager = isMac ? 'Finder' : 'Explorer'
/** This page is open in the BitBull desktop app, which keeps the link helper running by itself. */
export const inDesktopApp = !!(window as unknown as { __BITBULL_DESKTOP?: unknown }).__BITBULL_DESKTOP
/** What starts the helper without the app, for the "no helper" notes. */
export const HELPER_CMD = isMac ? 'Open the BitBull app (it stays in the menu bar)' : 'powershell -ExecutionPolicy Bypass -File scripts\\bitbull-wsl\\start.ps1'

export const onThisPc = () => ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)

export async function helperStatus(): Promise<{ links: HelperLink[]; caps: string[] } | null> {
  if (!onThisPc()) return null
  try {
    const r = await fetch(`${HELPER}/status`, { signal: AbortSignal.timeout(2500) })
    if (!r.ok) return null
    const j = (await r.json()) as { ok: boolean; links?: HelperLink[]; caps?: string[] }
    return j.ok ? { links: j.links ?? [], caps: j.caps ?? [] } : null
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
async function waitForBitBull(name?: string, present = true) {
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
  await waitForBitBull(r.name ?? undefined, true)
  return r
}

export async function unlinkFolder(name: string, onStep?: (s: string) => void) {
  onStep?.(`Confirm in the box that opened on this computer to remove ${name}…`)
  const r = await post('/unlink', { name })
  if (!r.ok) return r
  onStep?.(isMac ? `Removed ${name}.` : `Removed ${name}. BitBull is restarting…`)
  await waitForBitBull(name, false)
  return r
}

/** Filtered links (every link on a Mac): re-scan the folder and copy it again (no restart). */
export async function refreshFolder(name: string, onStep?: (s: string) => void) {
  onStep?.(`Refreshing ${name}: checking it for secrets and copying it again…`)
  return post('/refresh', { name })
}

/** Allow changes ("write") or deleting ("delete") in a linked folder: the helper asks you in a box on this PC. */
export const grantFolder = (name: string, what: 'write' | 'delete', project: string | null, projectName?: string) =>
  post('/grant', { name, what, project: project || 'general', projectName: projectName ?? '' })
/** Take that permission away again: for one project, or (no project given) for all of them. No question: it only makes BitBull able to do less. */
export const revokeFolder = (name: string, what: 'write' | 'delete', project?: string | null) => post('/revoke', { name, what, project: project === undefined ? '' : project || 'general' })

/**
 * Apply a change set you approved: the helper copies the staged files into the folder (mode
 * "files") or makes a new git branch holding them (mode "branch"). It checks every file against
 * the hash given here, which is the one you were shown.
 */
export async function applyChange(body: {
  name: string
  staging: string
  manifest: { path: string; sha256: string; new?: boolean }[]
  deletes: string[]
  mode: 'files' | 'branch'
  branch: string
  message: string
  /** the project the change came from: the permission is per project */
  project: string
  /** each file's hash when the agent read it ("" = there was none): the helper won't overwrite anything else */
  expect?: Record<string, string>
}) {
  const r = await fetch(`${HELPER}/apply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return (await r.json()) as { ok: boolean; cancelled?: boolean; stale?: boolean; message?: string; branch?: string; repo?: string; written?: number; deleted?: number; backup?: string; backupId?: string }
}

/** Undo one apply: what it replaced or deleted is put back, what it created is removed; files changed since are left alone. */
export async function undoChange(name: string, backup: string, project: string) {
  const r = await fetch(`${HELPER}/undo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, backup, project }) })
  return (await r.json()) as { ok: boolean; message?: string; restored?: number; removed?: number; skipped?: string[] }
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

// ---------- linking for a project, with progress anyone on the page can show ----------

let progress: string | null = null
const progressSubs = new Set<() => void>()
const setProgress = (p: string | null) => {
  progress = p
  progressSubs.forEach((f) => f())
}
/** What a link in progress is doing right now (null: nothing is being linked). For the menu and the Resources panel. */
export const linkProgress = {
  get: () => progress,
  subscribe: (f: () => void) => {
    progressSubs.add(f)
    return () => {
      progressSubs.delete(f)
    }
  },
}

/** Link a folder (the picker opens on this PC) for one project: only that project's chats are offered it. */
export async function linkFolderFor(project: string | null) {
  setProgress('Choose the folder in the window that opened on this PC…')
  try {
    const r = await linkFolder((s) => setProgress(s))
    if (r.ok && r.name) {
      setProgress(`Adding ${r.name} to this ${project ? 'project' : 'workspace'}…`)
      await api.setLinkProject(r.name, project, true).catch(() => {})
    }
    return r
  } finally {
    setProgress(null)
  }
}
