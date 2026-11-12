/**
 * Integrations → Ditto: one sign-in sets BitBull up on Ditto (server/src/dittoConnect.ts). The
 * server waits for the approval and saves the keys; this only shows the code and link, then
 * reloads Settings. Connected: a link to Ditto's Connections, where GitHub, Gmail, Linear, …
 * connected once become the agent's tools here, and the provider keys kept in Ditto.
 */
import { useEffect, useRef, useState } from 'react'
import { api, type AppConfig, type DittoConnectState } from './api'
import { ProviderKeys } from './ProviderKeys'

export function DittoConnect({ ditto, onConnected }: { ditto: AppConfig['ditto']; onConnected: () => void }) {
  const [state, setState] = useState<DittoConnectState>({ status: 'idle' })
  const timer = useRef<number | null>(null)
  const stop = () => {
    if (timer.current !== null) window.clearInterval(timer.current)
    timer.current = null
  }
  /** Follow a sign-in the server is waiting on until it finishes */
  const follow = (current: DittoConnectState) => {
    stop()
    setState(current)
    if (current.status !== 'waiting') return
    timer.current = window.setInterval(async () => {
      const next = await api.dittoConnectState().catch(() => null)
      if (!next || next.status === 'waiting') return
      stop()
      setState(next)
      if (next.status === 'connected') onConnected()
    }, 2000)
  }
  // a sign-in started before Settings was closed and reopened is still followed
  useEffect(() => {
    void api.dittoConnectState().then((s) => s.status === 'waiting' && follow(s)).catch(() => {})
    return stop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const connect = async () => {
    try {
      follow(await api.dittoConnect())
    } catch (e) {
      setState({ status: 'error', message: e instanceof Error ? e.message.replace(/^\d+ /, '') : String(e) })
    }
  }

  return (
    <div className="ditto-connect">
      <div className="row-actions">
        <button className="btn sm" onClick={() => void connect()} disabled={state.status === 'waiting'}>
          {ditto.router ? 'Reconnect Ditto' : 'Connect Ditto'}
        </button>
        {ditto.router && (
          <a className="btn sm" href={ditto.connectionsUrl} target="_blank" rel="noreferrer">
            Manage connections
          </a>
        )}
        {!ditto.router && (
          <a className="btn sm" href={ditto.signupUrl} target="_blank" rel="noreferrer">
            Create a Ditto account
          </a>
        )}
      </div>
      {state.status === 'waiting' && (
        <p className="small">
          <a href={state.url} target="_blank" rel="noreferrer">
            Approve in Ditto
          </a>{' '}
          and check the code is <code>{state.userCode}</code>. This page updates when you're done.
        </p>
      )}
      {state.status === 'connected' && <p className="small">Connected: chats run on your “bitbull” Ditto endpoint with your memory and connected apps.</p>}
      {state.status === 'error' && <p className="small lv-error-text">{state.message}</p>}
      {ditto.enabled && state.status !== 'waiting' && <ProviderKeys onReconnect={() => void connect()} />}
    </div>
  )
}
