import { useEffect, useState, useSyncExternalStore } from 'react'
import { api, type CathedralRequest } from './api'
import { onLiveActivity, reportLocal } from './activity'
import { IconLock } from './icons'

/* ---------------- store: the sandboxes waiting for the owner's answer ---------------- */

let requests: CathedralRequest[] | null = null
const subs = new Set<() => void>()
const emit = () => subs.forEach((f) => f())
let started = false
let loading: Promise<void> | null = null

export function refreshCathedral() {
  loading ??= api
    .cathedralRequests()
    .then((r) => {
      requests = r.requests
      emit()
    })
    .catch(() => {
      /* offline or unauthorised: the rest of the UI reports that */
    })
    .finally(() => {
      loading = null
    })
  return loading
}

function start() {
  if (started) return
  started = true
  void refreshCathedral()
  // Requests and decisions are announced on the activity feed; poll as a fallback
  onLiveActivity((e) => {
    if (e.source === 'cathedral') void refreshCathedral()
  })
  setInterval(() => {
    if (document.visibilityState === 'visible') void refreshCathedral()
  }, 20000)
}

export function useCathedralRequests() {
  useEffect(start, [])
  return useSyncExternalStore(
    (f) => {
      subs.add(f)
      return () => {
        subs.delete(f)
      }
    },
    () => requests,
  )
}

/* ---------------- the prompt: the agent is waiting for a sandbox ---------------- */

const PURPOSE: Record<CathedralRequest['purpose'], string | null> = {
  chat: null,
  'qa-hound': 'QA Hound review',
  'clean-machine': 'Clean-machine test',
}

function sizeText(r: CathedralRequest) {
  const res = r.resources
  const parts = [res?.cpu != null && `${res.cpu} vCPU`, res?.memory_gib != null && `${res.memory_gib} GiB memory`, res?.disk_gib != null && `${res.disk_gib} GiB disk`].filter(Boolean)
  return parts.length ? `${r.size} (${parts.join(', ')})` : r.size
}

const minutes = (s: number) => {
  const m = Math.max(1, Math.round(s / 60))
  return `${m} minute${m === 1 ? '' : 's'}`
}

export function CathedralPrompt({ onOpenSession }: { onOpenSession?: (id: string) => void }) {
  const all = useCathedralRequests()
  const [busy, setBusy] = useState<string | null>(null)
  const pending = all?.filter((r) => r.status === 'pending') ?? []
  if (!pending.length) return null
  const answer = (id: string, decision: 'approve' | 'deny') => {
    setBusy(id)
    void api
      .decideCathedral(id, decision)
      .then((r) => {
        requests = r.requests
        emit()
      })
      .catch((e) => reportLocal(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null))
  }
  return (
    <div className="net-prompts" role="region" aria-label="Confidential sandbox requests">
      {pending.map((r) => {
        const purpose = PURPOSE[r.purpose]
        return (
          <div key={r.id} className="net-prompt" role="alertdialog" aria-label={`Approve a confidential sandbox for ${r.projectName}?`}>
            <div className="net-head">
              <IconLock size={15} />
              <span>
                <b>Approve a confidential sandbox?</b>
              </span>
            </div>
            <p className="net-reason">“{r.reason}”</p>
            <dl className="cath-facts">
              <dt>Size</dt>
              <dd>{sizeText(r)}</dd>
              <dt>Rate</dt>
              <dd>${r.hourlyRateUsd} an hour</dd>
              <dt>Lifetime</dt>
              <dd>{minutes(r.lifetimeSeconds)}</dd>
              <dt>Spend</dt>
              <dd>
                up to ${r.spendCapUsd} <span className="muted">(limit ${r.limitUsd} per sandbox)</span>
              </dd>
              <dt>Internet</dt>
              <dd className={r.internet ? 'cath-warn' : ''}>
                {r.internet ? 'ON: the sandbox can reach the internet' : r.allowHosts?.length ? `Closed except: ${r.allowHosts.join(', ')}` : 'Closed'}
              </dd>
              <dt>Project</dt>
              <dd>{r.projectName}</dd>
              {(r.sessionId || purpose) && (
                <>
                  <dt>From</dt>
                  <dd>
                    {r.sessionId && (
                      <button className="linklike" onClick={() => onOpenSession?.(r.sessionId!)}>
                        {r.sessionTitle ?? 'a chat'}
                      </button>
                    )}
                    {r.sessionId && purpose && ' · '}
                    {purpose}
                  </dd>
                </>
              )}
            </dl>
            <p className="net-meta">The agent is waiting for your answer. BitBull holds the key and makes every call; never send secrets to a sandbox.</p>
            <div className="net-actions">
              <button className="btn primary sm" disabled={busy === r.id} onClick={() => answer(r.id, 'approve')}>
                Approve
              </button>
              <button className="btn sm danger" disabled={busy === r.id} onClick={() => answer(r.id, 'deny')}>
                Deny
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
