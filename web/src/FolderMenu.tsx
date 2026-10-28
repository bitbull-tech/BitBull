import { useEffect, useRef, useState } from 'react'
import { api, type LinkedFolder } from './api'
import { IconCheck, IconCopy, IconFolder, IconLock } from './icons'

const LINK_CMD = 'powershell -ExecutionPolicy Bypass -File scripts\\gm-wsl\\link.ps1'

/**
 * The composer's folder button: upload a copy (the agent may change it), or attach a folder
 * the user linked read-only from Windows (the agent may only read it). Links are added with
 * link.ps1 on the PC, never from here.
 */
export function FolderMenu({ onUpload, onLink }: { onUpload: () => void; onLink: (name: string) => void }) {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<{ available: boolean; links: LinkedFolder[] } | null>(null)
  const [copied, setCopied] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    void api
      .links()
      .then(setState)
      .catch(() => setState({ available: false, links: [] }))
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

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
            <p className="fm-note">Links work in the sandboxed GM (Docker) only.</p>
          ) : (
            <>
              {state.links.map((l) =>
                l.readOnly ? (
                  <button
                    type="button"
                    role="menuitem"
                    key={l.name}
                    className="fm-item"
                    onClick={() => {
                      setOpen(false)
                      onLink(l.name)
                    }}
                  >
                    <IconLock size={15} />
                    <span>
                      <b>{l.name}</b>
                      <small>
                        Your files, read in place: the agent can read and analyse, never change. {l.entries ?? '?'} items at the top.
                      </small>
                    </span>
                  </button>
                ) : (
                  <p className="fm-note bad" key={l.name}>
                    {l.name} is not read-only, so GM won't use it. Remove it and link it again with link.ps1.
                  </p>
                ),
              )}
              {state.links.length > 0 && (
                <p className="fm-note">Every chat in this GM can read linked folders; attaching one tells this chat to use it.</p>
              )}
              <p className="fm-note">
                {state.links.length ? 'Link another' : 'No linked folders yet. Link one'} from PowerShell on this PC (GM can't add links itself). This opens a folder picker; add{' '}
                <code>-InstallMenu</code> once to get "Link to GM" on Explorer's right-click menu instead:
              </p>
              <div className="fm-cmd">
                <code>{LINK_CMD}</code>
                <button
                  type="button"
                  className="icon-btn sm"
                  title="Copy"
                  onClick={() => {
                    void navigator.clipboard?.writeText(LINK_CMD).then(() => {
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
        </div>
      )}
    </div>
  )
}
