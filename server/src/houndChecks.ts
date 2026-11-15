/**
 * What BitBull checks about a QA Hound run by itself, without taking any model's word for it.
 * A verdict is written by a model that has just read the code under review; a weak or misled one
 * writes "no problems" as fluently as a strong one. So an approval also needs:
 *
 *  - quotes: every finding quotes the code it is about, and the quote is really in that file;
 *  - coverage: every file the pull request changed was opened by a reviewer (from the tool log);
 *  - planted defects: each reviewer model, in a side test on an excerpt of this code with known
 *    defects added, found them;
 *  - commit: the working copy that was reviewed is the commit the pull request is at.
 *
 * Everything read here (files, tool logs, model output, file names from GitHub) is untrusted.
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Finding } from "./hound.js";

export interface Check {
  id: "quotes" | "coverage" | "planted" | "commit";
  ok: boolean;
  /** one sentence, shown in BitBull and in the review */
  text: string;
}

const MAX_FILE = 2 * 1024 * 1024;
const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const posix = (p: string) => p.split(path.sep).join("/");

/** A file under one of the roots, by a path a model gave, that really is inside the workspace. */
function findFile(ws: string, roots: string[], rel: string): string | null {
  const clean = rel
    .replace(/\\/g, "/")
    .replace(/:\d+(-\d+)?$/, "")
    .split("/")
    .filter((x) => x && x !== "." && x !== "..")
    .join("/");
  if (!clean) return null;
  let realWs: string;
  try {
    realWs = realpathSync(ws);
  } catch {
    return null;
  }
  for (const root of roots) {
    const abs = path.join(root, clean);
    try {
      const real = realpathSync(abs);
      if (real !== realWs && !real.startsWith(realWs + path.sep)) continue;
      const st = lstatSync(real);
      if (st.isFile() && st.size <= MAX_FILE) return real;
    } catch {
      /* not here: try the next root */
    }
  }
  return null;
}

/** Too short to prove anything: "}" or "return x" is in every file. */
const MIN_QUOTE = 12;

/**
 * Is the code a finding quotes really in the file it names? "none" when there is nothing to check
 * (no path, no quote, or a quote too short to mean anything), "mismatch" when the file isn't there
 * or doesn't contain it. White space is ignored. When the quote is found, so is its line.
 */
export function checkQuote(ws: string, roots: string[], f: { path: string; line?: number; quote?: string }): { evidence: "verified" | "mismatch" | "none"; line?: number } {
  const quote = squash(f.quote ?? "");
  if (!f.path || quote.length < MIN_QUOTE) return { evidence: "none" };
  const file = findFile(ws, roots, f.path);
  if (!file) return { evidence: "mismatch" };
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { evidence: "mismatch" };
  }
  if (!squash(text).includes(quote)) return { evidence: "mismatch" };
  // the line: where the quote's first line is, nearest to the one the finding gave
  const first = squash((f.quote ?? "").split(/\r?\n/).find((l) => l.trim()) ?? "");
  const lines = text.split(/\r?\n/);
  let best: number | undefined;
  for (let i = 0; i < lines.length; i++) {
    const l = squash(lines[i]);
    if (!l || !(l.includes(first) || (first.includes(l) && l.length >= MIN_QUOTE))) continue;
    if (best === undefined || Math.abs(i + 1 - (f.line ?? 0)) < Math.abs(best - (f.line ?? 0))) best = i + 1;
  }
  return { evidence: "verified", line: best ?? f.line };
}

/** Check every finding's quote; one that doesn't match is held back, saying so. */
export function verifyFindings(ws: string, roots: string[], findings: Finding[]): Finding[] {
  return findings.map((f) => {
    const r = checkQuote(ws, roots, f);
    if (r.evidence === "verified") return { ...f, evidence: r.evidence, line: r.line ?? f.line };
    if (r.evidence === "none") return { ...f, evidence: r.evidence };
    const why = "the code it quotes isn't in that file";
    return { ...f, evidence: r.evidence, shown: false, heldBecause: f.heldBecause ? `${f.heldBecause}, ${why}` : why };
  });
}

