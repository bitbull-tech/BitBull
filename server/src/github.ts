/**
 * The few GitHub calls BitBull's own server makes for pull requests: find the open PR for a
 * branch, ask Ditto Review to review it (a "@ditto review" comment), and post QA Hound's verdict
 * as a review. All with GITHUB_TOKEN (Settings → Integrations → GitHub), as its owner.
 */
import { config } from "./config.js";

export interface GhRepo {
  owner: string;
  repo: string;
}

/** owner/repo from a GitHub remote (https or ssh, with or without .git / credentials). */
export function parseGithubRemote(remote: string | null | undefined): GhRepo | null {
  if (!remote) return null;
  const m = /github\.com[:/]+([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/.exec(remote.trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}

const NAME_OK = /^[A-Za-z0-9._\/-]{1,255}$/;

async function gh<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = config.integrations.github.token;
  if (!token) throw new Error("No GitHub token: add one under Settings → Integrations → GitHub");
  const res = await fetch(`https://api.github.com${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "BitBull",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { message?: string; errors?: Array<{ message?: string } | string> };
      msg = [j.message, ...(j.errors ?? []).map((e) => (typeof e === "string" ? e : e.message))].filter(Boolean).join(": ");
    } catch {
      /* not JSON */
    }
    const err = new Error(`GitHub ${res.status}: ${msg}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export interface OpenPr {
  number: number;
  url: string;
  title: string;
  author: string;
  headSha: string;
}

/** The open pull request whose head is this branch (in the same repository), or null. */
export async function openPrFor(r: GhRepo, branch: string): Promise<OpenPr | null> {
  if (!NAME_OK.test(branch)) throw new Error("That branch name can't be looked up");
  const list = await gh<Array<{ number: number; html_url: string; title: string; user?: { login?: string }; head: { sha: string } }>>(
    `/repos/${r.owner}/${r.repo}/pulls?state=open&per_page=5&head=${encodeURIComponent(`${r.owner}:${branch}`)}`,
  );
  const p = list[0];
  return p ? { number: p.number, url: p.html_url, title: p.title, author: p.user?.login ?? "", headSha: p.head.sha } : null;
}

/** The files a pull request changes (not the ones it removes), or null when there are too many to list. */
export async function prFiles(r: GhRepo, pr: number): Promise<string[] | null> {
  const out: string[] = [];
  for (let page = 1; page <= 4; page++) {
    const list = await gh<Array<{ filename?: unknown; status?: unknown }>>(`/repos/${r.owner}/${r.repo}/pulls/${pr}/files?per_page=100&page=${page}`);
    for (const f of list) if (typeof f.filename === "string" && f.status !== "removed") out.push(f.filename);
    if (list.length < 100) return out;
  }
  return null;
}

/** The automated checks on a commit: GitHub check runs (Actions and apps) and the older commit statuses. */
export async function headChecks(r: GhRepo, sha: string): Promise<{ runs: Array<{ name: string; status: string; conclusion: string | null }>; statuses: Array<{ context: string; state: string }> }> {
  if (!/^[0-9a-f]{7,64}$/.test(sha)) throw new Error("not a commit id");
  const str = (v: unknown) => (typeof v === "string" ? v.slice(0, 120) : "");
  const runs = await gh<{ check_runs?: Array<{ name?: unknown; status?: unknown; conclusion?: unknown }> }>(`/repos/${r.owner}/${r.repo}/commits/${sha}/check-runs?per_page=100`);
  const st = await gh<{ statuses?: Array<{ context?: unknown; state?: unknown }> }>(`/repos/${r.owner}/${r.repo}/commits/${sha}/status?per_page=100`);
  return {
    runs: (runs.check_runs ?? []).map((c) => ({ name: str(c.name), status: str(c.status), conclusion: typeof c.conclusion === "string" ? c.conclusion.slice(0, 40) : null })),
    statuses: (st.statuses ?? []).map((s) => ({ context: str(s.context), state: str(s.state) })),
  };
}

/** Where to open a PR for a branch that has none yet. */
export const compareUrl = (r: GhRepo, branch: string) => `https://github.com/${r.owner}/${r.repo}/compare/${encodeURIComponent(branch)}?expand=1`;

/** Ask Ditto Review for a review: its GitHub app answers "@ditto review" from anyone with write access. */
export async function requestDittoReview(r: GhRepo, pr: number): Promise<string> {
  const c = await gh<{ html_url: string }>(`/repos/${r.owner}/${r.repo}/issues/${pr}/comments`, {
    method: "POST",
    // exactly the command, nothing else, so Ditto's trigger matches it
    body: { body: "@ditto review" },
  });
  return c.html_url;
}

export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

/**
 * Post a review on a PR. GitHub refuses approving or requesting changes on your own pull
 * request; then the same text goes in as a plain review comment and that is said in it.
 */
export async function postReview(r: GhRepo, pr: number, event: ReviewEvent, body: string, commitId?: string): Promise<{ url: string; event: ReviewEvent; note?: string }> {
  const send = (ev: ReviewEvent, text: string) =>
    gh<{ html_url: string }>(`/repos/${r.owner}/${r.repo}/pulls/${pr}/reviews`, {
      method: "POST",
      body: { event: ev, body: text.slice(0, 60_000), ...(commitId ? { commit_id: commitId } : {}) },
    });
  try {
    const res = await send(event, body);
    return { url: res.html_url, event };
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (event !== "COMMENT" && status === 422) {
      const verdict = event === "APPROVE" ? "approve" : "request changes";
      const note = `GitHub doesn't let a token ${verdict} on its own pull request, so this is posted as a comment. Verdict: **${verdict}**.`;
      const res = await send("COMMENT", `> ${note}\n\n${body}`);
      return { url: res.html_url, event: "COMMENT", note };
    }
    throw e;
  }
}
