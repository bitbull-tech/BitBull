/**
 * White-labelling: name, logos and colours, read from `<DATA_DIR>/brand.json` and served
 * to every client. Nothing here needs a rebuild or a deploy — drop in a file and reload.
 *
 * The values end up as CSS custom properties in the browser, so they are validated hard:
 * a token name must be one we know, and a value may not contain the characters that would
 * let it escape its declaration. Assets may only be image files inside `<DATA_DIR>/brand/`.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { record } from "./activity.js";

/** Tokens a brand may override, matching the ones declared in web/src/index.css. */
export const BRAND_TOKENS = [
  "bg", "bg-tint-1", "bg-tint-2", "panel", "panel-2", "code-bg",
  "text", "text-2", "muted", "line", "line-2", "hover",
  "accent", "accent-2", "accent-soft", "accent-text", "user", "user-text",
  "side", "side-2", "side-text", "side-text-2", "side-muted", "side-line", "side-hover", "side-accent", "side-accent-text",
  "ok", "bad", "warn",
  "radius", "radius-sm", "radius-lg", "shadow", "shadow-lg",
  "font", "display", "serif", "mono",
] as const;
export type BrandToken = (typeof BRAND_TOKENS)[number];

export interface Brand {
  name: string;
  tagline: string;
  /** Filenames inside <DATA_DIR>/brand/, served from /api/brand/asset/<file> */
  logo: string | null;
  logoDark: string | null;
  icon: string | null;
  /** 1–3 characters drawn when there is no logo image */
  mark: string;
  tokens: { light: Partial<Record<BrandToken, string>>; dark: Partial<Record<BrandToken, string>> };
}

export const defaultBrand: Brand = {
  name: "BitBob",
  tagline: "The Bittensor Builder",
  logo: null,
  logoDark: null,
  icon: null,
  mark: "",
  tokens: { light: {}, dark: {} },
};

const ASSET_EXT = new Set([".svg", ".png", ".jpg", ".jpeg", ".webp", ".ico"]);
const brandDir = () => path.join(config.dataDir, "brand");
const brandFile = () => path.join(config.dataDir, "brand.json");

const clean = (v: unknown, max: number) =>
  typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) : "";

/**
 * A CSS value that cannot break out of `--token: <value>;`. Semicolons and braces would
 * end the declaration or the rule; url() and @import would let a brand file fetch things.
 */
function safeValue(v: unknown): string | null {
  const s = clean(v, 120);
  if (!s) return null;
  if (/[;{}<>\\]/.test(s)) return null;
  if (/url\s*\(|@import|expression\s*\(|javascript:/i.test(s)) return null;
  return s;
}

/** A bare image filename inside the brand folder: no paths, no traversal, no surprises. */
function safeAsset(v: unknown): string | null {
  const s = clean(v, 80);
  if (!s || s.includes("/") || s.includes("\\") || s.startsWith(".")) return null;
  if (!ASSET_EXT.has(path.extname(s).toLowerCase())) return null;
  return existsSync(path.join(brandDir(), s)) ? s : null;
}

function tokensOf(raw: unknown): Partial<Record<BrandToken, string>> {
  const out: Partial<Record<BrandToken, string>> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = k.replace(/^--/, "") as BrandToken;
    if (!(BRAND_TOKENS as readonly string[]).includes(key)) continue;
    const value = safeValue(v);
    if (value) out[key] = value;
  }
  return out;
}

export function parseBrand(raw: unknown): Brand {
  const r = (raw ?? {}) as Record<string, unknown>;
  const t = (r.tokens ?? {}) as Record<string, unknown>;
  return {
    name: clean(r.name, 60) || defaultBrand.name,
    tagline: clean(r.tagline, 120) || (r.tagline === "" ? "" : defaultBrand.tagline),
    logo: safeAsset(r.logo),
    logoDark: safeAsset(r.logoDark),
    icon: safeAsset(r.icon),
    mark: clean(r.mark, 3) || defaultBrand.mark,
    tokens: { light: tokensOf(t.light), dark: tokensOf(t.dark) },
  };
}

let cached: { brand: Brand; mtime: number } | null = null;

/** The active brand. Re-read whenever brand.json changes; falls back to the default. */
export function brand(): Brand {
  const file = brandFile();
  try {
    if (!existsSync(file)) {
      cached = null;
      return defaultBrand;
    }
    const mtime = statSync(file).mtimeMs;
    if (cached && cached.mtime === mtime) return cached.brand;
    const parsed = parseBrand(JSON.parse(readFileSync(file, "utf8")));
    cached = { brand: parsed, mtime };
    return parsed;
  } catch (e) {
    record({ level: "warn", source: "config", message: `brand.json could not be read: ${e instanceof Error ? e.message : String(e)}` });
    return cached?.brand ?? defaultBrand;
  }
}

/** Absolute path of a brand asset, or null if it isn't one we are willing to serve. */
export function brandAsset(name: string): string | null {
  const safe = safeAsset(name);
  return safe ? path.join(brandDir(), safe) : null;
}