/** One or two slips in a long list are reformatting; more than that and the list can't be relied on. */
export function quotesCheck(findings: Finding[]): Check {
  const quoted = findings.filter((f) => f.evidence === "verified" || f.evidence === "mismatch");
  const bad = quoted.filter((f) => f.evidence === "mismatch").length;
  const none = findings.length - quoted.length;
  const tail = none ? ` ${none} gave no usable quote.` : "";
  if (!findings.length) return { id: "quotes", ok: true, text: "Quotes: there were no findings to check against the code." };
  if (bad >= 2 || bad * 5 > quoted.length) return { id: "quotes", ok: false, text: `Quotes: ${bad} of ${quoted.length} findings quote code that isn't in the file they name, so the list can't be relied on.${tail}` };
  return { id: "quotes", ok: true, text: `Quotes: ${quoted.length - bad} of ${quoted.length} quoted findings match the code.${bad ? ` ${bad} didn't and was held back.` : ""}${tail}` };
}

/** A file name from GitHub, as data: nothing odd in it, and not too long to show. */
export const safeName = (n: unknown) => (typeof n === "string" && n.length <= 300 && /^[^\u0000-\u001f`<>|"*?\\]+$/.test(n) && !n.split("/").includes("..") ? n : null);

/**
 * Which of the files the pull request changed did no reviewer open? `opened` is every path a
 * reviewer's tools were pointed at (absolute, or relative to the workspace).
 */
export function coverageCheck(changed: string[] | undefined, opened: string[], ws: string, repoDir: string, why?: string): Check {
  if (!changed) return { id: "coverage", ok: false, text: `Coverage: the pull request's changed files couldn't be listed${why ? ` (${why})` : ""}, so there is no proof they were read.` };
  const name = path.basename(repoDir);
  const seen = new Set<string>();
  for (const p of opened) {
    const abs = path.isAbsolute(p) ? p : path.resolve(ws, p);
    const rel = posix(path.relative(repoDir, abs));
    if (rel && !rel.startsWith("..")) seen.add(rel);
    // the same file seen through another mount point: match on <repo>/<path>
    const at = posix(abs).lastIndexOf(`/${name}/`);
    if (at >= 0) seen.add(posix(abs).slice(at + name.length + 2));
  }
  const unread = changed.filter((f) => !seen.has(f));
  if (!unread.length) return { id: "coverage", ok: true, text: `Coverage: all ${changed.length} changed file${changed.length === 1 ? " was" : "s were"} opened by a reviewer.` };
  const show = unread.slice(0, 8).map((f) => `\`${f}\``).join(", ");
  return { id: "coverage", ok: false, text: `Coverage: ${unread.length} of ${changed.length} changed file${changed.length === 1 ? "" : "s"} ${unread.length === 1 ? "was" : "were"} not opened by any reviewer: ${show}${unread.length > 8 ? `, and ${unread.length - 8} more` : ""}.` };
}

/** The review is of the working copy; the approval is of a commit. They have to be the same thing. */
export function commitCheck(localSha: string | undefined, prSha: string, dirty: number): Check {
  if (!localSha) return { id: "commit", ok: false, text: "Commit: the working copy's commit couldn't be read." };
  if (!prSha.startsWith(localSha) && !localSha.startsWith(prSha)) return { id: "commit", ok: false, text: `Commit: the copy that was reviewed is at ${localSha.slice(0, 7)}, the pull request is at ${prSha.slice(0, 7)}. Sync the copy and run again.` };
  if (dirty) return { id: "commit", ok: false, text: `Commit: the copy that was reviewed has ${dirty} uncommitted change${dirty === 1 ? "" : "s"}, so it isn't exactly what the pull request holds.` };
  return { id: "commit", ok: true, text: `Commit: the copy that was reviewed is the pull request's commit (${prSha.slice(0, 7)}).` };
}

// ---------- planted defects ----------

type Lang = "ts" | "js" | "py" | "go" | "rs" | "java";
const LANG: Record<string, Lang> = { ".ts": "ts", ".tsx": "ts", ".mts": "ts", ".cts": "ts", ".js": "js", ".jsx": "js", ".mjs": "js", ".cjs": "js", ".py": "py", ".go": "go", ".rs": "rs", ".java": "java" };

export type PlantKind = "injection" | "access";
export const PLANT_LABEL: Record<PlantKind, string> = { injection: "the SQL injection", access: "the inverted ownership check" };
const MARKER: Record<PlantKind, RegExp> = { injection: /find_?account_?by_?name/i, access: /can_?remove_?document/i };

/**
 * Two defects any competent reviewer reports, written to need no imports so they fit at the end of
 * a real file: a query built by joining a caller's string into SQL, and an ownership check with
 * the comparison the wrong way round (anyone who is NOT the owner may delete).
 */
const SNIPPET: Record<Lang, Record<PlantKind, string>> = {
  ts: {
    injection: `export async function findAccountByName(db: { query(sql: string): Promise<unknown[]> }, name: string) {\n  const rows = await db.query("SELECT id, email, role FROM accounts WHERE name = '" + name + "'");\n  return rows[0] ?? null;\n}`,
    access: `export function canRemoveDocument(user: { id: string; role: string }, doc: { ownerId: string }) {\n  if (user.role === "admin" || doc.ownerId !== user.id) return true;\n  return false;\n}`,
  },
  js: {
    injection: `async function findAccountByName(db, name) {\n  const rows = await db.query("SELECT id, email, role FROM accounts WHERE name = '" + name + "'");\n  return rows[0] || null;\n}`,
    access: `function canRemoveDocument(user, doc) {\n  if (user.role === "admin" || doc.ownerId !== user.id) return true;\n  return false;\n}`,
  },
  py: {
    injection: `def find_account_by_name(cursor, name):\n    cursor.execute("SELECT id, email, role FROM accounts WHERE name = '%s'" % name)\n    return cursor.fetchone()`,
    access: `def can_remove_document(user, doc):\n    if user.role == "admin" or doc.owner_id != user.id:\n        return True\n    return False`,
  },
  go: {
    injection: `func findAccountByName(run func(query string) ([]string, error), name string) ([]string, error) {\n\treturn run("SELECT id, email, role FROM accounts WHERE name = '" + name + "'")\n}`,
    access: `func canRemoveDocument(userID, role, ownerID string) bool {\n\tif role == "admin" || ownerID != userID {\n\t\treturn true\n\t}\n\treturn false\n}`,
  },
  rs: {
    injection: `pub fn find_account_by_name(run: &dyn Fn(&str) -> Vec<String>, name: &str) -> Vec<String> {\n    run(&format!("SELECT id, email, role FROM accounts WHERE name = '{}'", name))\n}`,
    access: `pub fn can_remove_document(user_id: &str, role: &str, owner_id: &str) -> bool {\n    if role == "admin" || owner_id != user_id {\n        return true;\n    }\n    false\n}`,
  },
  java: {
    injection: `class AccountLookup {\n    static java.sql.ResultSet findAccountByName(java.sql.Statement st, String name) throws java.sql.SQLException {\n        return st.executeQuery("SELECT id, email, role FROM accounts WHERE name = '" + name + "'");\n    }\n}`,
    access: `class DocumentRules {\n    static boolean canRemoveDocument(String userId, String role, String ownerId) {\n        if (role.equals("admin") || !ownerId.equals(userId)) return true;\n        return false;\n    }\n}`,
  },
};

export interface Planted {
  /** the excerpt, relative to the workspace */
  dir: string;
  files: string[];
  planted: Array<{ kind: PlantKind; file: string; from: number; to: number }>;
}

const WORK = ".hound-work";
const SKIP = new Set(["node_modules", ".git", "dist", "build", "target", "vendor", "__pycache__", ".venv", "venv"]);
const MAX_COPY = 80 * 1024;
const MAX_FILES = 8;

/** Source files BitBull has a defect for, under a folder (or the file itself), smallest effort first. */
export function plantable(sourceAbs: string, prefer: string[] = []): string[] {
  const ok = (abs: string) => {
    try {
      const st = lstatSync(abs);
      return st.isFile() && st.size > 200 && st.size <= MAX_COPY && !!LANG[path.extname(abs).toLowerCase()];
    } catch {
      return false;
    }
  };
  let base = sourceAbs;
  try {
    if (lstatSync(sourceAbs).isFile()) return ok(sourceAbs) ? [path.basename(sourceAbs)] : [];
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const p of prefer) if (out.length < MAX_FILES && !out.includes(p) && ok(path.join(base, p))) out.push(p);
  let visited = 0;
  const walk = (dir: string, depth: number) => {
    if (out.length >= MAX_FILES || depth > 4 || visited > 2000) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const e of entries) {
      visited++;
      if (out.length >= MAX_FILES) return;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name) && !e.name.startsWith(".")) walk(abs, depth + 1);
      } else if (e.isFile() && !/\.(test|spec)\.|_test\./i.test(e.name)) {
        const rel = posix(path.relative(base, abs));
        if (!out.includes(rel) && ok(abs)) out.push(rel);
      }
    }
  };
  walk(base, 0);
  return out;
}

