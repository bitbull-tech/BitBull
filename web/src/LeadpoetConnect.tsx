/**
 * Integrations → Leadpoet (server/src/leadpoet.ts): sign in with your Leadpoet account, no key.
 * You choose what BitBull may do there before you connect, and Leadpoet enforces it. The server
 * keeps the sign-in; this panel only ever sees whether it is connected and with what access.
 */
import { useEffect, useState } from 'react'
import { api, type LeadpoetState } from './api'
import { LinkFallback } from './LinkFallback'

const clean = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^\d+ /, '').replace(/^\{"error":"(.*)"\}$/, '$1')

export function LeadpoetConnect({ onState, onChanged }: { onState: (s: LeadpoetState) => void; onChanged: () => void }) {
  const [s, setS] = useState<LeadpoetState | null>(null)
  const [access, setAccess] = useState<'read' | 'edit'>('edit')
  const [send, setSend] = useState(false)
  const [pasted, setPasted] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const take = (next: LeadpoetState) => {
    if (next.connected && s && !s.connected) {
      setMsg({ ok: true, text: 'Connected. Switch Leadpoet on in the project you run campaigns from.' })
      onChanged()
    }
    setS(next)
    onState(next)
  }
  // while a sign-in is waiting, watch for the browser coming back
  const waiting = !!s?.pending
  useEffect(() => {
    const load = () => void api.leadpoet().then(take).catch(() => {})
    load()
    const t = window.setInterval(load, waiting ? 2000 : 15000)
    return () => window.clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting, s?.connected])

  const act = async (fn: () => Promise<LeadpoetState>, done?: string) => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await fn()
      take(r)
      if (done) setMsg({ ok: true, text: done })
      return r
    } catch (e) {
      setMsg({ ok: false, text: clean(e) })
      return null
    } finally {
      setBusy(false)
    }
  }

  const connect = async () => {
    if (send && !window.confirm('Allow sending? With this on, the agent can send real emails and LinkedIn messages from your accounts and launch campaigns through Leadpoet. It is told to show you the recipients and the message and wait for your yes, but the permission itself is real. Leave it off if you only want leads and drafts.')) return
    const r = await act(() => api.leadpoetConnect({ origin: window.location.origin, access, send: access === 'edit' && send }))
    // open Leadpoet's approval page; the address is also on screen in case the browser blocks it
    if (r?.pending) window.open(r.pending.url, '_blank', 'noopener,noreferrer')
  }

  if (!s) return null

  const options = (
    <div className="lp-options">
      <label className="small">
        What BitBull may do in Leadpoet
        <select value={access} onChange={(e) => setAccess(e.target.value as 'read' | 'edit')} disabled={busy}>
          <option value="edit">Plan and prepare: request leads, update the pipeline, write campaigns</option>
          <option value="read">Look only: read credits, leads, pipeline and campaigns</option>
        </select>
      </label>
      <label className={`lp-send small ${access === 'edit' ? '' : 'off'}`}>
        <input type="checkbox" checked={send && access === 'edit'} disabled={access !== 'edit' || busy} onChange={(e) => setSend(e.target.checked)} />
        <span>
          Also allow sending (emails and LinkedIn messages go out for real, campaigns can be launched)
          <span className="muted"> · off: BitBull drafts everything and you press send in Leadpoet</span>
        </span>
      </label>
    </div>
  )

  return (
    <div className="lp-connect">
      {!s.connected && !s.pending && (
        <>
          <p className="small">
            Sign in with your Leadpoet account, no key needed. New to Leadpoet? The sign-in page lets you create an account; a new one comes with free credits.
          </p>
          {options}
          <div className="row-actions">
            <button className="btn sm primary" disabled={busy} onClick={() => void connect()}>
              Connect Leadpoet
            </button>
          </div>
        </>
      )}

      {s.pending && (
        <div className="lp-pending">
          <p className="small">
            <a href={s.pending.url} target="_blank" rel="noreferrer">
              Approve in Leadpoet
            </a>
            . When you have, the browser comes back to BitBull and this page updates.
          </p>
          <LinkFallback url={s.pending.url} what="Leadpoet" />
          <details>
            <summary className="small muted">The browser ended on a page that wouldn't load?</summary>
            <p className="small muted">
              That happens when the browser can't reach BitBull at <code>{s.pending.redirect}</code>. Copy the whole address from that tab's address bar and paste it here.
            </p>
            <div className="lp-paste">
              <input value={pasted} placeholder={`${s.pending.redirect}?code=…`} onChange={(e) => setPasted(e.target.value)} />
              <button className="btn sm" disabled={busy || !pasted.trim()} onClick={() => void act(() => api.leadpoetFinish(pasted)).then((r) => r && setPasted(''))}>
                Finish
              </button>
            </div>
          </details>
          <div className="row-actions">
            <button className="btn sm" disabled={busy} onClick={() => void act(api.leadpoetDisconnect)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {s.connected && !s.pending && (
        <>
          <p className="small">
            Connected{s.connectedAt ? ` since ${new Date(s.connectedAt).toLocaleDateString()}` : ''}: <b>{s.access === 'edit' ? 'plan and prepare' : 'look only'}</b>,{' '}
            {s.send ? <b className="lv-error-text">sending allowed</b> : <b>no sending</b>}. Its tools reach chats in projects that switch Leadpoet on (project settings).
          </p>
          <details>
            <summary className="small">Change what BitBull may do</summary>
            {options}
            <div className="row-actions">
              <button className="btn sm" disabled={busy} onClick={() => void connect()}>
                Reconnect with these
              </button>
            </div>
          </details>
          <div className="row-actions">
            <a className="btn sm" href={s.manageUrl} target="_blank" rel="noreferrer">
              Open Leadpoet
            </a>
            <button
              className="btn sm danger"
              disabled={busy}
              onClick={() => window.confirm('Disconnect Leadpoet? BitBull forgets the sign-in. Campaigns already running in Leadpoet keep running.') && void act(api.leadpoetDisconnect, 'Disconnected.').then(onChanged)}
            >
              Disconnect
            </button>
          </div>
        </>
      )}
      {s.error && !s.pending && <p className="small lv-error-text">{s.error}</p>}
      {msg && <p className={`small ${msg.ok ? '' : 'lv-error-text'}`}>{msg.text}</p>}
    </div>
  )
}
