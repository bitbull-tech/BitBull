// The spend-cap rule, kept identical to effectiveCathedralCap() in server/src/config.ts.
// A test checks both give the same number on the same input.
//
// raw is the CATHEDRAL_MAX_SPEND_USD setting. A positive decimal up to 25.00 is used as given;
// anything else (unset, empty, text, zero, negative, above 25) falls back to 0.50.
export const CATHEDRAL_DEFAULT_CAP_USD = 0.5;
export const CATHEDRAL_MAX_CAP_USD = 25;

export function effectiveCathedralCap(raw) {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!/^\d+(\.\d+)?$/.test(s)) return CATHEDRAL_DEFAULT_CAP_USD;
  const n = Number(s);
  if (!(n > 0) || n > CATHEDRAL_MAX_CAP_USD) return CATHEDRAL_DEFAULT_CAP_USD;
  return n;
}
