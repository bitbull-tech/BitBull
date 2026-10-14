import { useEffect, useRef, useState } from 'react'
import { api, type Project, type StoredFile } from './api'
import { IconChevronRight, IconFile, IconFolder, IconRefresh, IconX } from './icons'
import { filterItems, fmtBytes, fromDrop, fromInput, SKIP_DIRS, uploadItems, type UploadItem } from './uploads'

/** Whether a file has reached Hippius yet. Nothing is shown when storage is switched off. */
function BackupMark({ file }: { file?: StoredFile }) {
  if (!file) return <span className="backup-mark none" title="Not backed up" />
  if (file.status === 'stored')
    return <span className="backup-mark ok" title={`Backed up to Hippius${file.sha256 ? ` · sha256 ${file.sha256.slice(0, 12)}…` : ''}`} />
  if (file.status === 'pending') return <span className="backup-mark pending" title="Waiting to upload" />
  return <span className="backup-mark bad" title={file.error ?? 'Upload failed'} />
}

/**
 * Browse a project's workspace and add local files or whole folders to it (structure kept).
 * project = null → the general workspace used by chats outside projects.
 */
export function FilesDialog({ project, onClose }: { project: Project | null; onClose: () => void }) {
  const pid = project?.id ?? 'general'
  const [dir, setDir] = useState('')
  const [entries, setEntries] = useState<{ name: string; dir: boolean; size: number }[] | null>(null)
  const [target, setTarget] = useState('uploads')
  const [picked, setPicked] = useState<UploadItem[]>([])
  const [skipBuild, setSkipBuild] = useState(true)
  const [overwrite, setOverwrite] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const filesRef = useRef<HTMLInputElement>(null)
  const folderRef = useRef<HTMLInputElement>(null)
  const [stored, setStored] = useState<Map<string, StoredFile>>(new Map())
  const [storage, setStorage] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = (d = dir) =>
    void api
      .projectFiles(pid, d)
      .then((r) => setEntries(r.entries))
      .catch((e) => setMsg(e instanceof Error ? e.message : String(e)))

  /** What of this workspace is backed up on Hippius, keyed by path within it. */
  const loadStored = () =>
    void api
      .storedFiles(pid)
      .then((r) => {
        setStorage(r.enabled)
        setStored(new Map(r.files.map((f) => [f.rel_path, f])))
      })
      .catch(() => setStorage(false))

  useEffect(() => {
    load(dir)
    loadStored()
    setTarget(dir || 'uploads')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !progress && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, progress])

  const items = filterItems(picked, skipBuild)
  const filteredOut = picked.length - items.length
  const totalBytes = items.reduce((n, i) => n + i.file.size, 0)

  const add = (more: UploadItem[]) => {
    setMsg(null)
    setPicked((p) => [...p, ...more])
  }

  const start = async () => {
    if (!items.length) return
    setMsg(null)
    setProgress({ done: 0, total: items.length })
    try {
      const r = await uploadItems(pid, items, { target, overwrite, onProgress: (done, total) => setProgress({ done, total }) })
      setMsg(
        `Added ${r.saved.length} file${r.saved.length === 1 ? '' : 's'} to ${target || 'the workspace root'}` +
          (r.skipped.length ? ` · ${r.skipped.length} already existed and were kept (tick "Replace existing" to overwrite)` : ''),
      )
      setPicked([])
      load()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setProgress(null)
    }
  }

  const crumbs = dir ? dir.split('/') : []

  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && !progress && onClose()}>
      <div className="modal files-modal" role="dialog" aria-label="Project files">
        <header className="modal-head">
          <h2>Files · {project?.name ?? 'General workspace'}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close" disabled={!!progress}>
            <IconX />
          </button>
        </header>
        <div className="modal-body">
          <div className="files-crumbs">
            <button className="link" onClick={() => setDir('')}>workspace</button>
            {crumbs.map((c, i) => (
              <span key={i}>
                <IconChevronRight size={12} />
                <button className="link" onClick={() => setDir(crumbs.slice(0, i + 1).join('/'))}>{c}</button>
              </span>
            ))}
            <span className="grow" />
            <button className="icon-btn sm" title="Refresh" onClick={() => load()}>
              <IconRefresh size={13} />
            </button>
          </div>
          <div className="files-list">
            {entries === null && <p className="muted small pad">Loading…</p>}
            {entries?.length === 0 && <p className="muted small pad">Empty folder.</p>}
            {entries?.map((e) =>
              e.dir ? (
                <button key={e.name} className="file-row" onClick={() => setDir(dir ? `${dir}/${e.name}` : e.name)}>
                  <IconFolder size={14} /> <span className="grow">{e.name}</span>
                </button>
              ) : (
                <div key={e.name} className="file-row">
                  <IconFile size={14} /> <span className="grow">{e.name}</span>
                  {storage && <BackupMark file={stored.get(dir ? `${dir}/${e.name}` : e.name)} />}
                  <span className="muted small">{fmtBytes(e.size)}</span>
                </div>
              ),
            )}
          </div>

          <h3>Add from this computer</h3>
          <div
            className={`files-drop ${dragging ? 'on' : ''}`}
            onDragOver={(e) => {
              e.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragging(false)
              void fromDrop(e.dataTransfer).then((r) => add(r.items))
            }}
          >
            Drop files or folders here, or
            <button className="btn" onClick={() => filesRef.current?.click()}>Choose files</button>
            <button className="btn" onClick={() => folderRef.current?.click()}>Choose a folder</button>
            <input ref={filesRef} type="file" multiple hidden onChange={(e) => (add(fromInput(e.target.files)), (e.target.value = ''))} />
            <input
              ref={folderRef}
              type="file"
              hidden
              {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
              onChange={(e) => (add(fromInput(e.target.files)), (e.target.value = ''))}
            />
          </div>

          {picked.length > 0 && (
            <div className="files-plan">
              <label className="field">
                <span>Put them in (folder inside this workspace)</span>
                <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="uploads" />
              </label>
              <label className="check">
                <input type="checkbox" checked={skipBuild} onChange={(e) => setSkipBuild(e.target.checked)} />
                Skip dependency and build folders ({SKIP_DIRS.slice(0, 5).join(', ')}…)
              </label>
              <label className="check">
                <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
                Replace files that already exist
              </label>
              <p className="small">
                <b>{items.length}</b> file{items.length === 1 ? '' : 's'} · {fmtBytes(totalBytes)}
                {filteredOut > 0 && <span className="muted"> · {filteredOut} skipped by the filter</span>}
              </p>
              <ul className="files-preview small muted">
                {items.slice(0, 6).map((i, k) => (
                  <li key={k}>{target ? `${target}/` : ''}{i.path}</li>
                ))}
                {items.length > 6 && <li>…and {items.length - 6} more</li>}
              </ul>
              {progress && (
                <div className="todos-bar wide">
                  <i style={{ width: `${(progress.done / progress.total) * 100}%` }} />
                </div>
              )}
              <div className="row-actions">
                <button className="btn" onClick={() => setPicked([])} disabled={!!progress}>Clear</button>
                <button className="btn primary" onClick={() => void start()} disabled={!items.length || !!progress}>
                  {progress ? `Uploading ${progress.done}/${progress.total}…` : `Add ${items.length} file${items.length === 1 ? '' : 's'}`}
                </button>
              </div>
            </div>
          )}
          {msg && <p className="small">{msg}</p>}

          {storage && stored.size > 0 && (
            <>
              <h3>Backed up on Hippius</h3>
              <p className="muted small">
                Encrypted here before upload, and indexed in Ditto so you can ask for them by what they are. Restoring writes the
                file back into this workspace and checks it against its original checksum.
              </p>
              <div className="files-list">
                {[...stored.values()].slice(0, 40).map((f) => (
                  <div key={f.id} className="file-row">
                    <BackupMark file={f} />
                    <span className="grow">{f.rel_path}</span>
                    <span className="muted small">{fmtBytes(f.size)}</span>
                    {f.status === 'stored' && (
                      <button
                        className="btn sm"
                        disabled={busyId === f.id}
                        onClick={() => {
                          setBusyId(f.id)
                          setMsg(null)
                          void api
                            .restoreStored(f.id)
                            .then((r) =>
                              setMsg(r.verified ? `Restored ${r.path} and the checksum matched.` : `Restored ${r.path}, but the checksum did NOT match.`),
                            )
                            .catch((e) => setMsg(e instanceof Error ? e.message : String(e)))
                            .finally(() => (setBusyId(null), load()))
                        }}
                      >
                        {busyId === f.id ? 'Restoring…' : 'Restore'}
                      </button>
                    )}
                    {f.status === 'failed' && (
                      <button
                        className="btn sm"
                        disabled={busyId === f.id}
                        title={f.error ?? undefined}
                        onClick={() => {
                          setBusyId(f.id)
                          void api
                            .retryStored(f.id)
                            .then(() => setMsg('Queued again.'))
                            .catch((e) => setMsg(e instanceof Error ? e.message : String(e)))
                            .finally(() => (setBusyId(null), setTimeout(loadStored, 1500)))
                        }}
                      >
                        Try again
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}

          <p className="muted small">
            Tip: for a Git repository, ask the agent to clone it instead. That keeps its history and lets the agent push back (set
            GITHUB_TOKEN for private repos).
          </p>
        </div>
      </div>
    </div>
  )
}
