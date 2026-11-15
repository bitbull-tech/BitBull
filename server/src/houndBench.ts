/**
 * QA Hound's model benchmark: can this model, run the way a reviewer runs, find defects that are
 * known to be there, without inventing ones that aren't?
 *
 * Three small excerpts (TypeScript, Python, Go), each with four seeded defects of the kind a
 * review is for (not the two obvious ones of the planted-defect test) and one file with nothing
 * wrong in it. A model reviews each excerpt in a read-only turn; BitBull scores what it reports.
 * A model that finds enough of them, with few alarms in the clean files, may be one of the two
 * reviewers behind an approval (houndChecks.ts benchmarkCheck). Everyone else can still review:
 * their runs comment or request changes, they just don't approve.
 *
 * The cases are in this public file, so a score says "reads code carefully enough to find these",
 * not "finds every bug". It is a floor under an approval, with the other checks beside it.
 */
import { mkdirSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { paths, type EngineId } from "./config.js";
import { db, sessions } from "./db.js";
import { abortTurn, collectTurn, startTurn } from "./turns.js";
import { record } from "./activity.js";
import { estimateCost } from "./models.js";
import { FINDINGS_FENCE, houndOptions, parseFindings, type Finding } from "./hound.js";
import { excerptPrompt, type BenchGrade } from "./houndChecks.js";

/** Bump when the cases or the scoring change: older results then no longer count. */
export const BENCH_VERSION = 1;
/** Out of 12 seeded defects. */
export const BENCH_PASS = { caught: 10, falseAlarms: 2 };

interface Seeded {
  file: string;
  label: string;
  /** a piece of the defective line, unique in the file */
  anchor: string;
  /** what a finding about it talks about */
  about: RegExp;
}
export interface BenchCase {
  id: string;
  files: Record<string, string>;
  clean: string[];
  defects: Seeded[];
}

const lines = (...l: string[]) => l.join("\n") + "\n";

export const CASES: BenchCase[] = [
  {
    id: "web",
    clean: ["src/format.ts"],
    files: {
      "src/files.ts": lines(
        'import { createReadStream, existsSync, type ReadStream } from "node:fs";',
        'import path from "node:path";',
        "",
        'const UPLOADS = "/srv/app/uploads";',
        "",
        "/** Send back a file the signed-in user uploaded earlier. */",
        "export function openUpload(req: { query: { name: string } }): ReadStream | null {",
        "  const file = path.join(UPLOADS, req.query.name);",
        "  if (!existsSync(file)) return null;",
        "  return createReadStream(file);",
        "}",
      ),
      "src/session.ts": lines(
        'import { createHmac, timingSafeEqual } from "node:crypto";',
        "",
        'const SECRET = process.env.SESSION_SECRET ?? "";',
        "",
        'const mac = (userId: string) => createHmac("sha256", SECRET).update(userId).digest();',
        "",
        "export function sign(userId: string): string {",
        '  return `${userId}.${mac(userId).toString("hex")}`;',
        "}",
        "",
        "export function verify(token: string): string | null {",
        '  const at = token.lastIndexOf(".");',
        "  if (at < 1) return null;",
        "  const userId = token.slice(0, at);",
        '  const given = Buffer.from(token.slice(at + 1), "hex");',
        "  const expected = mac(userId);",
        "  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;",
        "  return userId;",
        "}",
        "",
        "/** The code emailed to a user who forgot their password. */",
        "export function newResetCode(): string {",
        "  return Math.random().toString(36).slice(2, 10);",
        "}",
      ),
      "src/admin.ts": lines(
        "interface User {",
        "  id: string;",
        "}",
        "interface Deps {",
        "  isAdmin(user: User): Promise<boolean>;",
        "  users: { remove(id: string): Promise<void> };",
        "}",
        "interface Res {",
        "  status(code: number): { end(): void };",
        "}",
        "",
        "export async function deleteUser(req: { user: User; params: { id: string } }, res: Res, deps: Deps) {",
        "  const allowed = deps.isAdmin(req.user);",
        "  if (!allowed) return res.status(403).end();",
        "  await deps.users.remove(req.params.id);",
        "  return res.status(204).end();",
        "}",
      ),
      "src/format.ts": lines(
        'const UNITS = ["B", "KB", "MB", "GB", "TB"];',
        "",
        "export function formatBytes(n: number): string {",
        '  if (!Number.isFinite(n) || n < 0) return "0 B";',
        "  let i = 0;",
        "  let v = n;",
        "  while (v >= 1024 && i < UNITS.length - 1) {",
        "    v /= 1024;",
        "    i++;",
        "  }",
        "  return `${i === 0 ? v : v.toFixed(1)} ${UNITS[i]}`;",
        "}",
        "",
        "export function clamp(n: number, lo: number, hi: number): number {",
        "  return Math.min(hi, Math.max(lo, n));",
        "}",
        "",
        "export function slugify(s: string): string {",
        "  return s",
        "    .toLowerCase()",
        '    .replace(/[^a-z0-9]+/g, "-")',
        '    .replace(/^-+|-+$/g, "")',
        "    .slice(0, 80);",
        "}",
      ),
    },
    defects: [
      { file: "src/files.ts", label: "path traversal in openUpload", anchor: "path.join(UPLOADS, req.query.name)", about: /travers|\.\.[\\/]|outside|escape|arbitrary (file|path)|contain|sanit|any file/i },
      { file: "src/session.ts", label: "empty default signing secret", anchor: 'process.env.SESSION_SECRET ?? ""', about: /empty|unset|not set|missing|default|fallback|forge/i },
      { file: "src/session.ts", label: "Math.random for a reset code", anchor: "Math.random().toString(36)", about: /random|predict|guess|csprng|entropy|crypto/i },
      { file: "src/admin.ts", label: "missing await on the admin check", anchor: "const allowed = deps.isAdmin(req.user);", about: /await|promise|always (true|truthy|pass)|never (false|denied|403)/i },
    ],
  },
  {
    id: "py",
    clean: ["jobs/text.py"],
    files: {
      "jobs/report.py": lines(
        "import subprocess",
        "",
        "",
        "def export_report(name: str, fmt: str) -> bytes:",
        '    """Render a saved report with the converter tool. Both values come from the request."""',
        '    cmd = f"report-convert --name {name} --format {fmt}"',
        "    return subprocess.run(cmd, shell=True, capture_output=True, check=True).stdout",
      ),
      "jobs/state.py": lines(
        "import base64",
        "import pickle",
        "",
        "",
        "def load_state(cookie: str):",
        '    """Restore the wizard state the browser sent back in its cookie."""',
        "    return pickle.loads(base64.b64decode(cookie))",
        "",
        "",
        "def save_state(state) -> str:",
        "    return base64.b64encode(pickle.dumps(state)).decode()",
      ),
      "jobs/rates.py": lines(
        "import requests",
        "",
        'RATES_URL = "https://rates.example.com/v1/latest"',
        "",
        "",
        "def fetch_rates() -> dict:",
        '    """Today\'s exchange rates, used to price invoices."""',
        "    r = requests.get(RATES_URL, timeout=5, verify=False)",
        "    r.raise_for_status()",
        "    return r.json()",
      ),
      "jobs/paging.py": lines(
        "def page_of(items: list, page: int, size: int) -> list:",
        '    """One page of results. Page numbers start at 1."""',
        "    if page < 1 or size < 1:",
        "        return []",
        "    start = page * size",
        "    return items[start:start + size]",
      ),
      "jobs/text.py": lines(
        "def truncate(s: str, limit: int) -> str:",
        '    """Cut to at most `limit` characters, with an ellipsis when something was cut."""',
        "    if limit < 1:",
        '        return ""',
        "    if len(s) <= limit:",
        "        return s",
        '    return s[: limit - 1] + "\\u2026"',
        "",
        "",
        "def initials(name: str) -> str:",
        '    return "".join(part[0].upper() for part in name.split() if part)',
        "",
        "",
        "def word_count(s: str) -> int:",
        "    return len(s.split())",
      ),
    },
    defects: [
      { file: "jobs/report.py", label: "command injection in export_report", anchor: "shell=True", about: /inject|shell|command|arbitrary/i },
      { file: "jobs/state.py", label: "pickle.loads on a cookie", anchor: "pickle.loads(base64.b64decode(cookie))", about: /pickle|deserial|arbitrary code|untrusted|rce|remote code/i },
      { file: "jobs/rates.py", label: "TLS verification switched off", anchor: "verify=False", about: /verif|tls|ssl|certificate|man.in.the.middle|mitm/i },
      { file: "jobs/paging.py", label: "off-by-one in page_of", anchor: "start = page * size", about: /off.by.one|first page|skips|page ?- ?1|zero.based|1.based|one.based|wrong (page|offset|slice)/i },
    ],
  },
  {
    id: "go",
    clean: ["internal/util/strings.go"],
    files: {
      "internal/store/counter.go": lines(
        "package store",
        "",
        'import "sync"',
        "",
        "// Counter counts hits per key. It is shared by every request handler.",
        "type Counter struct {",
        "\tmu   sync.Mutex",
        "\thits map[string]int",
        "}",
        "",
        "func NewCounter() *Counter {",
        "\treturn &Counter{hits: map[string]int{}}",
        "}",
        "",
        "func (c *Counter) Hit(key string) int {",
        "\tc.hits[key]++",
        "\treturn c.hits[key]",
        "}",
        "",
        "func (c *Counter) Reset() {",
        "\tc.mu.Lock()",
        "\tdefer c.mu.Unlock()",
        "\tc.hits = map[string]int{}",
        "}",
      ),
      "internal/api/login.go": lines(
        "package api",
        "",
        'import "net/http"',
        "",
        "// AfterLogin sends the browser back to where it was going before it had to sign in.",
        "func AfterLogin(w http.ResponseWriter, r *http.Request) {",
        '\tnext := r.URL.Query().Get("next")',
        '\tif next == "" {',
        '\t\tnext = "/"',
        "\t}",
        "\thttp.Redirect(w, r, next, http.StatusFound)",
        "}",
      ),
      "internal/api/token.go": lines(
        "package api",
        "",
        "import (",
        '\t"encoding/base64"',
        '\t"encoding/json"',
        '\t"errors"',
        '\t"strings"',
        ")",
        "",
        "// UserFromToken returns the user a bearer token (header.payload.signature) belongs to.",
        "func UserFromToken(token string) (string, error) {",
        '\tparts := strings.Split(token, ".")',
        "\tif len(parts) != 3 {",
        '\t\treturn "", errors.New("malformed token")',
        "\t}",
        "\tpayload, err := base64.RawURLEncoding.DecodeString(parts[1])",
        "\tif err != nil {",
        '\t\treturn "", err',
        "\t}",
        "\tvar claims struct {",
        '\t\tSub string `json:"sub"`',
        "\t}",
        "\tif err := json.Unmarshal(payload, &claims); err != nil {",
        '\t\treturn "", err',
        "\t}",
        "\treturn claims.Sub, nil",
        "}",
      ),
      "internal/api/owner.go": lines(
        "package api",
        "",
        "type OwnerStore interface {",
        "\tOwnerOf(docID string) (string, error)",
        "}",
        "",
        "// MayEdit reports whether the user may change the document.",
        "func MayEdit(db OwnerStore, userID, docID string) bool {",
        "\towner, err := db.OwnerOf(docID)",
        "\tif err != nil {",
        "\t\treturn true",
        "\t}",
        "\treturn owner == userID",
        "}",
      ),
      "internal/util/strings.go": lines(
        "package util",
        "",
        'import "strings"',
        "",
        "// NonEmpty returns the strings in list that aren't blank.",
        "func NonEmpty(list []string) []string {",
        "\tout := make([]string, 0, len(list))",
        "\tfor _, v := range list {",
        '\t\tif strings.TrimSpace(v) != "" {',
        "\t\t\tout = append(out, v)",
        "\t\t}",
        "\t}",
        "\treturn out",
        "}",
        "",
        "// Contains reports whether list holds s.",
        "func Contains(list []string, s string) bool {",
        "\tfor _, v := range list {",
        "\t\tif v == s {",
        "\t\t\treturn true",
        "\t\t}",
        "\t}",
        "\treturn false",
        "}",
      ),
    },
    defects: [
      { file: "internal/store/counter.go", label: "map written without the lock in Hit", anchor: "c.hits[key]++", about: /race|lock|mutex|concurren|synchron|thread/i },
      { file: "internal/api/login.go", label: "open redirect in AfterLogin", anchor: "http.Redirect(w, r, next, http.StatusFound)", about: /redirect|phish|external|arbitrary (url|site)/i },
      { file: "internal/api/token.go", label: "token signature never checked", anchor: "return claims.Sub, nil", about: /signature|verif|forg|unsigned|not (checked|validated)|never (checked|validated)|parts\[2\]/i },
      { file: "internal/api/owner.go", label: "MayEdit allows access when the lookup fails", anchor: "\t\treturn true", about: /fail.?open|error|returns? true|lookup/i },
    ],
  },
];

export const BENCH_TOTAL = CASES.reduce((n, c) => n + c.defects.length, 0);

const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const samePath = (given: string, file: string) => {
  const g = given.replace(/\\/g, "/").replace(/:\d+(-\d+)?$/, "");
  return g === file || g.endsWith(`/${file}`);
};

/** Score one case from what a model reported: which seeded defects it found, and alarms in the clean files. */
export function scoreCase(c: BenchCase, findings: Finding[]): { caught: string[]; missed: string[]; falseAlarms: number } {
  const caught: string[] = [];
  for (const d of c.defects) {
    const at = c.files[d.file].split("\n").findIndex((l) => l.includes(d.anchor)) + 1;
    const hit = findings.some((f) => {
      if (!samePath(f.path, d.file)) return false;
      const near = typeof f.line === "number" && Math.abs(f.line - at) <= 3;
      const quoted = !!f.quote && squash(f.quote).includes(squash(d.anchor));
      const said = d.about.test(`${f.title} ${f.detail ?? ""}`);
      // one defect in the file: the right place or the right subject; two: both have to fit
      const others = c.defects.filter((x) => x.file === d.file).length > 1;
      return others ? said && (near || quoted || !f.line) : near || quoted || said;
    });
    if (hit) caught.push(d.label);
  }
  const falseAlarms = findings.filter((f) => c.clean.some((file) => samePath(f.path, file)) && f.confidence >= 70 && ["medium", "high", "critical"].includes(f.severity)).length;
  return { caught, missed: c.defects.map((d) => d.label).filter((l) => !caught.includes(l)), falseAlarms };
}

export interface BenchResult extends BenchGrade {
  version: number;
  ranAt: number;
  missed: string[];
  costUsd: number;
  error?: string;
}

const KEY = "hound_bench";
function load(): Record<string, BenchResult> {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(KEY) as { value?: string } | undefined;
    const j = row?.value ? (JSON.parse(row.value) as Record<string, BenchResult>) : {};
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}
function save(all: Record<string, BenchResult>) {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(KEY, JSON.stringify(all));
}

/** A model's result at the current version of the benchmark, if it has one. */
export function gradeOf(model: string): BenchResult | undefined {
  const r = load()[model];
  return r && r.version === BENCH_VERSION && !r.error ? r : undefined;
}

const running = new Map<string, { startedAt: number; step: string }>();
const CASE_MS = 8 * 60 * 1000;

export function benchState() {
  return {
    version: BENCH_VERSION,
    total: BENCH_TOTAL,
    pass: BENCH_PASS,
    results: Object.values(load()).filter((r) => r.version === BENCH_VERSION),
    running: [...running.entries()].map(([model, r]) => ({ model, ...r })),
  };
}

/**
 * Benchmark one model: three read-only review turns, in the general workspace, on excerpts
 * written to a scratch folder that is removed afterwards. Returns at once; benchState() says how
 * it is going. Costs what three short reviews cost.
 */
export function startBench(model: string): { ok: boolean; message: string } {
  const m = model.trim();
  if (!m || m.length > 200) return { ok: false, message: "Choose a model." };
  if (running.has(m)) return { ok: false, message: `${m} is already being benchmarked.` };
  if (running.size >= 2) return { ok: false, message: "Two benchmarks are already running. Wait for one to finish." };
  running.set(m, { startedAt: Date.now(), step: "starting" });
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const root = path.join(paths.workspace, ".hound-bench", id);
  void (async () => {
    const out: BenchResult = { model: m, version: BENCH_VERSION, ranAt: Date.now(), caught: 0, total: BENCH_TOTAL, falseAlarms: 0, missed: [], costUsd: 0, grade: false };
    try {
      for (const c of CASES) {
        running.get(m)!.step = `${CASES.indexOf(c) + 1} of ${CASES.length}`;
        const dir = path.join(root, c.id);
        for (const [f, text] of Object.entries(c.files)) {
          mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
          writeFileSync(path.join(dir, f), text);
        }
        const rel = path.relative(paths.workspace, dir).split(path.sep).join("/");
        const session = sessions.create({ title: `QA Hound · benchmark ${c.id} · ${m}`, engine: "opencode" as EngineId, model: m, projectId: null });
        const { turnId } = startTurn(session, { prompt: excerptPrompt(rel, Object.keys(c.files), FINDINGS_FENCE), model: m, plan: true });
        const timer = setTimeout(() => abortTurn(session.id), CASE_MS);
        const { events, status } = await collectTurn(turnId);
        clearTimeout(timer);
        let text = "";
        for (const { event: ev } of events) {
          if (ev.type === "text") text += ev.delta;
          if (ev.type === "done" && ev.usage) {
            const u = ev.usage;
            out.costUsd += u.costUsd || (await estimateCost(m, u.inputTokens, u.outputTokens, u.cacheReadTokens)) || 0;
          }
        }
        const findings = parseFindings(text, houndOptions({ minConfidence: 0 })).findings;
        if (!findings) {
          const errors = events.filter((e) => e.event.type === "error").map((e) => (e.event as { message: string }).message);
          throw new Error(status === "done" ? `no readable findings for the ${c.id} case` : (errors.at(-1) ?? `the ${c.id} case ${status}`));
        }
        const s = scoreCase(c, findings);
        out.caught += s.caught.length;
        out.missed.push(...s.missed);
        out.falseAlarms += s.falseAlarms;
      }
      out.grade = out.caught >= BENCH_PASS.caught && out.falseAlarms <= BENCH_PASS.falseAlarms;
    } catch (e) {
      out.error = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    } finally {
      try {
        rmSync(root, { recursive: true, force: true });
        rmdirSync(path.join(paths.workspace, ".hound-bench"));
      } catch {
        /* not empty (another benchmark is running) or already gone */
      }
      const all = load();
      all[m] = out;
      save(all);
      running.delete(m);
      record({
        level: out.error ? "warn" : "info",
        source: "swarm",
        message: out.error ? `QA Hound benchmark of ${m} failed: ${out.error}` : `QA Hound benchmark of ${m}: ${out.caught} of ${out.total} seeded defects, ${out.falseAlarms} false alarms, ${out.grade ? "passed" : "not passed"} ($${out.costUsd.toFixed(3)})`,
      });
    }
  })();
  return { ok: true, message: `Benchmarking ${m}: three short reviews.` };
}
