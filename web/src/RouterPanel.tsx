/**
 * Configuration → Background work: where titles, compaction and other housekeeping run. SayGM's
 * small model by default; Ditto Router when chosen here, on a model picked from the Router's own
 * list (live, from your Router key). Chats are never moved.
 */
import { useEffect, useMemo, useState } from 'react'
import { api, type RouterModel, type SettingGroup } from './api'
import { IconCheck, IconRefresh } from './icons'

type Info = Awaited<ReturnType<typeof api.routerModels>>

export function RouterPanel({ smallModel, onSaved }: { smallModel: string; onSaved: (groups: SettingGroup[], text: string) => void }) {
  const [info, setInfo] = useState<Info | null>(null)
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState('')
  const [msg, setMsg] = useState<string | null>(null)

  const load = (refresh = false) => {
    setBusy(true)
    void api
      .routerModels(refresh)
      .then(setInfo)
      .catch((e) => setMsg(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }
  useEffect(() => load(), [])

  const save = async (values: Record<string, string>, text: string) => {
    setMsg(null)
    try {
      const r = await api.updateSettings(values)
      onSaved(r.groups, text)
      load()
    } catch (e) {
      setMsg(e instanceof Error ? e.message.replace(/^\d+ /, '') : String(e))
    }
  }

  const models = useMemo(() => {
    const f = filter.trim().toLowerCase()
    const list = (info?.models ?? []).filter((m) => !f || m.id.toLowerCase().includes(f) || m.name.toLowerCase().includes(f))
    // cheapest first: this is for housekeeping
    return [...list].sort((a, b) => (a.price ? a.price.input + a.price.output : 1e9) - (b.price ? b.price.input + b.price.output : 1e9))
  }, [info, filter])

  const via = info?.background ?? 'saygm'
  const price = (m: RouterModel) => (m.price ? `$${m.price.input} / $${m.price.output}` : '—')

  return (
    <section className="cfg-group router-panel">
      <h3>Background work</h3>
      <p className="muted small">
        Titles, compaction and the other housekeeping the OpenCode engine does on its small model. Chats, subagents and QA Hound always stay on
        SayGM. Ditto Router needs a Router key under Integrations → Ditto.
      </p>
      <div className="seg" role="radiogroup" aria-label="Background work runs on">
        <button type="button" className={via === 'saygm' ? 'on' : ''} onClick={() => void save({ BACKGROUND_VIA: 'saygm' }, 'Background work runs on SayGM')}>
          SayGM · {smallModel}
        </button>
        <button
          type="button"
          className={via === 'ditto-router' ? 'on' : ''}
          disabled={!info?.configured}
          title={info?.configured ? undefined : 'Add a Ditto Router key under Integrations → Ditto first'}
          onClick={() => void save({ BACKGROUND_VIA: 'ditto-router' }, 'Background work runs on Ditto Router')}
        >
          Ditto Router{info?.model ? ` · ${info.model}` : ''}
        </button>
      </div>
      {via === 'ditto-router' && info && !info.active && (
        <p className="small warn-line">Ditto Router is chosen but {info.configured ? 'no model is picked below' : 'there is no Router key'}, so background work stays on SayGM.</p>
      )}
      {msg && <p className="error small">{msg}</p>}

      {info?.configured && (
        <div className="router-models">
          <div className="router-models-head">
            <b>Models on Ditto Router</b>
            <span className="muted small">{info.models.length} available · price per million tokens, in / out</span>
            <span className="grow" />
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter" />
            <button className="icon-btn sm" title="Fetch the list again" disabled={busy} onClick={() => load(true)}>
              <IconRefresh size={13} />
            </button>
          </div>
          {info.error && <p className="error small">{info.error}</p>}
          <div className="router-list">
            {models.map((m) => (
              <div key={m.id} className={`router-row ${m.id === info.model ? 'on' : ''}`}>
                <div className="grow">
                  <div>{m.name}</div>
                  <code className="muted">{m.id}</code>
                </div>
                <span className="muted small">{m.contextLength ? `${Math.round(m.contextLength / 1000)}k ctx` : ''}</span>
                <span className="small router-price">{price(m)}</span>
                {m.id === info.model ? (
                  <span className="advisor-using">
                    <IconCheck size={13} /> Background
                  </span>
                ) : (
                  <button className="btn sm" onClick={() => void save({ DITTO_ROUTER_MODEL: m.id }, `Background model on Ditto Router: ${m.id}`)}>
                    Use
                  </button>
                )}
              </div>
            ))}
            {!models.length && !info.error && <p className="muted small pad">{busy ? 'Loading…' : 'No models match.'}</p>}
          </div>
        </div>
      )}
    </section>
  )
}
