/**
 * Integrations → Telegram (server/src/telegram.ts): your own bot, answering one account only.
 * Three steps, each shown only when it is the next one: make a bot and paste its token (the row
 * below this panel), pair your account with a one-time code, done. The token never comes back
 * from the server; this panel only ever sees the bot's name, the code and who is paired.
 */
import { useEffect, useRef, useState } from 'react'
import { api, type TelegramState } from './api'
import { LinkFallback } from './LinkFallback'

const clean = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^\d+ /, '').replace(/^\{"error":"(.*)"\}$/, '$1')

export function TelegramConnect({ onState }: { onState: (s: TelegramState) => void }) {
  const [s, setS] = useState<TelegramState | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [, tick] = useState(0)
  const wasPaired = useRef(false)

  const take = (next: TelegramState) => {
    if (next.paired && !wasPaired.current && s?.pairing) setMsg({ ok: true, text: 'Paired. Say hello to your bot in Telegram.' })
    wasPaired.current = !!next.paired
    setS(next)
    onState(next)
  }
  const load = () => void api.telegram().then(take).catch(() => {})
  // quick while a code is waiting or the bot is still connecting, slow otherwise
  const waiting = !!s?.pairing || s?.status === 'connecting'
  useEffect(() => {
    load()
    const t = window.setInterval(() => {
      load()
      tick((n) => n + 1)
    }, waiting ? 2000 : 8000)
    return () => window.clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting])

  const act = async (fn: () => Promise<TelegramState | { ok: boolean }>, done?: string) => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await fn()
      if ('status' in r) take(r)
      if (done) setMsg({ ok: true, text: done })
    } catch (e) {
      setMsg({ ok: false, text: clean(e) })
    } finally {
      setBusy(false)
    }
  }

  if (!s) return null
  const left = s.pairing ? Math.max(0, Math.ceil((s.pairing.expiresAt - Date.now()) / 60000)) : 0

  return (
    <div className="tg-connect">
      {!s.configured && (
        <ol className="tg-steps small">
          <li>
            In Telegram, open{' '}
            <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">
              @BotFather
            </a>
            , send <code>/newbot</code> and follow it. It gives you a token that looks like <code>123456789:AA…</code>.
          </li>
          <li>Paste the token below and press Save.</li>
          <li>Pair your own Telegram account here. The bot then answers you and nobody else.</li>
        </ol>
      )}
      {s.configured && s.status === 'connecting' && <p className="small muted">Connecting to Telegram…</p>}
      {s.configured && s.status === 'error' && <p className="small lv-error-text">{s.error}</p>}

      {s.bot && !s.paired && !s.pairing && (
        <>
          <p className="small">
            Connected as <b>@{s.bot.username}</b>. It answers nobody yet: pair your own Telegram account to make it yours.
          </p>
          <div className="row-actions">
            <button className="btn sm primary" disabled={busy} onClick={() => void act(api.telegramPair)}>
              Pair my Telegram
            </button>
          </div>
        </>
      )}

      {s.bot && s.pairing && (
        <div className="tg-pairing">
          <p className="small">
            On the phone or computer where you use Telegram, open your bot and press <b>Start</b>:
          </p>
          <div className="row-actions">
            <a className="btn sm primary" href={s.pairing.link} target="_blank" rel="noreferrer">
              Open @{s.bot.username}
            </a>
            <button className="btn sm" disabled={busy} onClick={() => void act(api.telegramCancelPair)}>
              Cancel
            </button>
          </div>
          <p className="small">
            Or open <b>@{s.bot.username}</b> in Telegram yourself and send it this code:
          </p>
          <code className="tg-code">{s.pairing.code}</code>
          <p className="small muted">
            Works once, for the next {left} minute{left === 1 ? '' : 's'}. Whoever sends it becomes the one account the bot answers, so don't share it. This page updates when
            you're paired.
          </p>
          <LinkFallback url={s.pairing.link} what="the bot" />
        </div>
      )}

      {s.bot && s.paired && !s.pairing && (
        <>
          <p className="small">
            <b>@{s.bot.username}</b> answers {s.paired.name ? <b>{s.paired.name}</b> : 'your account'} only (paired {new Date(s.paired.pairedAt).toLocaleDateString()}). Message it and BitBull
            replies; the same conversation is the “Telegram” chat here. Schedules can send their results to it too.
          </p>
          <div className="row-actions">
            <a className="btn sm" href={s.bot.link} target="_blank" rel="noreferrer">
              Open in Telegram
            </a>
            <button className="btn sm" disabled={busy} onClick={() => void act(api.telegramTest, 'Sent. Check Telegram.')}>
              Send a test message
            </button>
            <button className="btn sm" disabled={busy} onClick={() => void act(api.telegramPair)}>
              Pair a different account
            </button>
            <button
              className="btn sm danger"
              disabled={busy}
              onClick={() => window.confirm('Unpair Telegram? The bot will answer nobody until you pair again.') && void act(api.telegramUnpair, 'Unpaired.')}
            >
              Unpair
            </button>
          </div>
        </>
      )}
      {s.ignored > 0 && s.bot && (
        <p className="small muted">
          {s.ignored} message{s.ignored === 1 ? '' : 's'} from other accounts or group chats ignored since BitBull started. They get no reply.
        </p>
      )}
      {msg && <p className={`small ${msg.ok ? '' : 'lv-error-text'}`}>{msg.text}</p>}
    </div>
  )
}
