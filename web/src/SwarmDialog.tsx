import { useEffect, useRef, useState } from 'react'
import { api, type HoundOptions, type HoundRoomOptions, type Model, type Project, type RepoInfo, type Session, type Severity, type Swarm, type HoundBench } from './api'
import { IconX } from './icons'
import { priceLabel } from './ModelPicker'
import { TargetPicker } from './TargetPicker'
import { fromInput, uploadItems } from './uploads'
import houndArt from './assets/qa-hound.webp'

const FOCUS: { id: Swarm['focus'][number]; label: string; hint: string }[] = [
  { id: 'attack-vectors', label: 'Attack vectors', hint: 'how a hostile input, contributor, dependency or prompt-injected agent could abuse it; entry point → impact' },
  { id: 'correctness', label: 'Correctness', hint: 'does what it claims; logic errors, races, data loss, misleading behaviour, tests that don’t test' },
  { id: 'code-quality', label: 'Code quality', hint: 'duplication, structure, naming, dead code, error handling, coverage' },
  { id: 'performance', label: 'Performance', hint: 'hot spots, waste, memory/I-O, scalability, leaks' },
  { id: 'user-experience', label: 'User experience', hint: 'fit for purpose, first-run and everyday workflows, error messages, docs, real-world use' },
]

const SEVERITY: Severity[] = ['low', 'medium', 'high', 'critical']
const OPTS_KEY = 'bitbull-hound-options'
const DEFAULTS: HoundOptions = { budgetUsd: 2, maxMinutes: 45, minSeverity: 'low', minConfidence: 70, include: [], exclude: [], pr: false, prBlocking: 'high', prApprove: false, citeSources: false, flagUnsourced: false }
/** The last settings used, per browser: a convenience, the server checks them again. */
function savedOptions(): HoundOptions {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(OPTS_KEY) ?? '{}') as Partial<HoundOptions>) }
  } catch {
    return DEFAULTS
  }
}
const lines = (t: string) => t.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
const ROOMS_KEY = 'bitbull-hound-rooms'
const ROOM_DEFAULTS: HoundRoomOptions = { sandbox: false, cleanMachine: { enabled: false, install: '', build: '', test: '', allowHosts: [] } }
/** The sandbox settings last used, per browser (the commands are the project's, so worth keeping). */
function savedRooms(): HoundRoomOptions {
  try {
    const r = JSON.parse(localStorage.getItem(ROOMS_KEY) ?? '{}') as Partial<HoundRoomOptions>
    return { ...ROOM_DEFAULTS, ...r, cleanMachine: { ...ROOM_DEFAULTS.cleanMachine, ...(r.cleanMachine ?? {}) } }
  } catch {
    return ROOM_DEFAULTS
  }
}

/**
 * QA swarm: pick a repo, folder or file in the workspace and up to two other models. Each
 * reviews it on its own, then they challenge each other, then this chat's model gives the
 * verdict as its next reply. Progress shows in the pill in the top bar.
 */
