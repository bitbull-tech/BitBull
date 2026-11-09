/**
 * QA Hound's rules, kept apart from the run itself so they can be tested: the options a run takes
 * (budget, time, thresholds, scope, PR verdict), the findings the verdict ends with, which of them
 * are shown and why the rest are held back, and the review that goes on a pull request.
 */

export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];
const rank = (s: Severity) => SEVERITIES.indexOf(s);

export interface HoundOptions {
  /** hard cap for the whole run, reviewers and verdict together (USD) */
  budgetUsd: number;
  /** hard time limit for the whole run */
  maxMinutes: number;
  /** findings below this severity are recorded but not shown or posted */
  minSeverity: Severity;
  /** the handler scores each finding 0–100; below this it is held back */
  minConfidence: number;
  /** globs, relative to the target: review only these (empty = everything) */
  include: string[];
  /** globs, relative to the target: never these (an exclude always wins) */
  exclude: string[];
  /** post the verdict on the pull request of the target repo's current branch */
  pr: boolean;
  /** a shown finding at or above this requests changes; none, and the PR is approved */
  prBlocking: Severity;
}

export const DEFAULT_OPTIONS: HoundOptions = {
  budgetUsd: 2,
  maxMinutes: 45,
  minSeverity: "low",
  minConfidence: 70,
  include: [],
  exclude: [],
  pr: false,
  prBlocking: "high",
};

const sev = (v: unknown, d: Severity): Severity => (typeof v === "string" && (SEVERITIES as readonly string[]).includes(v.toLowerCase()) ? (v.toLowerCase() as Severity) : d);
const clamp = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const globs = (v: unknown) =>
  (Array.isArray(v) ? v : typeof v === "string" ? v.split(/\r?\n/) : [])
    .map((g) => String(g).trim())
    .filter((g) => g && g.length <= 200 && !g.includes(".."))
    .slice(0, 30);

export function houndOptions(raw: Partial<Record<keyof HoundOptions, unknown>> = {}): HoundOptions {
  return {
    budgetUsd: Math.round(clamp(raw.budgetUsd, 0.05, 100, DEFAULT_OPTIONS.budgetUsd) * 100) / 100,
    maxMinutes: Math.round(clamp(raw.maxMinutes, 5, 120, DEFAULT_OPTIONS.maxMinutes)),
    minSeverity: sev(raw.minSeverity, DEFAULT_OPTIONS.minSeverity),
    minConfidence: Math.round(clamp(raw.minConfidence, 0, 100, DEFAULT_OPTIONS.minConfidence)),
    include: globs(raw.include),
    exclude: globs(raw.exclude),
    pr: raw.pr === true,
    prBlocking: sev(raw.prBlocking, DEFAULT_OPTIONS.prBlocking),
  };
}

/** Glob → RegExp: ** any path, * within one segment, ? one character. A bare name matches anywhere. */
export function globRe(glob: string): RegExp {
  let g = glob.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!g.includes("/")) g = `**/${g}`;
  if (g.endsWith("/")) g += "**";
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") {
      const slash = g[i + 2] === "/";
      re += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

/** Whether a path is in scope: an exclude always wins; with no includes everything else is in. */
export function inScope(p: string, include: string[], exclude: string[]): boolean {
  const path = p.replace(/\\/g, "/").replace(/^\.?\//, "").replace(/:\d+(-\d+)?$/, "");
  if (exclude.some((g) => globRe(g).test(path))) return false;
  return !include.length || include.some((g) => globRe(g).test(path));
}

export interface Finding {
  severity: Severity;
  /** 0–100: how sure the handler is that it is real, after checking */
  confidence: number;
  path: string;
  line?: number;
  title: string;
  detail?: string;
  fix?: string;
  foundBy: string[];
  status: "confirmed" | "disputed" | "single";
  /** shown in the verdict and on the PR, or held back with the reason */
  shown: boolean;
  heldBecause?: string;
}

export type Verdict = "use" | "fix-first" | "do-not-use";

/** The machine-readable block the handler ends its verdict with. */
export const FINDINGS_FENCE = "qa-hound";

const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, max) : "");

/**
 * Read the handler's findings block. Its text came from a model that read possibly hostile
 * content: every field is typed, trimmed and capped; anything malformed is dropped.
 */