/**
 * Copy a few of the target's source files into a scratch folder in the workspace and add the two
 * defects, each at the end of a real file. Returns null when there is nothing it can plant in.
 * The scratch folder is BitBull's own; removePlanted takes it away again.
 */
export function plant(ws: string, sourceAbs: string, id: string, prefer: string[] = []): Planted | null {
  const files = plantable(sourceAbs, prefer);
  if (!files.length) return null;
  const isFile = lstatSync(sourceAbs).isFile();
  const from = isFile ? path.dirname(sourceAbs) : sourceAbs;
  const name = (path.basename(isFile ? path.dirname(sourceAbs) : sourceAbs) || "code").replace(/[^A-Za-z0-9._-]/g, "_");
  const dir = `${WORK}/${id.replace(/[^A-Za-z0-9-]/g, "").slice(0, 12)}/${name}`;
  const root = path.join(ws, dir);
  mkdirSync(root, { recursive: true });
  for (const f of files) {
    mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    copyFileSync(path.join(from, f), path.join(root, f));
  }
  // one defect in each of two files when there are two; both in the one otherwise
  const kinds: PlantKind[] = ["injection", "access"];
  const planted: Planted["planted"] = [];
  kinds.forEach((kind, i) => {
    const file = files[Math.min(i, files.length - 1)];
    const abs = path.join(root, file);
    const lang = LANG[path.extname(file).toLowerCase()];
    const before = readFileSync(abs, "utf8").replace(/\s+$/, "");
    const snippet = SNIPPET[lang][kind];
    const start = before.split("\n").length + 2;
    writeFileSync(abs, `${before}\n\n${snippet}\n`);
    planted.push({ kind, file, from: start, to: start + snippet.split("\n").length - 1 });
  });
  return { dir, files, planted };
}

