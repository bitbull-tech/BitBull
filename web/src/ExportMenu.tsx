import { useEffect, useRef, useState } from 'react'
import { api, type Session } from './api'
import { reportLocal } from './activity'
import { IconCopy } from './icons'

/**
 * Export the open chat: transcript, tool calls and its activity log, with secrets redacted.
 * "Copy for another agent" puts Markdown on the clipboard, ready to paste into Claude, ChatGPT,
 * Codex or another GM chat for a second opinion or debugging.
 */
export function ExportMenu({ session }: { session: Session }) {
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const flash = (t: string) => {
    setNote(t)
    setTimeout(() => setNote(null), 2500)
  }
  const fileName = (ext: string) =>
    `gm-chat-${session.title.replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || session.id.slice(0, 8)}.${ext}`
  const download = (text: string, ext: string, type: string) => {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([text], { type }))
    a.download = fileName(ext)
    a.click()
    URL.revokeObjectURL(a.href)
  }
  const run = async (fn: () => Promise<void>) => {
    setOpen(false)
    try {
      await fn()
    } catch (e) {
      reportLocal(`Export failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return (
    <div className="export-menu" ref={ref}>
      <button className="btn files-btn" onClick={() => setOpen((o) => !o)} title="Export this chat for another agent or for your records">
        <IconCopy size={14} /> {note ?? 'Export'}
      </button>
      {open && (
        <div className="row-menu export-pop">
          <button
            onClick={() =>
              run(async () => {
                const md = await api.exportChat(session.id, 'md')
                await navigator.clipboard.writeText(md)
                flash(`Copied ${Math.max(1, Math.round(md.length / 1024))} KB`)
              })
            }
          >
            <b>Copy for another agent</b>
            <small>Transcript, tool calls and activity log as Markdown</small>
          </button>
          <button
            onClick={() =>
              run(async () => {
                const md = await api.exportChat(session.id, 'md', { tools: false, activity: false })
                await navigator.clipboard.writeText(md)
                flash('Copied')
              })
            }
          >
            <b>Copy conversation only</b>
            <small>Just the messages, no tool calls or log</small>
          </button>
          <div className="menu-sep" />
          <button onClick={() => run(async () => download(await api.exportChat(session.id, 'md'), 'md', 'text/markdown'))}>
            <b>Download Markdown</b>
          </button>
          <button onClick={() => run(async () => download(await api.exportChat(session.id, 'json'), 'json', 'application/json'))}>
            <b>Download JSON</b>
            <small>Everything, untruncated, for tools and scripts</small>
          </button>
          <p className="muted small export-foot">API keys and tokens are replaced with [REDACTED].</p>
        </div>
      )}
    </div>
  )
}
