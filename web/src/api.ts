export type EngineId = 'opencode' | 'claude'

export interface Session {
  id: string
  title: string
  engine: EngineId
  model: string
  engine_session_id: string | null
  created_at: number
  updated_at: number
}

export interface ToolCall {
  id: string
  name: string
  input?: unknown
  output?: string
  isError?: boolean
  done?: boolean
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
}

export interface AppConfig {
  engines: { id: EngineId; label: string }[]
  defaultEngine: EngineId
  defaultModel: string
  ditto: { enabled: boolean; archive: string }
}

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_start'; id: string; name: string; input?: unknown }
  | { type: 'tool_end'; id: string; output?: string; isError?: boolean }
  | { type: 'done'; engineSessionId: string; usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number }; messageId?: string }
  | { type: 'error'; message: string }

const TOKEN_KEY = 'gm-agent-token'
export const getToken = () => {
  try { return localStorage.getItem(TOKEN_KEY) ?? '' } catch { return '' }
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
  sessions: () => req<{ sessions: Session[] }>('/api/sessions'),
  session: (id: string) => req<{ session: Session; messages: Message[]; running: boolean }>(`/api/sessions/${id}`),
  createSession: (engine: EngineId, model: string) =>
    req<{ session: Session }>('/api/sessions', { method: 'POST', body: JSON.stringify({ engine, model }) }),
  deleteSession: (id: string) => req(`/api/sessions/${id}`, { method: 'DELETE' }),
  renameSession: (id: string, title: string) =>
    req(`/api/sessions/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  abort: (id: string) => req(`/api/sessions/${id}/abort`, { method: 'POST' }),
  skills: () => req<{ skills: { name: string; description: string }[] }>('/api/skills'),
  syncSkills: () => req<{ skills: { name: string }[] }>('/api/skills/sync', { method: 'POST' }),

  /** POST + read the SSE stream manually (EventSource can't POST). */
  async send(id: string, message: string, model: string, onEvent: (e: AgentEvent) => void) {
    const res = await fetch(`/api/sessions/${id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${getToken()}` },
      body: JSON.stringify({ message, model }),
    })
    if (res.status === 401) throw new Unauthorized('unauthorized')
    if (!res.ok || !res.body) throw new Error(`${res.status} ${await res.text()}`)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let i: number
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i)
        buf = buf.slice(i + 2)
        const data = chunk
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n')
        if (data) onEvent(JSON.parse(data) as AgentEvent)
      }
    }
  },
}
