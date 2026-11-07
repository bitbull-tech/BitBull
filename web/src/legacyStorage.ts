/**
 * BitBull was called BitBob until 7 Nov 2026, and this browser kept its settings under bitbob-*
 * keys: the sign-in token, chosen model, theme, sidebar width, activity dock. Copy them to the new
 * names once, before anything reads them, so the rename doesn't sign you out and reset the UI.
 *
 * This must stay the FIRST import in main.tsx: module bodies run in import order, and theme.ts
 * reads its key the moment it loads. The old keys are left in place for a rollback.
 */
try {
  const legacy: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k && k.startsWith('bitbob-')) legacy.push(k)
  }
  for (const k of legacy) {
    const next = 'bitbull-' + k.slice('bitbob-'.length)
    const v = localStorage.getItem(k)
    if (v !== null && localStorage.getItem(next) === null) localStorage.setItem(next, v)
  }
} catch {
  /* storage blocked (private window, policy): nothing to carry over */
}

export {}