export function parseFindings(text: string, o: HoundOptions): { verdict?: Verdict; findings: Finding[] } {
  const blocks = [...text.matchAll(new RegExp("```" + FINDINGS_FENCE + "\\s*\\n([\\s\\S]*?)```", "g"))];
  const raw = blocks.at(-1)?.[1];
  if (!raw) return { findings: [] };
  let j: { verdict?: unknown; findings?: unknown };
  try {
    j = JSON.parse(raw);
  } catch {
    return { findings: [] };
  }
  const verdict = (["use", "fix-first", "do-not-use"] as const).find((v) => v === j.verdict);
  const list = Array.isArray(j.findings) ? j.findings.slice(0, 100) : [];
  const findings: Finding[] = [];
  for (const f of list) {
    if (!f || typeof f !== "object") continue;
    const r = f as Record<string, unknown>;
    const title = str(r.title, 200);
    if (!title) continue;
    const line = typeof r.line === "number" && r.line > 0 ? Math.floor(r.line) : undefined;
    const status = (["confirmed", "disputed", "single"] as const).find((s) => s === r.status) ?? "single";
    const finding: Finding = {
      severity: sev(r.severity, "low"),
      confidence: Math.round(clamp(r.confidence, 0, 100, 0)),
      path: str(r.path, 300),
      line,
      title,
      detail: str(r.detail, 1200) || undefined,
      fix: str(r.fix, 1200) || undefined,
      foundBy: (Array.isArray(r.foundBy) ? r.foundBy : []).map((x) => str(x, 80)).filter(Boolean).slice(0, 4),
      status,
      shown: true,
    };
    findings.push(judge(finding, o));
  }
  // most serious and most certain first
  findings.sort((a, b) => Number(b.shown) - Number(a.shown) || rank(b.severity) - rank(a.severity) || b.confidence - a.confidence);
  return { verdict, findings };
}

/** Apply the thresholds and scope: shown, or held back with the reason. */
export function judge(f: Finding, o: HoundOptions): Finding {
  const why: string[] = [];
  if (rank(f.severity) < rank(o.minSeverity)) why.push(`below ${o.minSeverity} severity`);
  if (f.confidence < o.minConfidence) why.push(`confidence ${f.confidence} < ${o.minConfidence}`);
  if (f.path && !inScope(f.path, o.include, o.exclude)) why.push("outside the scope filters");
  return { ...f, shown: !why.length, heldBecause: why.length ? why.join(", ") : undefined };
}

/** What the PR gets: request changes for a shown finding at or above the blocking severity, else approve; a partial run only comments. */
export function prEvent(findings: Finding[], o: HoundOptions, complete: boolean): "APPROVE" | "REQUEST_CHANGES" | "COMMENT" {
  if (findings.some((f) => f.shown && rank(f.severity) >= rank(o.prBlocking))) return "REQUEST_CHANGES";
  return complete ? "APPROVE" : "COMMENT";
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** The review body for GitHub: the verdict, the shown findings, how many were held back. */
export function prBody(input: { target: string; models: string[]; verdict?: Verdict; findings: Finding[]; spentUsd: number; partial?: string }): string {
  const shown = input.findings.filter((f) => f.shown);
  const held = input.findings.length - shown.length;
  const verdict = { use: "✅ Use as is", "fix-first": "🛠️ Fix first", "do-not-use": "⛔ Do not use" }[input.verdict ?? "fix-first"];
  const lines = [
    `### 🐶 QA Hound: ${verdict}`,
    `\`${input.target}\` reviewed by ${input.models.join(" and ")}, checked against each other.${input.partial ? ` **Partial run:** ${input.partial}.` : ""}`,
    "",
  ];
  if (shown.length) {
    lines.push("| Severity | Confidence | Where | Finding | Fix |", "| --- | --- | --- | --- | --- |");
    for (const f of shown) lines.push(`| ${f.severity} | ${f.confidence} | \`${cell(f.path)}${f.line ? `:${f.line}` : ""}\` | ${cell(f.title)} | ${cell(f.fix ?? "")} |`);
  } else lines.push("No findings above the thresholds.");
  if (held) lines.push("", `<sub>${held} more finding${held === 1 ? "" : "s"} held back (below the severity or confidence threshold, or outside the scope).</sub>`);
  lines.push("", `<sub>Posted from BitBull · cost $${input.spentUsd.toFixed(2)}</sub>`);
  return lines.join("\n");
}
