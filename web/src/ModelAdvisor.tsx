import { useState } from 'react'
import { api, type Advice, type AdvicePick } from './api'
import { ModelDog } from './dogs'
import { IconCheck } from './icons'

/**
 * "Which model for this?" on the home screen. You describe the task; the advisor model picks three
 * from SayGM's live catalogue (best value, best quality, cheapest that will do), weighing how each
 * model has done for you here, and the cost of each is worked out from today's prices. "Use this
 * model" sets it for the chat you are about to start.
 */

const ROLE: Record<AdvicePick['role'], string> = {
  'best-value': 'Best value',
  'best-quality': 'Best quality',
  cheapest: 'Cheapest that will do',
}

const usd = (n?: number) => (n === undefined ? '—' : n < 0.01 ? `$${n.toFixed(4)}` : n < 1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`)
const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

function history(p: AdvicePick) {
  const u = p.usage
  if (!u || !u.turns) return 'You haven’t used it here yet.'
  const err = Math.round((100 * u.errors) / u.turns)
  return `You’ve run ${u.turns} turn${u.turns === 1 ? '' : 's'} on it${u.avgCostUsd !== undefined ? `, about ${usd(u.avgCostUsd)} each` : ''}${err ? `, ${err}% ended in an error` : ', no errors'}.`
}

export function ModelAdvisor({ current, onUse }: { current: string; onUse: (id: string) => void }) {
  const [task, setTask] = useState('')
  const [busy, setBusy] = useState<false | 'ask' | 'strong'>(false)
  const [advice, setAdvice] = useState<Advice | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const ask = async (strong: boolean) => {
    if (task.trim().length < 3 || busy) return
    setBusy(strong ? 'strong' : 'ask')
    setErr(null)
    try {
      setAdvice(await api.advise(task, strong))
    } catch (e) {
      setErr(e instanceof Error ? e.message.replace(/^\d+ /, '') : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="advisor">
      <div className="suggest-label">Which model for this?</div>
      <form
        className="advisor-ask"
        onSubmit={(e) => {
          e.preventDefault()
          void ask(false)
        }}
      >
        <input
          value={task}
          onChange={(e) => setTask(e.target.value)}
          placeholder="Describe the job, e.g. “review a 30-file TypeScript repo for security issues”"
          maxLength={2000}
        />
        <button className="btn primary" disabled={!!busy || task.trim().length < 3}>
          {busy === 'ask' ? 'Thinking…' : 'Suggest 3'}
        </button>
      </form>
      {err && <p className="error small">{err}</p>}
      {advice && (
        <>
          <div className="advisor-picks">
            {advice.picks.map((p) => (
              <div key={p.id} className={`advisor-card role-${p.role}`}>
                <div className="advisor-role">{ROLE[p.role]}</div>
                <div className="advisor-head">
                  <ModelDog id={p.id} size={34} />
                  <div className="grow">
                    <b>{p.name}</b>
                    <code>{p.id}</code>
                  </div>
                  <div className="advisor-cost" title="Estimated for the whole task, from SayGM's live prices">
                    {usd(p.estCostUsd)}
                  </div>
                </div>
                {p.why && <p className="advisor-why">{p.why}</p>}
                <ul className="advisor-pc">
                  {p.pros.map((x, i) => (
                    <li key={`p${i}`} className="pro">
                      {x}
                    </li>
                  ))}
                  {p.cons.map((x, i) => (
                    <li key={`c${i}`} className="con">
                      {x}
                    </li>
                  ))}
                </ul>
                <p className="advisor-history">{history(p)}</p>
                {p.id === current ? (
                  <span className="advisor-using">
                    <IconCheck size={13} /> In use
                  </span>
                ) : (
                  <button className="btn sm" onClick={() => onUse(p.id)}>
                    Use this model
                  </button>
                )}
              </div>
            ))}
          </div>
          <div className="advisor-foot muted small">
            <span>
              Picked by <code>{advice.advisor}</code> from {advice.considered} models that can do it
              {advice.needs.vision ? ' (with vision)' : ''} · task sized at about {k(advice.estimate.inputTokens)} in / {k(advice.estimate.outputTokens)} out
              over {advice.estimate.turns} turn{advice.estimate.turns === 1 ? '' : 's'}
              {advice.costUsd !== undefined ? ` · this advice cost ${usd(advice.costUsd)}` : ''}
            </span>
            <button className="link" disabled={!!busy} onClick={() => void ask(true)} title="Same question, answered by the stronger advisor (Settings → Configuration)">
              {busy === 'strong' ? 'Asking…' : 'Ask a stronger model'}
            </button>
          </div>
        </>
      )}
    </section>
  )
}
