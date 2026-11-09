/**
 * "Files from this reply": what the agent made or changed while answering, with a way out that
 * isn't a shell: download one file, download them all as a .zip, or show them in Explorer / Finder
 * (through the link helper on this computer).
 */
import { useState } from 'react'
import { api, type OutputFile } from './api'
import { IconDownload, IconFile, IconFolder } from './icons'
import { fileManager, onThisPc, openInExplorer } from './linkHelper'
import { fmtBytes } from './uploads'

const SHOW = 6

export function ReplyFiles({ files, projectId, host: hostPath }: { files: OutputFile[]; projectId: string; host: string | null }) {
  // showing in Explorer / Finder goes through the link helper on this computer
  const host = onThisPc() ? hostPath : null
  const [all, setAll] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  if (!files.length) return null

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key)
    setMsg(null)
    try {
      await fn()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }
  const download = (paths: string[], key: string) => run(key, () => api.download(projectId, paths))
  const reveal = (rel: string, key: string) =>
    run(key, async () => {
      const r = await openInExplorer(`${host}/${rel}`)
      if (!r.ok) throw new Error(r.message ?? `Could not open ${fileManager}`)
    })
  // the folder they have in common, to open in one go
  const common = (() => {
    const dirs = files.map((f) => f.path.split('/').slice(0, -1))
    const out: string[] = []
    for (let i = 0; dirs.every((d) => i < d.length && d[i] === dirs[0][i]); i++) out.push(dirs[0][i])
    return out.join('/')
  })()

  const shown = all ? files : files.slice(0, SHOW)
  return (
    <div className="reply-files">
      <div className="reply-files-head">
        <IconFolder size={14} />
        <span>
          {files.length} file{files.length === 1 ? '' : 's'} from this reply
        </span>
        <span className="grow" />
        {host && (
          <button type="button" className="btn sm" disabled={!!busy} onClick={() => void reveal(common, 'folder')} title={`Open ${common || 'the workspace'} in ${fileManager}`}>
            Open in {fileManager}
          </button>
        )}
        {files.length > 1 && (
          <button type="button" className="btn sm" disabled={!!busy} onClick={() => void download(files.map((f) => f.path), 'all')} title="Everything above as one .zip">
            <IconDownload size={13} /> {busy === 'all' ? 'Zipping…' : 'Download all'}
          </button>
        )}
      </div>
      <ul>
        {shown.map((f) => {
          const name = f.path.split('/').pop()!
          const dir = f.path.slice(0, -name.length - 1)
          return (
            <li key={f.path}>
              <IconFile size={13} />
              <span className="rf-name" title={f.path}>
                {name}
                {dir && <span className="muted"> · {dir}</span>}
              </span>
              <span className="muted small rf-size">{fmtBytes(f.size)}</span>
              <button type="button" className="icon-btn sm" disabled={!!busy} title={`Download ${name}`} onClick={() => void download([f.path], f.path)}>
                <IconDownload size={13} />
              </button>
              {host && (
                <button type="button" className="icon-btn sm" disabled={!!busy} title={`Show ${name} in ${fileManager}`} onClick={() => void reveal(f.path, `r:${f.path}`)}>
                  <IconFolder size={13} />
                </button>
              )}
            </li>
          )
        })}
      </ul>
      {files.length > SHOW && (
        <button type="button" className="linkish small" onClick={() => setAll((a) => !a)}>
          {all ? 'Show fewer' : `Show all ${files.length}`}
        </button>
      )}
      {msg && <div className="bad-text small">{msg}</div>}
    </div>
  )
}
