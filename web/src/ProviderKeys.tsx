/**
 * Integrations → Ditto → Provider keys: paste a GM, Engy, Instant, OpenRouter, OpenAI, Anthropic or
 * Google key and press Save. The server hands it to the Ditto CLI, which keeps it in the user's
 * Ditto account (server/src/providerKeys.ts); BitBull and this page never see it again.
 */
import { useEffect, useState } from 'react'
import { api, DittoKeyError, type DittoKeys, type DittoKeySaved } from './api'

type Msg = { ok: boolean; text: string; reconnect?: boolean }

/** "GM", or "GM “work”" for a named key */
function keyName(k: { provider: string; label?: string }, names: Map<string, string>) {
  const name = names.get(k.provider) ?? k.provider
  return k.label ? `${name} “${k.label}”` : name
}

function describe(saved: DittoKeySaved, names: Map<string, string>): Msg {
  const name = keyName(saved.key, names)
  const v = saved.validation
  if (!v) return { ok: true, text: `Saved your ${name} key to Ditto.` }
  if (v.ok) return { ok: true, text: `Saved your ${name} key to Ditto, and ${name} accepted it.` }
  const why = [v.status ? `HTTP ${v.status}` : '', v.error ?? ''].filter(Boolean).join(': ')
  return { ok: false, text: `Saved, but ${name} refused the key${why ? ` (${why})` : ''}. Paste a working one to replace it.` }
}

function failure(e: unknown): Msg {
  if (e instanceof DittoKeyError && e.code === 'provider_keys_not_granted')
    return { ok: false, reconnect: true, text: 'This Ditto connection can’t save keys yet. Reconnect Ditto and approve key access.' }
  if (e instanceof DittoKeyError && e.code === 'provider_key_limit')
    return { ok: false, text: 'Your Ditto plan allows no more keys for this provider. Save under an existing name to replace one, remove one, or upgrade your Ditto plan.' }
  return { ok: false, text: e instanceof Error ? e.message : String(e) }
}

export function ProviderKeys({ onReconnect }: { onReconnect: () => void }) {
  const [data, setData] = useState<DittoKeys | null>(null)
  const [provider, setProvider] = useState('')
  const [key, setKey] = useState('')
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<Msg | null>(null)

  const load = () =>
    api
      .dittoKeys()
      .then((d) => {
        setData(d)
        setProvider((p) => p || d.providers[0]?.id || '')
      })
      .catch((e) => setMsg(failure(e)))
  useEffect(() => {
    void load()
  }, [])

  const run = async (work: () => Promise<Msg | void>) => {
    setBusy(true)
    setMsg(null)
    try {
      const m = await work()
      if (m) setMsg(m)
      await load()
    } catch (e) {
      setMsg(failure(e))
    } finally {
      setBusy(false)
    }
  }

  const save = () =>
    run(async () => {
      const saved = await api.saveDittoKey({ provider, key, ...(label.trim() ? { label: label.trim() } : {}) })
      setKey('')
      setLabel('')
      return describe(saved, names)
    })

  const names = new Map(data?.providers.map((p) => [p.id, p.displayName]))
  const chosen = data?.providers.find((p) => p.id === provider)
  const hasGm = data?.keys.some((k) => k.provider === 'gm' && !k.label)

  return (
    <div className="provider-keys">
      <b className="small">Provider keys</b>
      <p className="muted small">
        Kept in your Ditto account, not in BitBull. Your “bitbull” endpoint uses them first, then Ditto credits. Name a key to
        keep more than one for a provider.
      </p>
      {data && data.keys.length > 0 && (
        <ul className="provider-key-list">
          {data.keys.map((k) => (
            <li key={k.id}>
              <span className="grow">
                {names.get(k.provider) ?? k.provider}
                {k.label ? <span className="muted"> · {k.label}</span> : null}
                <span className={`muted small ${k.configured && k.enabled ? '' : 'off'}`}>{k.configured && k.enabled ? ' on' : ' off'}</span>
              </span>
              <button className="link" disabled={busy} onClick={() => void run(() => api.setDittoKeyEnabled(k.id, !k.enabled).then(() => undefined))}>
                {k.enabled ? 'Turn off' : 'Turn on'}
              </button>
              <button
                className="link"
                disabled={busy}
                onClick={() =>
                  confirm(`Remove your ${keyName(k, names)} key from Ditto?`) &&
                  void run(() => api.removeDittoKey(k.id).then(() => ({ ok: true, text: 'Removed.' })))
                }
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {data && (
        <form
          className="cfg-edit"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <select value={provider} onChange={(e) => setProvider(e.target.value)} aria-label="Provider">
            {data.providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
              </option>
            ))}
          </select>
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={chosen?.keyPrefixHints?.[0] ? `${chosen.keyPrefixHints[0]}…` : 'Paste the key'}
            aria-label="Provider key"
            autoComplete="off"
            spellCheck={false}
          />
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Name (optional)"
            aria-label="Key name"
            maxLength={64}
            autoComplete="off"
            spellCheck={false}
          />
          <button className="btn sm" type="submit" disabled={busy || !key.trim() || !provider}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </form>
      )}
      {data?.saygmKey && !hasGm && (
        <p className="small">
          <button className="link" disabled={busy} onClick={() => void run(async () => describe(await api.saveDittoKey({ provider: 'gm', fromSaygm: true }), names))}>
            Copy BitBull’s SayGM key to Ditto
          </button>
        </p>
      )}
      {msg && (
        <p className={`small ${msg.ok ? '' : 'lv-error-text'}`}>
          {msg.text}{' '}
          {msg.reconnect && (
            <button className="link" onClick={onReconnect}>
              Reconnect Ditto
            </button>
          )}
        </p>
      )}
    </div>
  )
}
