/**
 * QA Hound's target box: type a path, or pick one. Opening it lists what can be reviewed in this
 * workspace (repos first, then its folders and files); typing narrows the list, and a "/" steps
 * into that folder and lists what is inside, so a path never has to be remembered or guessed.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type FileEntry, type RepoInfo } from './api'
import { IconBranch, IconFile, IconFolder } from './icons'

interface Option {
  /** what goes in the box */
  value: string
  label: string
  hint?: string
  kind: 'repo' | 'dir' | 'file'
}

const SKIP = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', '.cache', 'dist', 'build', '.next', 'target'])
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

export function TargetPicker({ projectId, repos, value, onChange }: { projectId: string; repos: RepoInfo[]; value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false)
  const [cursor, setCursor] = useState(0)
  // folder listings, by folder path ('' = the workspace itself); null while loading, [] when it isn't a folder
  const [dirs, setDirs] = useState<Record<string, FileEntry[] | null>>({})
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // "src/app/ma" → look in "src/app", for names starting with "ma"
  const cut = value.lastIndexOf('/')
  const dir = cut >= 0 ? value.slice(0, cut) : ''
  const stem = (cut >= 0 ? value.slice(cut + 1) : value).toLowerCase()

  useEffect(() => {
    if (!open || dir in dirs) return
    setDirs((d) => ({ ...d, [dir]: null }))
    api
      .projectFiles(projectId, dir)
      .then((r) => setDirs((d) => ({ ...d, [dir]: r.entries })))
      .catch(() => setDirs((d) => ({ ...d, [dir]: [] })))
  }, [open, dir, dirs, projectId])
  // another project's workspace is a different set of folders
  useEffect(() => setDirs({}), [projectId])

  const options = useMemo<Option[]>(() => {
    const out: Option[] = []
    const q = value.trim().toLowerCase()
    if (!dir) {
      for (const r of repos) {
        if (q && !r.path.toLowerCase().includes(q) && !r.name.toLowerCase().includes(q)) continue
        out.push({ value: r.path, label: r.path, hint: `repo · ${r.branch ?? 'no branch'}${r.behind > 0 ? ` · ${r.behind} behind` : ''}`, kind: 'repo' })
      }
    }
    const prefix = dir ? `${dir}/` : ''
    for (const e of dirs[dir] ?? []) {
      if (SKIP.has(e.name)) continue
      if (e.name.startsWith('.') && !stem.startsWith('.')) continue
      // names that start with what was typed first; then names that merely contain it
      if (stem && !e.name.toLowerCase().includes(stem)) continue
      const v = prefix + e.name
      if (out.some((o) => o.value === v)) continue
      out.push({ value: v, label: v, hint: e.dir ? 'folder' : size(e.size), kind: e.dir ? 'dir' : 'file' })
    }
    const rank = (o: Option) => (o.kind === 'repo' ? 0 : o.label.slice(prefix.length).toLowerCase().startsWith(stem) ? 1 : 2)
    return out.sort((a, b) => rank(a) - rank(b) || Number(b.kind === 'dir') - Number(a.kind === 'dir') || a.label.localeCompare(b.label)).slice(0, 60)
  }, [value, dir, stem, dirs, repos])

  useEffect(() => setCursor(0), [value, open])
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${cursor}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  /** A folder is stepped into (the list shows what is inside); a repo or a file is the answer. */
  const pick = (o: Option, stepIn: boolean) => {
    if (o.kind !== 'file' && stepIn) {
      onChange(`${o.value}/`)
      setOpen(true)
    } else {
      onChange(o.value)
      setOpen(false)
    }
  }

  const loading = open && dirs[dir] === null
  const exact = options.find((o) => o.value === value.replace(/\/$/, ''))
  return (
    <div className="tp" ref={rootRef}>
      <input
        value={value}
        role="combobox"
        aria-expanded={open}
        aria-controls="tp-list"
        aria-autocomplete="list"
        autoComplete="off"
        spellCheck={false}
        placeholder="Pick from the list, or type a path: my-repo, my-repo/src, uploads/script.py"
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            if (!open) setOpen(true)
            else setCursor((c) => Math.min(options.length - 1, c + 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setCursor((c) => Math.max(0, c - 1))
          } else if (e.key === 'Tab' && open && options[cursor] && options[cursor].value !== value) {
            // Tab completes, and steps into a folder
            e.preventDefault()
            pick(options[cursor], true)
          } else if (e.key === 'Enter' && open && options[cursor]) {
            e.preventDefault()
            pick(options[cursor], false)
          } else if (e.key === 'Escape' && open) {
            // close the list, not the whole dialog
            e.preventDefault()
            e.stopPropagation()
            e.nativeEvent.stopImmediatePropagation()
            setOpen(false)
          }
        }}
      />
      {open && (
        <div className="tp-list" id="tp-list" role="listbox" ref={listRef}>
          {!dir && !value && repos.length > 0 && <div className="tp-group">Repos, then everything else in this workspace</div>}
          {dir && (
            <div className="tp-group">
              Inside <span className="mono">{dir}/</span>
            </div>
          )}
          {options.map((o, i) => (
            <div
              key={o.value}
              data-idx={i}
              role="option"
              aria-selected={i === cursor}
              className={`tp-row ${i === cursor ? 'cur' : ''} ${o.value === value ? 'sel' : ''}`}
              onMouseEnter={() => setCursor(i)}
              onMouseDown={(e) => {
                e.preventDefault() // keep the box focused
                pick(o, false)
              }}
            >
              {o.kind === 'repo' ? <IconBranch size={13} /> : o.kind === 'dir' ? <IconFolder size={13} /> : <IconFile size={13} />}
              <span className="mono tp-name">{o.label}</span>
              <span className="muted small">{o.hint}</span>
              {o.kind !== 'file' && (
                <button
                  type="button"
                  className="link small tp-in"
                  title="Show what is inside"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    pick(o, true)
                  }}
                >
                  open ›
                </button>
              )}
            </div>
          ))}
          {loading && <div className="tp-empty">Looking…</div>}
          {!loading && !options.length && (
            <div className="tp-empty">
              {value
                ? dirs[dir]?.length === 0 && dir
                  ? `There is no folder "${dir}" in this workspace.`
                  : `Nothing here matches "${value}".`
                : 'This workspace is empty. Clone a repo from Repositories, or upload files with the folder button in the chat.'}
            </div>
          )}
          <div className="tp-foot">↑ ↓ to move · Enter to choose · Tab to complete or step into a folder</div>
        </div>
      )}
      {!open && value && !exact && dirs[dir] !== undefined && dirs[dir] !== null && <span className="small lv-error-text">That path isn't in this workspace.</span>}
    </div>
  )
}
