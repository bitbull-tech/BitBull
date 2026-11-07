/**
 * White-labelling.
 *
 * The UI never hard-codes a colour, a name or a logo: it reads them from here. The server
 * serves `<DATA_DIR>/brand.json` at /api/brand, so an operator can rename and re-skin the
 * product by dropping in a file and reloading the page — no rebuild, no deploy.
 *
 * Overrides are applied as CSS custom properties, which is why values are validated again
 * on this side: whatever arrives, it cannot escape its declaration.
 *
 * See docs/BRANDING.md.
 */

/** The tokens a brand may override, as declared in index.css. Keep the two in step. */
export const BRAND_TOKENS = [
  'bg', 'bg-tint-1', 'bg-tint-2', 'panel', 'panel-2', 'code-bg',
  'text', 'text-2', 'muted', 'line', 'line-2', 'hover',
  'accent', 'accent-2', 'accent-soft', 'accent-text', 'user', 'user-text',
  'side', 'side-2', 'side-text', 'side-text-2', 'side-muted', 'side-line', 'side-hover', 'side-accent', 'side-accent-text',
  'ok', 'bad', 'warn',
  'radius', 'radius-sm', 'radius-lg', 'shadow', 'shadow-lg',
  'font', 'display', 'serif', 'mono',
] as const
export type BrandToken = (typeof BRAND_TOKENS)[number]

export interface Brand {
  name: string
  tagline: string
  /** Filename inside <DATA_DIR>/brand/; resolved to /api/brand/asset/<file> */
  logo: string | null
  logoDark: string | null
  icon: string | null
  mark: string
  tokens: { light: Partial<Record<BrandToken, string>>; dark: Partial<Record<BrandToken, string>> }
  /** Background and sidebar picked in Settings → Appearance (#rrggbb); the rest is derived below */
  scheme: Scheme
}

export type SchemePart = { bg?: string; side?: string }
export type Scheme = { light: SchemePart; dark: SchemePart }

export const defaultBrand: Brand = {
  name: 'BitBull',
  tagline: 'The Bittensor Builder',
  logo: null,
  logoDark: null,
  icon: null,
  mark: '',
  tokens: { light: {}, dark: {} },
  scheme: { light: {}, dark: {} },
}

let current: Brand = defaultBrand
export const getBrand = () => current
export const assetUrl = (file: string | null) => (file ? `/api/brand/asset/${encodeURIComponent(file)}` : null)

