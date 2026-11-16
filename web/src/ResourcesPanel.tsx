/**
 * What this project (or the general workspace) is working with, down the right of the chat:
 * the folders linked for it, the repos and uploads in its workspace, its integrations and skills,
 * and the web addresses it may reach. One place to see how a chat is resourced, to link a folder
 * and watch it arrive, and to allow changes in one.
 *
 * It only shows and points: every permission is still given where it was before (a box on this
 * PC for folders, Settings for the rest).
 */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { api, type FileEntry, type LinkedFolder, type NetworkState, type Project, type RepoInfo } from './api'
import { IconBranch, IconChevronRight, IconFile, IconFolder, IconLock, IconPlus, IconRefresh, IconX } from './icons'
import { grantFolder, helperStatus, isMac, linkFolderFor, linkProgress, onThisPc, refreshFolder, revokeFolder, type HelperLink } from './linkHelper'

const KEY = 'bitbull.resources.open'
export const resourcesDefaultOpen = () => {
  try {
    const v = localStorage.getItem(KEY)
    return v === null ? window.innerWidth >= 1500 : v === '1'
  } catch {
    return false
  }
}
export const rememberResources = (open: boolean) => {
  try {
    localStorage.setItem(KEY, open ? '1' : '0')
  } catch {
    /* private mode: it just won't be remembered */
  }
}

function Section({ title, count, children, action }: { title: string; count?: number; children: ReactNode; action?: ReactNode }) {
  const [open, setOpen] = useState(true)
  return (
    <section className="res-sec">
      <div className="res-head">
        <button type="button" className="res-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <IconChevronRight size={12} className={`chev ${open ? 'open' : ''}`} />
          <span>{title}</span>
          {count !== undefined && <span className="res-count">{count}</span>}
        </button>
        {action}
      </div>
      {open && <div className="res-body">{children}</div>}
    </section>
  )
}

const few = <T,>(list: T[], n = 6) => ({ shown: list.slice(0, n), more: Math.max(0, list.length - n) })

