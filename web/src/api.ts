export type EngineId = 'opencode' | 'claude'

export interface Session {
  id: string
  title: string
  engine: EngineId
  model: string
  engine_session_id: string | null
  project_id: string | null
  created_at: number
  updated_at: number
}

export type IntegrationId = 'atlas' | 'four04' | 'github'

export interface Project {
  id: string
  name: string
  description: string
  instructions: string
  color: string
  integrations: IntegrationId[]
  workspace: string
  /** Ditto is kept current for this project: seeded from its uploads, agent saves durable facts */
  dittoSync: boolean
  dittoSyncedAt: number | null
  created_at: number
  updated_at: number
}

export interface ProjectInput {
  name: string
  description?: string
  instructions?: string
  color?: string
  integrations?: IntegrationId[]
  dittoSync?: boolean
}

export interface IntegrationInfo {
  id: IntegrationId
  name: string
  blurb: string
  docs: string
  notes?: string
  configured: boolean
  hasMcp: boolean
  global?: boolean
  env: { key: string; label: string; set: boolean; value: string }[]
}
export interface IntegrationStatus {
  id: IntegrationId
  ok: boolean
  configured: boolean
  detail: string
  tools?: string[]
}

export interface ToolCall {
  id: string
  name: string
  input?: unknown
  output?: string
  isError?: boolean
  done?: boolean
  /** Set on tool calls a subagent made: the id of its task call */
  parent?: string
}

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  model: string | null
  tools_json: string | null
  usage_json: string | null
  created_at: number
}

export interface Model {
  id: string
  name: string
  family: 'anthropic' | 'openai' | 'google' | 'open' | 'other'
  api: 'anthropic' | 'responses' | 'google' | 'chat'
  provider?: string
  tier?: string
  confidential?: boolean
  vision?: boolean
  tools?: boolean
  contextLength?: number
  price?: { input: number; output: number; cacheRead?: number }
  retail?: { input: number; output: number }
  savingsPct?: number
}

/** A model plus the gateway's own record, from GET /api/models/:id (the Models view). */
export interface ModelDetail extends Model {
  raw?: Record<string, unknown>
}

export interface SettingRow {
  env: string
  label: string
  value: string
  secret?: boolean
  isDefault: boolean
  hint?: string
  editable?: boolean
  source?: 'ui' | 'vault' | 'env' | 'default'
  options?: string[]
}
export interface SettingGroup {
  id: string
  title: string
  rows: SettingRow[]
}
export interface FileEntry {
  name: string
  dir: boolean
  size: number
  mtime: number
}
export interface StoredFile {
  id: string
  project_id: string | null
  project_name: string | null
  rel_path: string
  key: string
  size: number
  sha256: string | null
  status: 'pending' | 'stored' | 'failed'
  error: string | null
  created_at: number
  stored_at: number | null
}

export interface Status {
  saygm: { ok: boolean; models?: number; ms?: number; error?: string }
  ditto: { ok: boolean; tools?: number; error?: string }
  storage?: { ok: boolean; configured: boolean; detail: string; stored?: number; pending?: number; failed?: number; bytes?: number }
  skills: { name: string; description: string }[]
  subagents?: { name: string; description: string; access: 'read' | 'write'; model: string }[]
  workspace: string
  sandbox?: { kind: string; shell: boolean; egress?: 'allowlist' | 'open' }
  systemPromptFound: boolean
  node: string
}
export interface Uploaded {
  name: string
  path: string
  size: number
}

export interface AppConfig {
  engines: { id: EngineId; label: string }[]
  defaultEngine: EngineId
  defaultModel: string
  ditto: { enabled: boolean; archive: string }
}

export type TurnStatus = 'running' | 'done' | 'error' | 'aborted' | 'interrupted'

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_start'; id: string; name: string; input?: unknown; parent?: string }
  | { type: 'tool_end'; id: string; output?: string; isError?: boolean }
  | { type: 'done'; engineSessionId: string; usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number }; messageId?: string }
  | { type: 'error'; message: string }
  /** The stream ended because the turn did — not because the connection dropped. */
  | { type: 'end'; status: TurnStatus; seq: number }

