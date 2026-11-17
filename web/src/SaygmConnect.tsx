/**
 * Connect with SayGM (server/src/saygmConnect.ts): sign in, or sign up, on saygm.com and BitBull
 * gets a key of its own on that account. Nothing is copied or pasted, and you choose a monthly
 * spending limit for BitBull on SayGM's page. The server keeps the key; this panel only ever
 * sees whether it is connected and as whom.
 */
import { useEffect, useState } from 'react'
import { api, type SaygmConnectState } from './api'
import { LinkFallback } from './LinkFallback'

const clean = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^\d+ /, '').replace(/^\{"error":"(.*)"\}$/, '$1')

export function SaygmConnect({ onConnected, onState, compact }: { onConnected?: () => void; onState?: (s: SaygmConnectState) => void; compact?: boolean }) {
  const [s, setS] = useState<SaygmConnectState | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const take = (next: SaygmConnectState) => {
    if (next.connected && s && !s.connected) {
      setMsg({ ok: true, text: `Connected${next.email ? ` as ${next.email}` : ''}.` })
      onConnected?.()
    }
    setS(next)
    onState?.(next)
  }
  // while a sign-in is waiting, watch for the browser coming back
  const waiting = !!s?.pending
  useEffect(() => {
    const load = () => void api.saygmConnectState().then(take).catch(() => {})
    load()
    const t = window.setInterval(load, waiting ? 2000 : 20000)
    return () => window.clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting, s?.connected])

  if (!s) return null

  const connect = async () => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await api.saygmConnect(window.location.origin)
      take(r)
      // open SayGM's page; the address is also on screen in case the browser blocks it
      if (r.pending) window.open(r.pending.url, '_blank', 'noopener,noreferrer')
    } catch (e) {
      setMsg({ ok: false, text: clean(e) })
    } finally {
      setBusy(false)
    }
  }
  const disconnect = async () => {
    if (!window.confirm('Disconnect SayGM? BitBull is removed from your SayGM account and its key stops working, so no model will answer until you connect again or paste a key.')) return
    setBusy(true)
    setMsg(null)
    try {
      const r = await api.saygmDisconnect()
      take(r)
      setMsg({ ok: !r.note, text: r.note ?? 'Disconnected.' })
    } catch (e) {
      setMsg({ ok: false, text: clean(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="lp-connect">
      {s.connected && (
        <>
          <p className="small">
            Connected with SayGM{s.email ? (
              <>
                {' '}
                as <b>{s.email}</b>
              </>
            ) : null}
            . BitBull has its own key on that account; change its monthly limit or remove it under{' '}
            <a href={s.manageUrl} target="_blank" rel="noreferrer">
              Connected apps
            </a>{' '}
            on SayGM.
          </p>
          {!compact && (
            <div className="row-actions">
              <button className="btn sm" disabled={busy} onClick={() => void disconnect()}>
                Disconnect
              </button>
            </div>
          )}
        </>
      )}

      {!s.connected && !s.pending && s.available && (
        <>
          <p className="small">
            Sign in with your SayGM account, or create one on the same page. No key to copy: BitBull gets its own, and you set how much it may spend each month.
          </p>
          <div className="row-actions">
            <button className="btn sm primary" disabled={busy} onClick={() => void connect()}>
              Connect with SayGM
            </button>
          </div>
        </>
      )}

      {s.pending && (
        <div className="lp-pending">
          <p className="small">
            <a href={s.pending.url} target="_blank" rel="noreferrer">
              Approve BitBull on SayGM
            </a>
            . When you have, the browser comes back to BitBull and this updates by itself.
          </p>
          <LinkFallback url={s.pending.url} what="SayGM" />
        </div>
      )}

      {!s.connected && !s.pending && s.error && <p className="small lv-error-text">{s.error}</p>}
      {msg && <p className={`small ${msg.ok ? 'muted' : 'lv-error-text'}`}>{msg.text}</p>}
    </div>
  )
}