export function SwarmDialog({
  session,
  project,
  models,
  primaryModel,
  onClose,
  onStarted,
}: {
  session: Session
  project: Project | null
  models: Model[]
  primaryModel: string
  onClose: () => void
  onStarted: (s: Swarm) => void
}) {
  const [target, setTarget] = useState('')
  // "Upload a file to review": a one-off document (a roadmap, a spec, a script) that isn't in the workspace yet
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadNote, setUploadNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [filesVersion, setFilesVersion] = useState(0)
  const uploadForReview = async (list: FileList | null) => {
    const items = fromInput(list)
    if (!items.length) return
    setUploading(true)
    setUploadNote(null)
    try {
      // a folder of their own, so a review of several files has one thing to point at and nothing is overwritten
      const d = new Date()
      const pad = (n: number) => String(n).padStart(2, '0')
      const folder = `uploads/review-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
      const r = await uploadItems(project?.id ?? 'general', items, { target: folder })
      if (!r.saved.length) throw new Error('nothing was saved')
      setFilesVersion((v) => v + 1)
      setTarget(r.saved.length === 1 ? r.saved[0] : folder)
      const unread = r.saved.filter((p) => /\.(pdf|docx?|xlsx?|pptx?|odt|rtf|zip|png|jpe?g|gif|webp)$/i.test(p))
      setUploadNote({
        ok: !unread.length,
        text:
          (r.saved.length === 1 ? `Uploaded ${r.saved[0]}.` : `Uploaded ${r.saved.length} files to ${folder}.`) +
          (unread.length ? ` The reviewers read text (Markdown, plain text, code, CSV, JSON): ${unread.length === 1 ? 'this file is' : `${unread.length} of these are`} a format they can't open as text, so paste or export the content as Markdown or text for a proper review.` : ''),
      })
    } catch (e) {
      setUploadNote({ ok: false, text: `Couldn't upload: ${e instanceof Error ? e.message : String(e)}` })
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }
  const [repos, setRepos] = useState<RepoInfo[]>([])
  const [reposLoaded, setReposLoaded] = useState(false)
  const [a, setA] = useState('')
  const [b, setB] = useState('')
  const [focus, setFocus] = useState<Swarm['focus']>(['attack-vectors', 'correctness', 'code-quality', 'performance', 'user-experience'])
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [opts, setOpts] = useState<HoundOptions>(savedOptions)
  const [include, setInclude] = useState(opts.include.join('\n'))
  const [exclude, setExclude] = useState(opts.exclude.join('\n'))
  const set = (patch: Partial<HoundOptions>) => setOpts((o) => ({ ...o, ...patch }))
  const [rooms, setRooms] = useState<HoundRoomOptions>(savedRooms)
  const [hosts, setHosts] = useState(rooms.cleanMachine.allowHosts.join('\n'))
  const setClean = (patch: Partial<HoundRoomOptions['cleanMachine']>) => setRooms((r) => ({ ...r, cleanMachine: { ...r.cleanMachine, ...patch } }))
  // Cathedral rooms need a key (Settings) and Cathedral ticked for this project
  const [cathedralKey, setCathedralKey] = useState<boolean | null>(null)
  useEffect(() => {
    void api
      .integrations()
      .then((r) => setCathedralKey(!!r.integrations.find((i) => i.id === 'cathedral')?.configured))
      .catch(() => setCathedralKey(false))
  }, [])
  const roomsWhyNot =
    cathedralKey === null
      ? 'Checking Cathedral…'
      : !cathedralKey
        ? 'Needs Cathedral: add a key in Settings, Integrations, Cathedral.'
        : !project?.integrations?.includes('cathedral')
          ? 'Needs Cathedral switched on for this project (project settings, Integrations).'
          : null

  useEffect(() => {
    void api
      .repos(project?.id ?? 'general')
      .then((r) => {
        setRepos(r.repos)
        // default to the first repo in this workspace, whatever the count: reviewing "the repo
        // I'm working on" is the normal case, and an empty box invites a path that isn't there
        setTarget((cur) => cur || r.repos[0]?.path || '')
        setReposLoaded(true)
      })
      .catch(() => setReposLoaded(true))
  }, [project])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // The model benchmark: which of the chosen reviewers may be behind an approval
  const [bench, setBench] = useState<HoundBench | null>(null)
  const [benchErr, setBenchErr] = useState<string | null>(null)
  const chosenModels = [a, b].filter(Boolean)
  const benchRunning = (bench?.running.length ?? 0) > 0
  useEffect(() => {
    if (!opts.prApprove) return
    const load = () =>
      void api
        .houndBench()
        .then(setBench)
        .catch(() => {})
    load()
    if (!benchRunning) return
    const t = setInterval(load, 3000)
    return () => clearInterval(t)
  }, [opts.prApprove, benchRunning])
  const runBench = async (model: string) => {
    setBenchErr(null)
    try {
      setBench(await api.startHoundBench(model))
    } catch (e) {
      setBenchErr(e instanceof Error ? e.message.replace(/^\d+ /, '').replace(/^\{.*"message":"([^"]*)".*$/, '$1') : String(e))
    }
  }

  const others = models.filter((m) => m.id !== primaryModel)
  // The id, not just the name: SayGM ships TEE and non-TEE builds under the SAME display name
  // (DeepSeek-V4.1-Flash twice, Kimi K3.1 Pro twice), and they differ in price by multiples.
  const option = (m: Model) => (
    <option key={m.id} value={m.id}>
      {m.name || m.id}
      {m.confidential ? ' (TEE)' : ''} — {m.id}
      {m.price ? ` · ${priceLabel(m)}` : ''}
    </option>
  )
  // The reviewers read the agent's copy in this workspace, not your machine and not what the
  // server is running. A copy that is behind origin means a swarm spends real money reviewing
  // code you already changed, so say so before it starts rather than in the verdict.
  const stale = repos.find((r) => r.path === target.trim() && r.behind > 0)
  const [syncing, setSyncing] = useState(false)
  const [fetched, setFetched] = useState<string[]>([])
  // `behind` is only true as of the last fetch, so a copy nobody has fetched always looks level.
  // Fetch once per target when it is a repo, so the warning below means something.
  useEffect(() => {
    const t = target.trim()
    if (!t || fetched.includes(t) || !repos.some((r) => r.path === t)) return
    setFetched((f) => [...f, t])
    void api
      .syncRepo(project?.id ?? 'general', t, true)
      .then((r) => setRepos(r.repos))
      .catch(() => {})
  }, [target, repos, fetched, project])
  const syncNow = async () => {
    if (!stale) return
    setSyncing(true)
    setErr(null)
    try {
      const r = await api.syncRepo(project?.id ?? 'general', stale.path)
      setRepos(r.repos)
      if (!r.ok) setErr(r.message)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSyncing(false)
    }
  }

  const start = async () => {
    setErr(null)
    const chosen = [a, b].filter(Boolean)
    if (!target.trim()) return setErr('Which repo, folder or file? A path inside this workspace, e.g. my-repo or uploads/tool.py.')
    if (!chosen.length) return setErr('Choose at least one reviewer model.')
    if (!focus.length) return setErr('Tick at least one thing to look at.')
    setBusy(true)
    try {
      const base: HoundOptions = { ...opts, include: lines(include), exclude: lines(exclude) }
      const roomOpts: HoundRoomOptions = { ...rooms, cleanMachine: { ...rooms.cleanMachine, allowHosts: hosts.split(/[\s,]+/).map((h) => h.trim()).filter(Boolean) } }
      try {
        localStorage.setItem(OPTS_KEY, JSON.stringify(base))
        localStorage.setItem(ROOMS_KEY, JSON.stringify(roomOpts))
      } catch {
        /* private window */
      }
      // rooms only when Cathedral is ready here; the server checks again
      const options = roomsWhyNot ? { ...base, sandbox: false, cleanMachine: { ...roomOpts.cleanMachine, enabled: false } } : { ...base, ...roomOpts }
      const r = await api.startSwarm({ sessionId: session.id, target: target.trim(), models: chosen, focus, options })
      onStarted(r.swarm)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal swarm-modal" role="dialog" aria-label="QA Hound">
        <header className="modal-head">
          <h2>QA Hound · {project?.name ?? 'General workspace'}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <IconX />
          </button>
        </header>
        <div className="modal-body">
          <div className="hound-intro">
            <img className="hound-art" src={houndArt} alt="" draggable={false} />
            <div>
          <p className="hound-lead">
            <b>QA Hound</b> - unleash multiple LLMs on your designated repo, folder or file to review, challenge each other and summarise a
            verdict and recommendations.
          </p>
          <p className="muted small">
            Up to two other models each review the target in the sandbox, read-only, then read each other's reports and try to knock them down. Your
            current model (<b>{primaryModel}</b>) weighs both and gives the verdict as its next reply in this chat. The reviewers' chats appear in
            the sidebar as "QA Hound · …" so you can read their working.
          </p>
            </div>
          </div>
          <div className="field">
            <span>What to review (a repo, folder or file in this workspace)</span>
            <TargetPicker projectId={project?.id ?? 'general'} repos={repos} value={target} onChange={setTarget} version={filesVersion} />
            <div className="hound-upload">
              <input ref={fileRef} type="file" multiple hidden onChange={(e) => void uploadForReview(e.target.files)} />
              <button type="button" className="btn sm" disabled={uploading} onClick={() => fileRef.current?.click()}>
                {uploading ? 'Uploading…' : 'Upload a file to review'}
              </button>
              <span className="muted small">For a one-off review of a document that isn't in the workspace: a roadmap, a spec, a script. Several files go in as one folder.</span>
            </div>
            {uploadNote && <span className={`small ${uploadNote.ok ? 'muted' : 'lv-error-text'}`}>{uploadNote.text}</span>}
            {reposLoaded && repos.length === 0 && (
              <span className="muted small">
                No repos are cloned in {project ? `"${project.name}"` : 'the general workspace'}: clone one from Repositories, or pick a folder or file
                from the list (uploads are under <code>uploads/</code>).
              </span>
            )}
          </div>
          {/* one under the other: side by side, a long model name pushed the second out of view */}
          <div className="reviewers">
            <label className="field">
              <span>Reviewer 1</span>
              <select value={a} onChange={(e) => setA(e.target.value)}>
                <option value="">— choose —</option>
                {others.filter((m) => m.id !== b).map(option)}
              </select>
            </label>
            <label className="field">
              <span>Reviewer 2 (optional)</span>
              <select value={b} onChange={(e) => setB(e.target.value)}>
                <option value="">— none —</option>
                {others.filter((m) => m.id !== a).map(option)}
              </select>
            </label>
          </div>
          <div className="field">
            <span>Look at</span>
            <div className="checks">
              {FOCUS.map((f) => (
                <label key={f.id} className="check" title={f.hint}>
                  <input
                    type="checkbox"
                    checked={focus.includes(f.id)}
                    onChange={(e) => setFocus((cur) => (e.target.checked ? [...cur, f.id] : cur.filter((x) => x !== f.id)))}
                  />
                  {f.label}
                </label>
              ))}
            </div>
          </div>
          <div className="field">
            <span>Sources</span>
            <div className="checks hound-sources">
              <label className="check">
                <input type="checkbox" checked={!!opts.citeSources} onChange={(e) => set({ citeSources: e.target.checked })} />
                <span>
                  Cite a source for every factual claim{' '}
                  <span className="muted small">The reviewers and the verdict give a file and line, or the web page they opened, after each fact; anything they can’t source is marked “unsourced”.</span>
                </span>
              </label>
              <label className="check">
                <input type="checkbox" checked={!!opts.flagUnsourced} onChange={(e) => set({ flagUnsourced: e.target.checked })} />
                <span>
                  Flag unsourced claims in the document{' '}
                  <span className="muted small">Figures, dates and facts the target states without saying where they come from are listed as findings. Useful for a roadmap, a spec or a report.</span>
                </span>
              </label>
            </div>
            {(opts.citeSources || opts.flagUnsourced) && (
              <span className="muted small">
                These are instructions to the models. BitBull checks that a finding’s quote is in the file; it doesn’t open cited web pages, so check a source that matters. The reviewers reach the web
                only through BitBull’s network allowlist.
              </span>
            )}
          </div>
          <div className="hound-opts">
            <div className="hound-opts-title">Limits and filters</div>
            <div className="row3">
              <label className="field">
                <span>Budget for the whole run (USD)</span>
                <input type="number" min={0.05} max={100} step={0.05} value={opts.budgetUsd} onChange={(e) => set({ budgetUsd: Number(e.target.value) })} />
              </label>
              <label className="field">
                <span>Time limit (minutes)</span>
                <input type="number" min={5} max={120} step={5} value={opts.maxMinutes} onChange={(e) => set({ maxMinutes: Number(e.target.value) })} />
              </label>
              <label className="field">
                <span>Minimum severity</span>
                <select value={opts.minSeverity} onChange={(e) => set({ minSeverity: e.target.value as Severity })}>
                  {SEVERITY.map((x) => (
                    <option key={x} value={x}>
                      {x === 'low' ? 'low and above (all)' : x === 'critical' ? 'critical only' : `${x} and above`}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="muted small">
              Hard caps: the reviewers stop at 75% of the budget and 80% of the time, the rest is kept for the verdict, and the verdict stops at the
              limit. A run that hits a cap ends with what it has, marked partial.
            </p>
            <label className="field">
              <span>
                Minimum confidence: <b>{opts.minConfidence}%</b>
              </span>
              <input type="range" min={0} max={100} step={5} value={opts.minConfidence} onChange={(e) => set({ minConfidence: Number(e.target.value) })} />
              <span className="muted small">
                Your model scores every finding 0–100 for how sure it is, after checking, that it is real. Below this a finding is still listed,
                as held back, but not counted in the verdict or posted to the PR.
              </span>
            </label>
            <div className="row2">
              <label className="field">
                <span>Only these paths (one glob a line)</span>
                <textarea rows={2} value={include} onChange={(e) => setInclude(e.target.value)} placeholder={'src/**\nserver/**/*.ts'} />
              </label>
              <label className="field">
                <span>Never these</span>
                <textarea rows={2} value={exclude} onChange={(e) => setExclude(e.target.value)} placeholder={'**/*.test.ts\ndocs/**'} />
              </label>
            </div>
            <label className="check">
              <input type="checkbox" checked={opts.pr} onChange={(e) => set({ pr: e.target.checked })} />
              Post the verdict on the pull request
            </label>
            {opts.pr && (
              <div className="hound-pr">
                <span className="muted small">
                  The target's repo, its current branch's open PR on GitHub (your GitHub token). Request changes when a shown finding is
                </span>
                <select value={opts.prBlocking} onChange={(e) => set({ prBlocking: e.target.value as Severity })}>
                  {SEVERITY.map((x) => (
                    <option key={x} value={x}>
                      {x} or worse
                    </option>
                  ))}
                </select>
                <span className="muted small">; otherwise comment.</span>
                <label className="check small hound-approve">
                  <input type="checkbox" checked={opts.prApprove} onChange={(e) => set({ prApprove: e.target.checked })} />
                  <span>
                    Let QA Hound approve the pull request when the run is complete, the verdict is "use", nothing that serious was even held
                    back, and every check BitBull runs itself passes.{' '}
                    <span className="muted">The approval is given under your GitHub account. The checks lower the chance of a missed problem; they don't remove it.</span>
                  </span>
                </label>
                {opts.prApprove && (
                  <div className="bench small">
                    <span className="muted">
                      An approval needs: two reviewers from different model families, each recommending "use" before and after reading the other;
                      both models passed on the benchmark below; every finding's quote found in its file; every changed file opened; the copy at the
                      pull request's commit; no key-shaped text in the change; the project's own CI green on that commit; nothing touching sign-in,
                      key handling, CI or install files; and both reviewers finding two defects planted in a scratch copy (a short extra test,
                      counted in the budget).
                    </span>
                    {chosenModels.length < 2 && <span className="warn-line">Choose two reviewers: with one, this run can't approve.</span>}
                    {chosenModels.map((m) => {
                      const r = bench?.results.find((x) => x.model === m)
                      const run = bench?.running.find((x) => x.model === m)
                      return (
                        <div key={m} className="bench-row">
                          <span className="mono">{m}</span>
                          {run ? (
                            <span className="pill run">benchmarking · case {run.step}</span>
                          ) : r && !r.error ? (
                            <span className={`pill ${r.grade ? 'ok' : 'bad'}`} title={r.missed.length ? `Missed: ${r.missed.join('; ')}` : 'Found every seeded defect'}>
                              {r.grade ? 'approval-grade' : 'not approval-grade'} · found {r.caught} of {r.total}, {r.falseAlarms} false alarm{r.falseAlarms === 1 ? '' : 's'}
                            </span>
                          ) : (
                            <span className="pill warn">{r?.error ? `benchmark failed: ${r.error}` : 'not benchmarked'}</span>
                          )}
                          {!run && (
                            <button type="button" className="link small" onClick={() => void runBench(m)}>
                              {r ? 'Run the benchmark again' : 'Run the benchmark'}
                            </button>
                          )}
                        </div>
                      )
                    })}
                    {bench && (
                      <span className="muted">
                        The benchmark is three short read-only reviews of code with {bench.total} seeded defects; a model passes with {bench.pass.caught}{' '}
                        or more found and no more than {bench.pass.falseAlarms} false alarms. It costs what three short reviews cost on that model.
                      </span>
                    )}
                    {benchErr && <span className="error">{benchErr}</span>}
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="hound-opts">
            <div className="hound-opts-title">Confidential sandbox (Cathedral)</div>
            {roomsWhyNot && <p className="muted small">{roomsWhyNot}</p>}
            <label className="check">
              <input type="checkbox" disabled={!!roomsWhyNot} checked={!roomsWhyNot && rooms.sandbox} onChange={(e) => setRooms((r) => ({ ...r, sandbox: e.target.checked }))} />
              <span>
                Run it in a confidential sandbox{' '}
                <span className="muted small">Reviewers may run the code in a confidential Cathedral sandbox, network closed. You approve the room first.</span>
              </span>
            </label>
            <label className="check">
              <input type="checkbox" disabled={!!roomsWhyNot} checked={!roomsWhyNot && rooms.cleanMachine.enabled} onChange={(e) => setClean({ enabled: e.target.checked })} />
              <span>
                Clean-machine test{' '}
                <span className="muted small">
                  BitBull runs your install, build and test commands on the repo's exact commit in a fresh confidential sandbox and saves a certificate with
                  the verdict. Needs a git repo and Cathedral on for this project; you approve the room first.
                </span>
              </span>
            </label>
            {!roomsWhyNot && rooms.cleanMachine.enabled && (
              <>
                <div className="row3">
                  <label className="field">
                    <span>Install</span>
                    <input value={rooms.cleanMachine.install} maxLength={2000} onChange={(e) => setClean({ install: e.target.value })} placeholder="pip install -r requirements.txt" />
                  </label>
                  <label className="field">
                    <span>Build</span>
                    <input value={rooms.cleanMachine.build} maxLength={2000} onChange={(e) => setClean({ build: e.target.value })} placeholder="(optional)" />
                  </label>
                  <label className="field">
                    <span>Test</span>
                    <input value={rooms.cleanMachine.test} maxLength={2000} onChange={(e) => setClean({ test: e.target.value })} placeholder="python -m pytest -q" />
                  </label>
                </div>
                <label className="field">
                  <span>Hosts install may reach (one a line; empty keeps the network closed)</span>
                  <textarea rows={2} value={hosts} onChange={(e) => setHosts(e.target.value)} placeholder={'pypi.org\nfiles.pythonhosted.org'} />
                  <span className="muted small">
                    Commands run in order in the repo's root, one line each; the first that fails stops the rest. The room's time counts against the
                    time limit, and its cost (the room hold) is separate from model spend.
                  </span>
                </label>
              </>
            )}
          </div>
          <p className="muted small">
            Different model families catch different things; two reviewers from the same family mostly share blind spots. Cost: three to five
            full passes over the target, so pick models you can afford.
          </p>
          {stale && (
            <p className="small warn-line">
              <b>{stale.name} is {stale.behind} commit{stale.behind === 1 ? '' : 's'} behind {stale.upstream ?? 'origin'}.</b> The reviewers read
              this workspace copy, so they would review the older code.{' '}
              <button className="link" disabled={syncing} onClick={() => void syncNow()}>
                {syncing ? 'Syncing…' : 'Sync it first'}
              </button>
            </p>
          )}
          {err && <p className="error small">{err}</p>}
          <div className="row end">
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" onClick={start} disabled={busy}>
              {busy ? 'Starting…' : 'Unleash the hounds'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** The top-bar pill while a swarm runs; polls until the verdict turn starts, then hands over to the chat. */
export function SwarmPill({ swarm, onUpdate, onFinalTurn, onOpen }: { swarm: Swarm; onUpdate: (s: Swarm | null) => void; onFinalTurn: (sessionId: string, turnId: string) => void; onOpen?: () => void }) {
  const [seenFinal, setSeenFinal] = useState(false)
  useEffect(() => {
    if (swarm.phase === 'done' || swarm.phase === 'error') return
    const t = setInterval(() => {
      void api
        .swarm(swarm.id)
        .then((r) => {
          onUpdate(r.swarm)
          if (r.swarm.finalTurnId && !seenFinal) {
            setSeenFinal(true)
            onFinalTurn(r.swarm.sessionId, r.swarm.finalTurnId)
          }
        })
        .catch(() => onUpdate(null))
    }, 3000)
    return () => clearInterval(t)
  }, [swarm.id, swarm.phase, seenFinal, onUpdate, onFinalTurn])
  const label =
    swarm.phase === 'review'
      ? 'reviewing'
      : swarm.phase === 'challenge'
        ? 'challenging'
        : swarm.phase === 'final'
          ? 'verdict'
          : swarm.phase === 'done'
            ? 'done'
            : swarm.resumable
              ? 'failed · pick up again'
              : 'failed'
  const detail = swarm.reviewers.map((r) => `${r.model}: ${r.status}${r.error ? ` (${r.error})` : ''}`).join('\n')
  return (
    <span className={`pill swarm-pill ${swarm.phase === 'error' ? 'bad' : swarm.phase === 'done' ? 'ok' : 'run'}`} title={`QA Hound on ${swarm.target}\n${detail}${swarm.error ? `\n${swarm.error}` : ''}`}>
      <button className="link" onClick={() => onOpen?.()} title="Watch the inquiry">
        QA Hound · {label}
      </button>
      {swarm.phase === 'done' || swarm.phase === 'error' ? (
        <button className="link small" onClick={() => onUpdate(null)} aria-label="Dismiss">
          ×
        </button>
      ) : null}
    </span>
  )
}
