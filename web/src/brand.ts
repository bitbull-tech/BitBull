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
}

export const defaultBrand: Brand = {
  name: 'BitBull',
  tagline: 'The Bittensor Builder',
  logo: null,
  logoDark: null,
  icon: null,
  mark: '',
  tokens: { light: {}, dark: {} },
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

/**
 * Write the overrides into a single <style> element. The dark set is applied in both the
 * places index.css declares it: under the media query and under the explicit toggle.
 */
export function applyBrand(brand: Brand) {
  current = brand
  const light = declarations(brand.tokens.light)
  const dark = declarations(brand.tokens.dark)
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
    })
  } catch {
    /* offline or an older server: the built-in brand is already applied */
  }
  return current
}