const TOKEN_KEY = 'bitbob-token'
export interface NetworkRequest {
  id: string
  host: string
  domain: string
  reason: string
  sessionId?: string
  sessionTitle?: string
  status: 'pending' | 'approved' | 'denied' | 'expired'
  createdAt: string
  decidedAt?: string
  scope?: 'host' | 'domain'
}
export interface LinkedFolder {
  name: string
  path: string
  entries: number | null
  readOnly: boolean
  noExec: boolean
}
export interface RepoBranch {
  name: string
  current: boolean
  remote: boolean
  upstream?: string
  ahead?: number
  behind?: number
  last?: string
}
export interface Swarm {
  id: string
  sessionId: string
  projectId: string | null
  target: string
  focus: ('attack-vectors' | 'correctness' | 'code-quality' | 'performance' | 'user-experience')[]
  primaryModel: string
  reviewers: { model: string; sessionId: string; status: 'pending' | 'reviewing' | 'challenging' | 'done' | 'error'; error?: string; hasReport: boolean; hasRebuttal: boolean }[]
  phase: 'review' | 'challenge' | 'final' | 'done' | 'error'
  finalTurnId?: string
  startedAt: number
  finishedAt?: number
  error?: string
}

export interface RepoInfo {
  path: string
  name: string
  branch: string | null
  detached: boolean
  ahead: number
  behind: number
  upstream: string | null
  changed: number
  untracked: number
  staged: number
  conflicts: number
  remote: string | null
  head: { sha: string; subject: string; author: string; when: string } | null
  branches: RepoBranch[]
  stashes: number
  error?: string
}
export interface NetworkState {
  proxied: boolean
  allowlist: string[]
  approved: { host: string; scope: 'host' | 'domain'; approvedAt: string; reason?: string }[]
  requests: NetworkRequest[]
  blocked: { host: string; count: number; firstAt: string; lastAt: string }[]
}

export const getToken = () => {
  try { return localStorage.getItem(TOKEN_KEY) ?? '' } catch { return '' }
}
export const clearToken = () => {
  try { localStorage.removeItem(TOKEN_KEY) } catch { /* ignore */ }
}
export const setToken = (t: string) => {
  try { localStorage.setItem(TOKEN_KEY, t) } catch { /* ignore */ }
}