export function ResourcesPanel({
  project,
  version,
  onClose,
  onOpenRepos,
  onOpenFiles,
  onOpenSettings,
}: {
  project: Project | null
  /** changes when a turn ends, so repos and uploads are read again */
  version: number
  onClose: () => void
  onOpenRepos: () => void
  onOpenFiles: () => void
  onOpenSettings: () => void
}) {
  const pid = project?.id ?? 'general'
  const scope = project?.id ?? null
  const here = project ? `this project` : 'the general workspace'
  const [links, setLinks] = useState<LinkedFolder[] | null>(null)
  const [helper, setHelper] = useState<{ links: HelperLink[]; caps: string[] } | null>(null)
  const [repos, setRepos] = useState<RepoInfo[]>([])
  const [uploads, setUploads] = useState<FileEntry[]>([])
  const [skills, setSkills] = useState<string[]>([])
  const [net, setNet] = useState<NetworkState | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const linking = useSyncExternalStore(linkProgress.subscribe, linkProgress.get)

  const loadLinks = () => {
    void api
      .links()
      .then((r) => setLinks(r.available ? r.links : []))
      .catch(() => setLinks([]))
    void helperStatus().then(setHelper)
  }
  useEffect(() => {
    loadLinks()
    void api
      .repos(pid)
      .then((r) => setRepos(r.repos))
      .catch(() => setRepos([]))
    void api
      .projectFiles(pid, 'uploads')
      .then((r) => setUploads(r.entries))
      .catch(() => setUploads([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid, version])
  useEffect(() => {
    void api
      .skills()
      .then((r) => setSkills(r.skills.map((s) => s.name)))
      .catch(() => {})
    void api
      .network()
      .then(setNet)
      .catch(() => {})
  }, [])
  // a link in progress ends with BitBull seeing the folder: read the list again then
  useEffect(() => {
    if (linking === null) loadLinks()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linking])

  const key = scope ?? 'general'
  const mine = (links ?? []).filter((l) => l.projects?.includes(key))
  const elsewhere = (links ?? []).filter((l) => !l.projects?.includes(key))
  const info = (name: string) => helper?.links.find((h) => h.name === name)
  const canGrant = !!helper?.caps.includes('changes')

  const act = async (label: string, fn: () => Promise<{ ok: boolean; cancelled?: boolean; message?: string }>, done: string) => {
    setNote(null)
    setBusy(label)
    try {
      const r = await fn()
      if (r.ok) setNote({ ok: true, text: done })
      else if (!r.cancelled) setNote({ ok: false, text: r.message ?? 'That did not work.' })
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(null)
      loadLinks()
    }
  }
  const startLink = async () => {
    setNote(null)
    try {
      const r = await linkFolderFor(scope)
      if (r.ok) setNote({ ok: true, text: `Linked ${r.path ?? r.name}. Attach it to a message from the folder button, or just name it.` })
      else if (!r.cancelled) setNote({ ok: false, text: r.message ?? 'Linking failed.' })
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : String(e) })
    }
  }

  const up = few(uploads, 6)
  const sk = few(skills, 8)
  const approved = net?.approved ?? []
  const ap = few(approved, 6)

  return (
    <aside className="resources" aria-label="Resources">
      <div className="res-top">
        <b>Resources</b>
        <span className="muted small res-where">{project ? project.name : 'General workspace'}</span>
        <button className="icon-btn sm" onClick={onClose} title="Hide this panel" aria-label="Hide resources">
          <IconX size={14} />
        </button>
      </div>

      <Section title="Linked folders" count={mine.length}>
        {links === null ? (
          <p className="muted small">Loading…</p>
        ) : (
          <>
            {mine.map((l) => {
              const h = info(l.name)
              return (
                <div className="res-item" key={l.name}>
                  <div className="res-line">
                    <IconLock size={13} />
                    <b className="mono">{l.name}</b>
                    <button
                      className="link small res-x"
                      title={`Take ${l.name} out of ${here}. It stays linked on this PC (Settings → Folders removes it).`}
                      onClick={() => void api.setLinkProject(l.name, scope, false).then(loadLinks)}
                    >
                      ×
                    </button>
                  </div>
                  {h?.path && <div className="res-sub mono">{h.path}</div>}
                  <div className="res-pills">
                    {h?.mode === 'filtered' && (
                      <span className="pill" title="The agent reads a copy without .env files, keys and wallets. Changes are written to your real folder, then the copy is refreshed.">
                        secrets hidden
                      </span>
                    )}
                    {h?.write ? (
                      <span className="pill warn" title={`Changes the agent makes here are written straight away, each shown with its diff and an Undo${h.since ? `. Allowed on ${h.since}` : ''}.`}>
                        changes allowed{h.delete ? ' · deleting too' : ''}
                      </span>
                    ) : (
                      <span className="pill ok">read-only</span>
                    )}
                  </div>
                  {onThisPc() && helper && (
                    <div className="res-actions">
                      {!h?.write && canGrant && (
                        <button className="btn sm" disabled={!!busy} title="A box on this PC asks you once" onClick={() => void act(`Answer the box that opened on this PC to allow changes in ${l.name}…`, () => grantFolder(l.name, 'write'), `Changes allowed in ${l.name}.`)}>
                          Allow changes
                        </button>
                      )}
                      {h?.write && (
                        <button className="btn sm" disabled={!!busy} title="Back to read-only. No question asked: it only makes BitBull able to do less." onClick={() => void act(`Making ${l.name} read-only…`, () => revokeFolder(l.name, 'write'), `${l.name} is read-only again.`)}>
                          Make read-only
                        </button>
                      )}
                      {h?.mode === 'filtered' && (
                        <button className="icon-btn sm" disabled={!!busy} title={`Refresh ${l.name}: copy the folder again so the agent sees it as it is now`} aria-label={`Refresh ${l.name}`} onClick={() => void act(`Refreshing ${l.name}…`, () => refreshFolder(l.name), `Refreshed ${l.name}.`)}>
                          <IconRefresh size={13} />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
            {!mine.length && !linking && <p className="muted small">No folder from this {isMac ? 'Mac' : 'PC'} is linked for {here} yet.</p>}
            {linking && (
              <div className="res-item res-pending">
                <div className="res-line">
                  <span className="res-spin" aria-hidden="true" />
                  <b>Linking a folder…</b>
                </div>
                <div className="res-sub">{linking}</div>
              </div>
            )}
            {elsewhere.length > 0 && (
              <div className="res-else">
                <span className="muted small">Linked on this PC, not in {here}:</span>
                {elsewhere.map((l) => (
                  <button key={l.name} className="btn sm" title={`Let chats in ${here} use ${l.name}`} onClick={() => void api.setLinkProject(l.name, scope, true).then(loadLinks)}>
                    <IconPlus size={12} /> {l.name}
                  </button>
                ))}
              </div>
            )}
            {onThisPc() && helper ? (
              <button className="btn sm res-add" disabled={!!busy || !!linking} onClick={() => void startLink()}>
                <IconPlus size={13} /> Link a folder…
              </button>
            ) : (
              <p className="muted small">{onThisPc() ? 'The link helper on this PC is not answering, so folders can\'t be linked or changed right now. Open the BitBull app or run start.ps1.' : 'Open BitBull on the computer it runs on to link a folder.'}</p>
            )}
            {busy && <p className="small fm-busy">{busy}</p>}
            {note && <p className={`small ${note.ok ? 'muted' : 'error'}`}>{note.text}</p>}
          </>
        )}
      </Section>

      <Section
        title="Repositories"
        count={repos.length}
        action={
          <button className="link small" onClick={onOpenRepos}>
            open
          </button>
        }
      >
        {repos.length ? (
          repos.map((r) => (
            <div className="res-item" key={r.path}>
              <div className="res-line">
                <IconBranch size={13} />
                <b>{r.name}</b>
                <span className="pill">{r.detached ? 'detached' : (r.branch ?? 'no commits')}</span>
                {r.behind > 0 && <span className="pill warn">↓{r.behind}</span>}
              </div>
              {r.remote && <div className="res-sub mono">{r.remote.replace(/^https:\/\/(www\.)?/, '')}</div>}
            </div>
          ))
        ) : (
          <p className="muted small">No clones in this workspace. Add one from Repositories.</p>
        )}
      </Section>

      <Section
        title="Uploads"
        count={uploads.length}
        action={
          <button className="link small" onClick={onOpenFiles}>
            browse
          </button>
        }
      >
        {up.shown.length ? (
          <>
            {up.shown.map((e) => (
              <div className="res-line res-file" key={e.name}>
                {e.dir ? <IconFolder size={13} /> : <IconFile size={13} />}
                <span className="mono">{e.name}</span>
              </div>
            ))}
            {up.more > 0 && <p className="muted small">and {up.more} more</p>}
          </>
        ) : (
          <p className="muted small">Nothing uploaded here yet.</p>
        )}
      </Section>

      <Section
        title="Integrations"
        count={project ? project.integrations.length : undefined}
        action={
          <button className="link small" onClick={onOpenSettings}>
            settings
          </button>
        }
      >
        {project ? (
          project.integrations.length ? (
            <div className="res-chips">
              {project.integrations.map((i) => (
                <span className="pill" key={i}>
                  {i}
                </span>
              ))}
            </div>
          ) : (
            <p className="muted small">None switched on for this project. Tick them in the project's settings.</p>
          )
        ) : (
          <p className="muted small">Chats outside a project use the integrations switched on in Settings.</p>
        )}
      </Section>

      <Section title="Skills" count={skills.length}>
        {sk.shown.length ? (
          <>
            <div className="res-chips">
              {sk.shown.map((s) => (
                <span className="pill" key={s}>
                  {s}
                </span>
              ))}
            </div>
            {sk.more > 0 && <p className="muted small">and {sk.more} more</p>}
          </>
        ) : (
          <p className="muted small">No skills installed.</p>
        )}
      </Section>

      <Section
        title="Web addresses you allowed"
        count={approved.length}
        action={
          <button className="link small" onClick={onOpenSettings}>
            settings
          </button>
        }
      >
        {ap.shown.length ? (
          <>
            {ap.shown.map((a) => (
              <div className="res-line res-file" key={`${a.scope}:${a.host}`}>
                <span className="mono">{a.scope === 'domain' ? `*.${a.host}` : a.host}</span>
              </div>
            ))}
            {ap.more > 0 && <p className="muted small">and {ap.more} more</p>}
          </>
        ) : (
          <p className="muted small">None beyond the built-in list{net ? ` (${net.allowlist.length} addresses)` : ''}.</p>
        )}
        <p className="muted small">These apply to every project.</p>
      </Section>
    </aside>
  )
}
