// BitBull browser extension: send the page you're looking at to your local BitBull.
// Read-only: it only reads the active tab, and only when you click. Nothing is sent anywhere
// but the BitBull address below (this computer).

const $ = (id) => document.getElementById(id)
const DEFAULT_BASE = 'http://localhost:8787'

async function settings() {
  const s = await chrome.storage.local.get(['base', 'token'])
  return { base: (s.base || DEFAULT_BASE).replace(/\/+$/, ''), token: s.token || '' }
}

function status(text, kind = '') {
  const el = $('status')
  el.textContent = text
  el.className = `status ${kind}`
}

/** Runs inside the page (isolated world): what it says and how it is built. Capped everywhere. */
function collectPage() {
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
  const cut = (s, n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n)
  const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')]
    .filter(visible)
    .map((h) => ({ level: Number(h.tagName[1]), text: cut(h.innerText, 300) }))
    .filter((h) => h.text)
    .slice(0, 300)
  const links = [...document.querySelectorAll('a[href]')]
    .map((a) => ({ text: cut(a.innerText || a.getAttribute('aria-label') || a.title, 300), href: String(a.href).slice(0, 2000) }))
    .filter((l) => /^https?:/i.test(l.href))
    .slice(0, 500)
  const imagesWithoutAlt = [...document.images]
    .filter((i) => !i.hasAttribute('alt') && visible(i))
    .map((i) => String(i.currentSrc || i.src).slice(0, 2000))
    .slice(0, 200)
  const unlabelledInputs = [...document.querySelectorAll('input, select, textarea')]
    .filter((el) => el.type !== 'hidden' && el.type !== 'submit' && el.type !== 'button' && visible(el))
    .filter((el) => !(el.labels && el.labels.length) && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby') && !el.title)
    .map((el) => cut(`${el.tagName.toLowerCase()}${el.type ? `[type=${el.type}]` : ''}${el.name ? ` name=${el.name}` : ''}${el.placeholder ? ` placeholder="${el.placeholder}"` : ''}`, 300))
    .slice(0, 200)
  const failedRequests = performance
    .getEntriesByType('resource')
    .concat(performance.getEntriesByType('navigation'))
    .filter((e) => e.responseStatus >= 400)
    .map((e) => ({ url: String(e.name).slice(0, 2000), status: e.responseStatus }))
    .slice(0, 200)
  const meta = document.querySelector('meta[name="description"]')
  const selection = String(window.getSelection() || '').slice(0, 20000)
  return {
    url: location.href,
    title: document.title.slice(0, 500),
    description: meta ? cut(meta.content, 1000) : undefined,
    lang: document.documentElement.lang ? document.documentElement.lang.slice(0, 40) : undefined,
    selection: selection.trim() ? selection : undefined,
    text: document.body ? document.body.innerText.slice(0, 150000) : '',
    headings,
    links,
    imagesWithoutAlt,
    unlabelledInputs,
    failedRequests,
    viewport: { width: innerWidth, height: innerHeight, scrollY: Math.round(scrollY), pageHeight: document.documentElement.scrollHeight },
  }
}

async function send() {
  const { base, token } = await settings()
  if (!token) {
    $('settings').open = true
    return status('Add your BitBull access token below first.', 'bad')
  }
  $('send').disabled = true
  status('Reading the page…')
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab || !/^https?:|^file:/.test(tab.url || '')) throw new Error("Browsers don't let extensions read this kind of page (browser settings, the web store, other extensions).")
    const [{ result: page }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: collectPage })
    if ($('shot').checked) {
      // PNG is sharp for text; a very large screen falls back to JPEG to stay under the size limit
      let shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
      if (shot.length > 12_000_000) shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 80 })
      page.screenshot = shot
    }
    status('Sending to BitBull…')
    const res = await fetch(`${base}/api/captures`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(page),
    })
    if (res.status === 401) throw new Error('BitBull refused the access token. Check it under Connection.')
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `BitBull said ${res.status}`)
    status('Sent. It is attached to the chat you have open in BitBull.', 'ok')
    $('open').hidden = false
  } catch (e) {
    const msg = e && e.message ? e.message : String(e)
    status(/Failed to fetch|NetworkError/i.test(msg) ? `Can't reach BitBull at ${base}. Is it running?` : msg, 'bad')
  } finally {
    $('send').disabled = false
  }
}

async function openBitBull() {
  const { base } = await settings()
  const tabs = await chrome.tabs.query({ url: [`${base}/*`] }).catch(() => [])
  if (tabs[0]) {
    await chrome.tabs.update(tabs[0].id, { active: true })
    await chrome.windows.update(tabs[0].windowId, { focused: true })
  } else await chrome.tabs.create({ url: base })
  window.close()
}

async function test() {
  const base = ($('base').value.trim() || DEFAULT_BASE).replace(/\/+$/, '')
  const token = $('token').value.trim()
  status('Testing…')
  try {
    const res = await fetch(`${base}/api/config`, { headers: { authorization: `Bearer ${token}` } })
    if (res.status === 401) return status('BitBull is there, but the token is wrong.', 'bad')
    status(res.ok ? 'Connected to BitBull.' : `BitBull said ${res.status}`, res.ok ? 'ok' : 'bad')
  } catch {
    status(`Can't reach BitBull at ${base}.`, 'bad')
  }
}

async function init() {
  const { base, token } = await settings()
  $('base').value = base
  $('token').value = token
  $('where').textContent = base.replace(/^https?:\/\//, '')
  if (!token) $('settings').open = true
  $('send').onclick = send
  $('open').onclick = openBitBull
  $('test').onclick = test
  $('save').onclick = async () => {
    const b = ($('base').value.trim() || DEFAULT_BASE).replace(/\/+$/, '')
    if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(b)) return status('The address must be BitBull on this computer, e.g. http://localhost:8787.', 'bad')
    await chrome.storage.local.set({ base: b, token: $('token').value.trim() })
    $('where').textContent = b.replace(/^https?:\/\//, '')
    status('Saved.', 'ok')
  }
}
init()
