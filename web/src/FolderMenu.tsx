import { useEffect, useRef, useState } from 'react'
import { api, type LinkedFolder } from './api'
import { IconCheck, IconCopy, IconFolder, IconLock, IconPlus, IconRefresh } from './icons'
import { HELPER_CMD, helperStatus, isMac, linkFolder, onThisPc, refreshFolder, type HelperLink } from './linkHelper'

/**
 * The composer's folder button: upload a copy (the agent may change it), attach a folder you
 * linked read-only (the agent may only read it), or link a new one. Linking opens a Windows
 * folder picker on this PC through the link helper; this page never names a path.
 */
export function FolderMenu({ onUpload, onLink }: { onUpload: () => void; onLink: (name: string) => void }) {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<{ available: boolean; links: LinkedFolder[] } | null>(null)
  const [helper, setHelper] = useState<{ links: HelperLink[] } | null | 'checking'>('checking')
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const load = () => {
    void api
      .links()
      .then(setState)
      .catch(() => setState({ available: false, links: [] }))
    setHelper('checking')
    void helperStatus().then(setHelper)
  }

  useEffect(() => {
    if (!open) return
    load()
    const close = (e: MouseEvent) => !busy && !ref.current?.contains(e.target as Node) && setOpen(false)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && !busy && setOpen(false)
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', esc)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, busy])

  const info = (name: string) => (helper && helper !== 'checking' ? helper.links.find((h) => h.name === name) : undefined)
  const winPath = (name: string) => info(name)?.path

  const startRefresh = async (name: string) => {
    setMsg(null)
    setBusy(`Refreshing ${name}…`)
    try {
      const r = await refreshFolder(name, (t) => setBusy(t))
      if (r.ok) {
        setMsg({ ok: true, text: `Refreshed ${name}: the agent now sees the folder as it is.` })
        load()
      } else setMsg({ ok: false, text: r.message ?? 'Refresh failed' })
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(null)
    }
  }

  const startLink = async () => {
    setMsg(null)
    setBusy('Opening the folder picker on this PC…')
    try {
      const r = await linkFolder((s) => setBusy(s))
      if (r.ok) {
        setMsg({ ok: true, text: `Linked ${r.path ?? r.name}. It's attached to this message.` })
        if (r.name) onLink(r.name)
        load()
      } else if (!r.cancelled) setMsg({ ok: false, text: r.message ?? 'Linking failed' })
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="folder-menu" ref={ref}>
      <button type="button" className={`icon-btn ${open ? 'on' : ''}`} title="Attach a folder" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <IconFolder size={16} />
      </button>
      {open && (
        <div className="fm-pop" role="menu">
          <button
            type="button"
            role="menuitem"
            className="fm-item"
            disabled={!!busy}
            onClick={() => {
              setOpen(false)
              onUpload()
            }}
          >
            <IconFolder size={15} />
            <span>
              <b>Upload a copy…</b>
              <small>Copied into the workspace. The agent can change the copy; your folder isn't touched.</small>
            </span>
          </button>
          <div className="fm-sep">Linked folders · read-only</div>
          {!state ? (
            <p className="fm-note">Loading…</p>
          ) : !state.available ? (
            <p className="fm-note">Links work in the sandboxed BitBull (Docker) only.</p>
          ) : (
            <>
              {state.links.map((l) =>
                l.readOnly ? (
                  <div className="fm-row" key={l.name}>
                    <button
                      type="button"
                      role="menuitem"
                      className="fm-item"
                      disabled={!!busy}
                      onClick={() => {
                        setOpen(false)
                        onLink(l.name)
                      }}
                    >
                      <IconLock size={15} />
                      <span>
                        <b>{l.name}</b>
                        <small>
                          {winPath(l.name) ? `${winPath(l.name)} · ` : ''}
                          {info(l.name)?.mode === 'filtered'
                            ? 'a read-only copy without its secrets (.env, keys, wallets). Refresh it after changing the folder.'
                            : 'read in place: the agent can read and analyse, never change.'}{' '}
                          {l.entries ?? '?'} items.
                        </small>
                      </span>
                    </button>
                    {info(l.name)?.mode === 'filtered' && (
                      <button
                        type="button"
                        className="icon-btn sm fm-refresh"
                        title={`Refresh ${l.name}: re-check the folder for secrets and copy it again`}
                        aria-label={`Refresh ${l.name}`}
                        disabled={!!busy}
                        onClick={() => void startRefresh(l.name)}
                      >
                        <IconRefresh size={14} />
                      </button>
                    )}
                  </div>
                ) : (
                  <p className="fm-note bad" key={l.name}>
                    {l.name} is not read-only, so BitBull won't use it. Remove it in Settings → Folders and link it again.
                  </p>
                ),
              )}

              {helper && helper !== 'checking' ? (
                <button type="button" role="menuitem" className="fm-item" disabled={!!busy} onClick={() => void startLink()}>
                  <IconPlus size={15} />
                  <span>
                    <b>Link a folder from this computer…</b>
                    <small>
                      {isMac
                        ? 'Opens a folder picker on this Mac. BitBull gets a read-only copy of the folder you choose, nothing else.'
                        : 'Opens a Windows folder picker on this PC. BitBull gets read-only access to the folder you choose, nothing else.'}
                    </small>
                  </span>
                </button>
              ) : helper === 'checking' ? (
                <p className="fm-note">Checking for the link helper…</p>
              ) : !onThisPc() ? (
                <p className="fm-note">To link a new folder, open BitBull on the computer it runs on (http://localhost:8787).</p>
              ) : (
                <>
                  <p className="fm-note">
                    {isMac
                      ? 'To link folders from here, the BitBull app must be running (it holds the link helper on a Mac), then reopen this menu:'
                      : 'To link folders from here, start the link helper on this PC (start.ps1 does it), then reopen this menu:'}
                  </p>
                  <div className="fm-cmd">
                    <code>{HELPER_CMD}</code>
                    <button
                      type="button"
                      className="icon-btn sm"
                      title="Copy"
                      onClick={() => {
                        void navigator.clipboard?.writeText(HELPER_CMD).then(() => {
                          setCopied(true)
                          setTimeout(() => setCopied(false), 1500)
                        })
                      }}
                    >
                      {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
                    </button>
                  </div>
                </>
              )}
              {busy && <p className="fm-note fm-busy">{busy}</p>}
              {msg && <p className={`fm-note ${msg.ok ? 'good' : 'bad'}`}>{msg.text}</p>}
              {state.links.length > 0 && <p className="fm-note">Every chat in this BitBull can read linked folders; attaching one tells this chat to use it.</p>}
            </>
          )}
        </div>
      )}
    </div>
  )
}
