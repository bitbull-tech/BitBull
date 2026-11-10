import { useEffect, useState } from 'react'
import { api, type IntegrationId, type IntegrationInfo, type Project, type ProjectInput } from './api'
import { IconCheck, IconTrash, IconX } from './icons'

export const PROJECT_COLORS = ['indigo', 'teal', 'amber', 'rose', 'sky', 'violet', 'lime', 'slate'] as const

export function ProjectDialog({
  project,
  onClose,
  onSaved,
  onDeleted,
}: {
  project: Project | null
  onClose: () => void
  onSaved: (p: Project) => void
  onDeleted: (id: string) => void
}) {
  const [form, setForm] = useState<ProjectInput>({
    name: project?.name ?? '',
    description: project?.description ?? '',
    instructions: project?.instructions ?? '',
    color: project?.color ?? 'indigo',
    integrations: project?.integrations ?? [],
    dittoSync: project?.dittoSync ?? false,
  })
  const [available, setAvailable] = useState<IntegrationInfo[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void api.integrations().then((r) => setAvailable(r.integrations)).catch(() => {})
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const toggle = (id: IntegrationId) =>
    setForm((f) => {
      const cur = f.integrations ?? []
      return { ...f, integrations: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] }
    })

  const save = async () => {
    if (!form.name.trim()) return setError('Give the project a name')
    setSaving(true)
    setError(null)
    try {
      const r = project ? await api.updateProject(project.id, form) : await api.createProject(form)
      onSaved(r.project)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal narrow" role="dialog" aria-label={project ? 'Edit project' : 'New project'}>
        <header className="modal-head">
          <h2>{project ? 'Project settings' : 'New project'}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <IconX />
          </button>
        </header>
        <form
          className="modal-body form"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <label>
            <span>Name</span>
            <input autoFocus value={form.name} maxLength={80} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Subnet 59 miner" />
          </label>
          <div className="field">
            <span>Colour</span>
            <div className="swatches">
              {PROJECT_COLORS.map((c) => (
                <button
                  type="button"
                  key={c}
                  className={`swatch pc-${c} ${form.color === c ? 'on' : ''}`}
                  onClick={() => setForm({ ...form, color: c })}
                  aria-label={c}
                >
                  {form.color === c && <IconCheck size={13} />}
                </button>
              ))}
            </div>
          </div>
          <label>
            <span>Description</span>
            <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="What this project is about" />
          </label>
          <label>
            <span>Instructions for the agent</span>
            <textarea
              rows={6}
              value={form.instructions}
              onChange={(e) => setForm({ ...form, instructions: e.target.value })}
              placeholder={'Applied to every chat in this project: what it is for, style and language, rules, where the sources live…'}
            />
          </label>
          <div className="field">
            <span>Integrations for this project</span>
            <div className="int-list">
              {available.filter((i) => !i.global).map((i) => (
                <label key={i.id} className={`int-row ${i.configured ? '' : 'off'}`}>
                  <input type="checkbox" checked={form.integrations?.includes(i.id) ?? false} onChange={() => toggle(i.id)} />
                  <div>
                    <b>{i.name}</b>
                    <small>{i.configured ? (i.hasMcp ? 'Configured · MCP tools available' : 'Configured') : 'Not configured yet: add keys in .env (see Settings → Integrations)'}</small>
                  </div>
                </label>
              ))}
              {available
                .filter((i) => i.global)
                .map((i) => (
                  <label key={i.id} className={`int-row ${i.configured ? '' : 'off'}`} title="Global: configured once in .env, available in every project">
                    <input type="checkbox" checked={i.configured} disabled />
                    <div>
                      <b>{i.name}</b>
                      <small>{i.configured ? 'On for every project (keys in .env)' : 'Not configured: add keys in .env (see Settings → Integrations)'}</small>
                    </div>
                  </label>
                ))}
            </div>
          </div>
          <div className="field">
            <span>Memory</span>
            <label className="int-row">
              <input type="checkbox" checked={!!form.dittoSync} onChange={(e) => setForm({ ...form, dittoSync: e.target.checked })} />
              <div>
                <b>Ditto sync</b>
                <small>
                  Ditto is this project's record: seeded from its imported docs and memory (right-click the project → Sync to Ditto now), and the agent saves
                  durable facts and decisions after every turn.{project?.dittoSyncedAt ? ` Last sync ${new Date(project.dittoSyncedAt).toLocaleString()}.` : ''}
                </small>
              </div>
            </label>
          </div>
          {project && <p className="muted small">Workspace: <code>{project.workspace}</code></p>}
          {error && <p className="error">{error}</p>}
          <div className="form-actions">
            {project && (
              <button
                type="button"
                className="btn danger"
                onClick={async () => {
                  if (!confirm(`Delete project “${project.name}”? Its chats move to Chats and its files stay on disk.`)) return
                  await api.deleteProject(project.id)
                  onDeleted(project.id)
                }}
              >
                <IconTrash size={14} /> Delete project
              </button>
            )}
            <span className="grow" />
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn primary" disabled={saving}>{saving ? 'Saving…' : project ? 'Save' : 'Create project'}</button>
          </div>
        </form>
      </div>
    </div>
  )
}