export class Unauthorized extends Error {}

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${getToken()}`, ...(init.headers ?? {}) },
  })
  if (res.status === 401) throw new Unauthorized('unauthorized')
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return res.json() as Promise<T>
}

export const api = {
  config: () => req<AppConfig>('/api/config'),
  models: (refresh = false) => req<{ models: Model[] }>(`/api/models${refresh ? '?refresh=1' : ''}`),
  model: (id: string) => req<{ model: ModelDetail }>(`/api/models/${encodeURIComponent(id)}`),
  sessions: () => req<{ sessions: Session[] }>('/api/sessions'),
  session: (id: string) =>
    req<{ session: Session; messages: Message[]; running: boolean; turnId: string | null }>(`/api/sessions/${id}`),
  createSession: (engine: EngineId, model: string, projectId?: string | null) =>
    req<{ session: Session }>('/api/sessions', { method: 'POST', body: JSON.stringify({ engine, model, projectId }) }),
  moveSession: (id: string, projectId: string | null) =>
    req<{ session: Session }>(`/api/sessions/${id}`, { method: 'PATCH', body: JSON.stringify({ projectId }) }),
  projects: () => req<{ projects: Project[] }>('/api/projects'),
  createProject: (p: ProjectInput) => req<{ project: Project }>('/api/projects', { method: 'POST', body: JSON.stringify(p) }),
  dittoSyncNow: (id: string) => req<{ sessionId: string; turnId: string }>(`/api/projects/${id}/ditto-sync`, { method: 'POST' }),
  updateProject: (id: string, p: Partial<ProjectInput>) =>
    req<{ project: Project }>(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(p) }),
  deleteProject: (id: string) => req(`/api/projects/${id}`, { method: 'DELETE' }),
  integrations: () =>
    req<{ integrations: IntegrationInfo[]; atlasWorkflows: { file: string; title: string; inputs: string[] }[]; likenessPolicy: string }>('/api/integrations'),
  integrationStatus: () => req<{ integrations: IntegrationStatus[] }>('/api/integrations/status'),
  deleteSession: (id: string) => req(`/api/sessions/${id}`, { method: 'DELETE' }),
  renameSession: (id: string, title: string) =>
    req(`/api/sessions/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  abort: (id: string) => req(`/api/sessions/${id}/abort`, { method: 'POST' }),
  skills: () => req<{ skills: { name: string; description: string }[] }>('/api/skills'),
  syncSkills: () => req<{ skills: { name: string }[] }>('/api/skills/sync', { method: 'POST' }),

  settings: () => req<{ groups: SettingGroup[] }>('/api/settings'),
  /** null or '' clears the UI value so .env applies again */
  updateSettings: (values: Record<string, string | null>) =>
    req<{ changed: string[]; groups: SettingGroup[] }>('/api/settings', { method: 'PUT', body: JSON.stringify({ values }) }),
  status: () => req<Status>('/api/status'),
  network: () => req<NetworkState>('/api/network'),
  links: () => req<{ available: boolean; links: LinkedFolder[] }>('/api/links'),
  vault: () => req<{ unlocked: boolean; exists: boolean; keys: string[]; file: string }>('/api/vault'),
  vaultUnlock: (key: string) => req<{ unlocked: boolean; keys: string[]; moved: string[] }>('/api/vault/unlock', { method: 'POST', body: JSON.stringify({ key }) }),
  vaultLock: () => req<{ unlocked: boolean }>('/api/vault/lock', { method: 'POST' }),
  repos: (projectId: string) => req<{ repos: RepoInfo[] }>(`/api/projects/${projectId}/repos`),
  startSwarm: (body: { sessionId: string; target: string; models: string[]; focus: Swarm['focus'] }) =>
    req<{ swarm: Swarm }>('/api/swarm', { method: 'POST', body: JSON.stringify(body) }),
  swarm: (id: string) => req<{ swarm: Swarm }>(`/api/swarm/${id}`),
  swarms: (sessionId: string) => req<{ swarms: Swarm[] }>(`/api/swarm?sessionId=${encodeURIComponent(sessionId)}`),
  repoDiff: (projectId: string, repo: string, base?: string) =>
    req<{ stat: string }>(`/api/projects/${projectId}/repos/diff?repo=${encodeURIComponent(repo)}${base ? `&base=${encodeURIComponent(base)}` : ''}`),
  decideNetwork: (id: string, decision: 'host' | 'domain' | 'deny') =>
    req<NetworkState>(`/api/network/requests/${id}`, { method: 'POST', body: JSON.stringify({ decision }) }),
  allowNetwork: (host: string, scope: 'host' | 'domain') =>
    req<NetworkState>('/api/network/approved', { method: 'POST', body: JSON.stringify({ host, scope }) }),
  revokeNetwork: (host: string, scope: 'host' | 'domain') =>
    req<NetworkState>(`/api/network/approved/${encodeURIComponent(host)}?scope=${scope}`, { method: 'DELETE' }),
  refreshModels: () => req<{ models: Model[] }>('/api/models/refresh', { method: 'POST' }),
  async upload(id: string, files: File[]): Promise<Uploaded[]> {
    const fd = new FormData()
    for (const f of files) fd.append('file', f)
    const res = await fetch(`/api/sessions/${id}/files`, { method: 'POST', headers: { authorization: `Bearer ${getToken()}` }, body: fd })
    if (res.status === 401) throw new Unauthorized('unauthorized')
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Upload failed (${res.status})`)
    return (await res.json()).files
  },

  /** Add files/folders to a project's workspace ("general" = the workspace for unfiled chats). */
  async uploadProjectFiles(projectId: string, items: { file: File; path: string }[], target: string, overwrite = false) {
    const fd = new FormData()
    for (const it of items) {
      fd.append('file', it.file)
      fd.append('path', it.path)
    }
    fd.append('target', target)
    if (overwrite) fd.append('overwrite', '1')
    const res = await fetch(`/api/projects/${projectId}/files`, { method: 'POST', headers: { authorization: `Bearer ${getToken()}` }, body: fd })
    if (res.status === 401) throw new Unauthorized('unauthorized')
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Upload failed (${res.status})`)
    return (await res.json()) as { saved: string[]; skipped: string[] }
  },
  /** Files mirrored to Hippius for a project ("general" = the unfiled workspace) */
  storedFiles: (projectId: string) => req<{ files: StoredFile[]; enabled: boolean }>(`/api/projects/${projectId}/stored`),
  restoreStored: (id: string) => req<{ path: string; verified: boolean }>(`/api/stored/${id}/restore`, { method: 'POST' }),
  retryStored: (id: string) => req<{ ok: boolean }>(`/api/stored/${id}/retry`, { method: 'POST' }),
  newStorageKey: () => req<{ key: string }>('/api/storage/key', { method: 'POST' }),

  projectFiles: (projectId: string, dir = '') =>
    req<{ dir: string; entries: FileEntry[]; container: string; host: string | null }>(`/api/projects/${projectId}/files?dir=${encodeURIComponent(dir)}`),

  /** Chat export for pasting into another agent: format md (default) or json */
  async exportChat(id: string, format: 'md' | 'json' = 'md', opts: { tools?: boolean; activity?: boolean; exchange?: string; compact?: boolean } = {}) {
    const q = new URLSearchParams({ format, tools: opts.tools === false ? '0' : '1', activity: opts.activity === false ? '0' : '1', ...(opts.exchange ? { exchange: opts.exchange } : {}), ...(opts.compact ? { compact: '1' } : {}) })
    const res = await fetch(`/api/sessions/${id}/export?${q}`, { headers: { authorization: `Bearer ${getToken()}` } })
    if (res.status === 401) throw new Unauthorized('unauthorized')
    if (!res.ok) throw new Error(`Export failed (${res.status})`)
    return res.text()
  },

  /** Start a turn without streaming it; follow it with `follow()`. */
  startTurn: (id: string, message: string, model: string, attachments: string[] = [], plan = false) =>
    req<{ turnId: string; sessionId: string }>(`/api/sessions/${id}/messages?stream=0`, {
      method: 'POST',
      body: JSON.stringify({ message, model, attachments, plan }),
    }),

  /**
   * Attach to a turn's event stream from `from` (the last sequence number we have) and
   * read it until it ends. Resolves `{ended:true}` when the *turn* finished and
   * `{ended:false}` when the connection did — the caller re-attaches in that case.
   */
  async follow(
    id: string,
    turnId: string,
    from: number,
    onEvent: (e: AgentEvent, seq: number) => void,
    signal?: AbortSignal,
  ): Promise<{ ended: boolean; seq: number }> {
    const q = new URLSearchParams({ turnId, from: String(from) })
    const res = await fetch(`/api/sessions/${id}/stream?${q}`, { headers: { authorization: `Bearer ${getToken()}` }, signal })
    if (res.status === 401) throw new Unauthorized('unauthorized')
    if (!res.ok || !res.body) throw new Error(`${res.status} ${await res.text()}`)
    return readEvents(res.body, from, onEvent)
  },

  /**
   * Follow a turn to its end, re-attaching where we left off if the connection drops
   * (sleep, tunnel blip, flaky mobile data). The turn keeps running on the server either way.
   */
  async followUntilDone(
    id: string,
    turnId: string,
    from: number,
    onEvent: (e: AgentEvent, seq: number) => void,
    signal?: AbortSignal,
  ): Promise<number> {
    let seq = from
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await api.follow(id, turnId, seq, (e, s) => { seq = Math.max(seq, s); onEvent(e, s) }, signal)
        if (r.ended) return seq
      } catch (e) {
        if (signal?.aborted) return seq
        if (e instanceof Unauthorized || attempt >= 5) throw e
      }
      if (signal?.aborted) return seq
      if (attempt >= 5) throw new Error('Lost the connection to this turn. It may still be running: reopen the chat to catch up.')
      await new Promise((r) => setTimeout(r, Math.min(8000, 500 * 2 ** attempt)))
    }
  },

  /** Start a turn and follow it to the end. */
  async run(
    id: string,
    input: { message: string; model: string; attachments?: string[]; plan?: boolean },
    onEvent: (e: AgentEvent, seq: number) => void,
    opts: { signal?: AbortSignal; onTurn?: (turnId: string) => void } = {},
  ) {
    const { turnId } = await api.startTurn(id, input.message, input.model, input.attachments ?? [], input.plan ?? false)
    opts.onTurn?.(turnId)
    await api.followUntilDone(id, turnId, 0, onEvent, opts.signal)
  },
}

/** Reads an SSE body: `id:` carries the sequence number, `data:` the event JSON. */
async function readEvents(
  body: ReadableStream<Uint8Array>,
  from: number,
  onEvent: (e: AgentEvent, seq: number) => void,
): Promise<{ ended: boolean; seq: number }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let seq = from
  let ended = false
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let i: number
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i)
      buf = buf.slice(i + 2)
      let data = ''
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data:')) data += (data ? '\n' : '') + line.slice(5).trimStart()
        else if (line.startsWith('id:')) seq = Number(line.slice(3).trim()) || seq
      }
      if (!data) continue // heartbeat
      const ev = JSON.parse(data) as AgentEvent
      if (ev.type === 'end') {
        ended = true
        continue
      }
      onEvent(ev, seq)
    }
  }
  return { ended, seq }
}