const safe = (v: unknown) => {
  const s = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120) : ''
  if (!s || /[;{}<>\\]/.test(s) || /url\s*\(|@import|expression\s*\(|javascript:/i.test(s)) return null
  return s
}

const declarations = (tokens: Partial<Record<BrandToken, string>>) =>
  BRAND_TOKENS.map((t) => {
    const v = safe(tokens[t])
    return v ? `  --${t}: ${v};` : ''
  })
    .filter(Boolean)
    .join('\n')

/* ---------------- colour schemes ---------------- */

const HEX = /^#[0-9a-f]{6}$/i
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
const toHex = (c: number[]) => '#' + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')
/** a mixed t of the way towards b */
const mix = (a: string, b: string, t: number) => toHex(rgb(a).map((v, i) => v + (rgb(b)[i] - v) * t))
const luminance = (hex: string) => {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
/** Whether light text reads better than dark text on this colour (WCAG contrast). */
export const wantsLightText = (hex: string) => 1.05 / (luminance(hex) + 0.05) >= (luminance(hex) + 0.05) / 0.05

/**
 * One picked background becomes the whole main-area palette: panels, lines and ink are worked out
 * from it, light ink on a dark colour and dark ink on a light one, whichever theme it is set for.
 */
function bgTokens(bg: string): Partial<Record<BrandToken, string>> {
  if (wantsLightText(bg))
    return {
      bg,
      panel: mix(bg, '#ffffff', 0.05),
      'panel-2': mix(bg, '#ffffff', 0.08),
      'code-bg': mix(bg, '#000000', 0.18),
      line: mix(bg, '#ffffff', 0.11),
      'line-2': mix(bg, '#ffffff', 0.17),
      hover: 'rgb(255 255 255 / 0.055)',
      text: '#f2efe6',
      'text-2': '#d2cec2',
      muted: '#918d81',
      user: mix(bg, '#ffffff', 0.1),
      'user-text': '#f2efe6',
    }
  return {
    bg,
    panel: mix(bg, '#ffffff', 0.75),
    'panel-2': mix(bg, '#ffffff', 0.45),
    'code-bg': mix(bg, '#000000', 0.04),
    line: mix(bg, '#000000', 0.08),
    'line-2': mix(bg, '#000000', 0.13),
    hover: 'rgb(0 0 0 / 0.05)',
    text: '#1b1a16',
    'text-2': '#45423a',
    muted: '#78746a',
    user: mix(bg, '#1c7ed6', 0.08),
    'user-text': '#16243a',
  }
}

/** The sidebar from one colour: its raised surface, text and accent chosen to read on it. */
function sideTokens(side: string): Partial<Record<BrandToken, string>> {
  const light = wantsLightText(side)
  return {
    side,
    'side-2': mix(side, light ? '#ffffff' : '#000000', 0.07),
    'side-text': light ? '#f3efe2' : '#1b1a16',
    'side-text-2': light ? '#cdc8b8' : '#45423a',
    'side-muted': light ? '#928d7c' : '#78746a',
    'side-line': light ? 'rgb(255 255 255 / 0.08)' : 'rgb(0 0 0 / 0.09)',
    'side-hover': light ? 'rgb(255 255 255 / 0.06)' : 'rgb(0 0 0 / 0.05)',
    'side-accent': light ? '#f3c249' : '#1c7ed6',
    'side-accent-text': light ? '#15150f' : '#ffffff',
  }
}

export function schemeTokens(part: SchemePart): Partial<Record<BrandToken, string>> {
  return {
    ...(part.bg && HEX.test(part.bg) ? bgTokens(part.bg) : {}),
    ...(part.side && HEX.test(part.side) ? sideTokens(part.side) : {}),
  }
}

/** Ready-made schemes for Settings → Appearance. Classic is the built-in palette. */
export const PRESETS: { id: string; name: string; scheme: Scheme }[] = [
  { id: 'classic', name: 'Classic', scheme: { light: {}, dark: {} } },
  { id: 'bulldog', name: 'Bulldog', scheme: { light: { bg: '#f4f4f2', side: '#3a3a3c' }, dark: { bg: '#111113', side: '#1c1c1f' } } },
  { id: 'slate', name: 'Slate', scheme: { light: { bg: '#f3f5f8', side: '#1e293b' }, dark: { bg: '#0b1120', side: '#111827' } } },
  { id: 'ocean', name: 'Ocean', scheme: { light: { bg: '#f1f7fb', side: '#0f3554' }, dark: { bg: '#07121c', side: '#0a1b2b' } } },
  { id: 'forest', name: 'Forest', scheme: { light: { bg: '#f3f6f1', side: '#1f3a2b' }, dark: { bg: '#0c120e', side: '#0f1d15' } } },
  { id: 'bordeaux', name: 'Bordeaux', scheme: { light: { bg: '#faf5f3', side: '#3b1420' }, dark: { bg: '#120a0c', side: '#1c0c12' } } },
  { id: 'paper', name: 'Paper', scheme: { light: { bg: '#ffffff', side: '#f1ede3' }, dark: { bg: '#121212', side: '#1d1d1b' } } },
]

/**
 * Write the overrides into a single <style> element. The dark set is applied in both the
 * places index.css declares it: under the media query and under the explicit toggle.
 */
export function applyBrand(brand: Brand) {
  current = brand
  const scheme = brand.scheme ?? { light: {}, dark: {} }
  // picked colours win over brand.json's own tokens: they are the more recent, deliberate choice
  const light = declarations({ ...brand.tokens.light, ...schemeTokens(scheme.light ?? {}) })
  const dark = declarations({ ...brand.tokens.dark, ...schemeTokens(scheme.dark ?? {}) })
  const css = [
    light && `:root {\n${light}\n}`,
    dark && `@media (prefers-color-scheme: dark) {\n  :root:not([data-theme='light']) {\n${dark}\n  }\n}`,
    dark && `:root[data-theme='dark'] {\n${dark}\n}`,
  ]
    .filter(Boolean)
    .join('\n')

  let el = document.getElementById('brand-tokens')
  if (!el) {
    el = document.createElement('style')
    el.id = 'brand-tokens'
    document.head.appendChild(el)
  }
  el.textContent = css

  document.title = brand.name
  const icon = assetUrl(brand.icon ?? brand.logo)
  if (icon) {
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    if (!link) {
      link = document.createElement('link')
      link.rel = 'icon'
      document.head.appendChild(link)
    }
    link.href = icon
  }
}

/** Fetch the operator's brand once at start-up. Any failure leaves the defaults in place. */
export async function loadBrand(): Promise<Brand> {
  try {
    const res = await fetch('/api/brand')
    if (!res.ok) return current
    const raw = (await res.json()) as Partial<Brand>
    applyBrand({
      ...defaultBrand,
      ...raw,
      tokens: { light: raw.tokens?.light ?? {}, dark: raw.tokens?.dark ?? {} },
      scheme: { light: raw.scheme?.light ?? {}, dark: raw.scheme?.dark ?? {} },
    })
  } catch {
    /* offline or an older server: the built-in brand is already applied */
  }
  return current
}
