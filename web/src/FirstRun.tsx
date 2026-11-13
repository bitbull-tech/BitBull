import { useState } from 'react'
import { api, type AppConfig } from './api'
import { DittoConnect } from './DittoConnect'
import { LinkFallback } from './LinkFallback'
import { IconCheck } from './icons'

/**
 * "Finish setting up", shown above the chat on a fresh install until both are done. BitBull
 * starts without keys, so installing never asks for one in a terminal or a file:
 *
 *  1. SayGM (models): paste the key here; it is saved like any key in Settings (the vault when
 *     unlocked). This becomes "Sign in with SayGM" when SayGM offers it to self-hosted apps.
 *  2. Ditto (memory): Connect Ditto, a sign-in in the browser with no key to copy.
 */
export function FirstRun({ cfg, onSaygmReady }: { cfg: AppConfig; onSaygmReady: () => void }) {
  const [saygm, setSaygm] = useState(cfg.setup?.saygm ?? true)
  const [ditto, setDitto] = useState(cfg.setup?.ditto ?? true)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [later, setLater] = useState(false)

  if ((saygm && ditto) || later) return null

  const saveKey = async () => {
    const v = key.trim()
    if (!v) return
    if (/\s|["'“”]/.test(v) || v.length < 12) {
      setMsg("That doesn't look like a whole key (no spaces or quotes). Copy it again from SayGM.")
      return
    }
    setBusy(true)
    setMsg(null)
    try {
      await api.updateSettings({ SAYGM_API_KEY: v })
      // the key is only kept if SayGM accepts it
      const status = await api.status()
      if (!status.saygm.ok) {
        await api.updateSettings({ SAYGM_API_KEY: null })
        setMsg(`SayGM didn't accept that key${status.saygm.error ? ` (${status.saygm.error.slice(0, 120)})` : ''}. Check it and try again.`)
        return
      }
      setKey('')
      setSaygm(true)
      onSaygmReady()
    } catch (e) {
      setMsg(e instanceof Error ? e.message.replace(/^\d+ /, '') : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="firstrun" aria-label="Finish setting up">
      <div className="firstrun-head">
        <strong>Finish setting up</strong>
        <button className="link" onClick={() => setLater(true)} title="Hide until you reload; both are also under Settings → Integrations">
          Later
        </button>
      </div>
      <div className={`firstrun-step ${saygm ? 'done' : ''}`}>
        <span className="firstrun-n">{saygm ? <IconCheck size={14} /> : '1'}</span>
        <div className="firstrun-main">
          <b>Models: SayGM</b>
          {saygm ? (
            <span className="muted small">Connected.</span>
          ) : (
            <>
              <span className="muted small">
                One key for every AI model.{' '}
                <a href="https://saygm.com" target="_blank" rel="noreferrer">
                  Get a key at saygm.com
                </a>
                , then paste it here.
              </span>
              <form
                className="firstrun-key"
                onSubmit={(e) => {
                  e.preventDefault()
                  void saveKey()
                }}
              >
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder="Paste your SayGM key"
                  aria-label="SayGM key"
                />
                <button className="btn sm" type="submit" disabled={!key.trim() || busy}>
                  {busy ? 'Checking…' : 'Save'}
                </button>
              </form>
              {msg && <span className="small lv-error-text">{msg}</span>}
              <LinkFallback url="https://saygm.com" what="the SayGM link" />
            </>
          )}
        </div>
      </div>
      <div className={`firstrun-step ${ditto ? 'done' : ''}`}>
        <span className="firstrun-n">{ditto ? <IconCheck size={14} /> : '2'}</span>
        <div className="firstrun-main">
          <b>Memory: Ditto</b>
          {ditto ? (
            <span className="muted small">Connected.</span>
          ) : (
            <>
              <span className="muted small">Long-term memory across every chat and model. Sign in (or sign up free) in your browser; there is no key to copy.</span>
              <DittoConnect ditto={cfg.ditto} onConnected={() => setDitto(true)} />
            </>
          )}
        </div>
      </div>
    </section>
  )
}