export function removePlanted(ws: string, id: string) {
  const dir = path.join(ws, WORK, id.replace(/[^A-Za-z0-9-]/g, "").slice(0, 12));
  try {
    rmSync(dir, { recursive: true, force: true });
    if (existsSync(path.join(ws, WORK)) && !readdirSync(path.join(ws, WORK)).length) rmSync(path.join(ws, WORK), { recursive: true, force: true });
  } catch {
    /* best effort: it is a scratch folder */
  }
}

/** Which planted defects a reviewer's findings name: the right file, and the right lines or function. */
export function plantedCaught(p: Planted, findings: Array<Pick<Finding, "path" | "line" | "title" | "detail"> & { quote?: string }>): { caught: PlantKind[]; missed: PlantKind[] } {
  const caught: PlantKind[] = [];
  for (const d of p.planted) {
    const hit = findings.some((f) => {
      const fp = f.path.replace(/\\/g, "/").replace(/:\d+(-\d+)?$/, "");
      if (!(fp === d.file || fp.endsWith(`/${d.file}`) || d.file.endsWith(`/${fp}`))) return false;
      const near = typeof f.line === "number" && f.line >= d.from - 2 && f.line <= d.to + 2;
      return near || MARKER[d.kind].test(`${f.title} ${f.detail ?? ""} ${f.quote ?? ""}`);
    });
    if (hit) caught.push(d.kind);
  }
  return { caught, missed: p.planted.map((d) => d.kind).filter((k) => !caught.includes(k)) };
}

export interface PlantedResult {
  model: string;
  caught: PlantKind[];
  missed: PlantKind[];
  /** the side test didn't finish, or gave nothing readable */
  error?: string;
}

export function plantedCheck(results: PlantedResult[] | undefined, why?: string): Check {
  if (!results?.length) return { id: "planted", ok: false, text: `Planted defects: the test couldn't be run${why ? ` (${why})` : ""}, so the reviewers weren't tested on this code.` };
  const parts = results.map((r) =>
    r.error
      ? `${r.model} didn't finish the test (${r.error})`
      : r.missed.length
        ? `${r.model} missed ${r.missed.map((k) => PLANT_LABEL[k]).join(" and ")}`
        : `${r.model} found both`,
  );
  const ok = results.every((r) => !r.error && !r.missed.length);
  return { id: "planted", ok, text: `Planted defects: two known defects were added to a scratch copy of some of this code and each reviewer was asked to review it. ${parts.join("; ")}.` };
}
