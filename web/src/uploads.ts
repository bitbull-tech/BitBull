import { api } from './api'

/** A local file plus where it goes, relative to the chosen target folder. */
export interface UploadItem {
  file: File
  path: string
}

/** Folders that are rebuilt or fetched, never worth uploading. */
export const SKIP_DIRS = ['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.cache', '.venv', 'venv', '__pycache__', '.pytest_cache', 'target', '.gradle', '.idea', '.vs']
const SKIP_FILES = ['.DS_Store', 'Thumbs.db', 'desktop.ini']

export function filterItems(items: UploadItem[], skipBuild: boolean) {
  return items.filter((it) => {
    const segs = it.path.split('/')
    if (SKIP_FILES.includes(segs[segs.length - 1])) return false
    return !skipBuild || !segs.slice(0, -1).some((s) => SKIP_DIRS.includes(s))
  })
}

/** From <input type=file> (with or without webkitdirectory). */
export function fromInput(list: FileList | null): UploadItem[] {
  return Array.from(list ?? []).map((file) => ({ file, path: file.webkitRelativePath || file.name }))
}

type Entry = FileSystemEntry
const isDir = (e: Entry): e is FileSystemDirectoryEntry => e.isDirectory
const isFile = (e: Entry): e is FileSystemFileEntry => e.isFile

async function walk(entry: Entry, prefix: string, out: UploadItem[]) {
  if (isFile(entry)) {
    const file = await new Promise<File>((res, rej) => entry.file(res, rej))
    out.push({ file, path: prefix + entry.name })
  } else if (isDir(entry)) {
    const reader = entry.createReader()
    // readEntries returns results in chunks; keep reading until empty
    for (;;) {
      const batch = await new Promise<Entry[]>((res, rej) => reader.readEntries(res, rej))
      if (!batch.length) break
      for (const child of batch) await walk(child, `${prefix}${entry.name}/`, out)
    }
  }
}

/** From a drag-and-drop: files and whole folders, keeping folder structure. */
export async function fromDrop(dt: DataTransfer): Promise<{ items: UploadItem[]; folders: string[] }> {
  const entries = Array.from(dt.items)
    .map((i) => (i.kind === 'file' ? i.webkitGetAsEntry?.() : null))
    .filter((e): e is Entry => !!e)
  if (!entries.length) return { items: fromInput(dt.files), folders: [] }
  const items: UploadItem[] = []
  for (const e of entries) await walk(e, '', items)
  return { items, folders: entries.filter(isDir).map((e) => e.name) }
}

export const hasFolder = (dt: DataTransfer) =>
  Array.from(dt.items).some((i) => i.kind === 'file' && i.webkitGetAsEntry?.()?.isDirectory)

/** Upload in small batches so big folders don't hit request limits; reports progress. */
export async function uploadItems(
  projectId: string,
  items: UploadItem[],
  opts: { target: string; overwrite?: boolean; onProgress?: (done: number, total: number) => void },
) {
  const total = items.length
  let done = 0
  const saved: string[] = []
  const skipped: string[] = []
  let batch: UploadItem[] = []
  let bytes = 0
  const flush = async () => {
    if (!batch.length) return
    const r = await api.uploadProjectFiles(projectId, batch, opts.target, !!opts.overwrite)
    saved.push(...r.saved)
    skipped.push(...r.skipped)
    done += batch.length
    opts.onProgress?.(done, total)
    batch = []
    bytes = 0
  }
  for (const it of items) {
    if (batch.length >= 50 || (bytes + it.file.size > 40 * 1024 * 1024 && batch.length)) await flush()
    batch.push(it)
    bytes += it.file.size
  }
  await flush()
  return { saved, skipped }
}

export const fmtBytes = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`
