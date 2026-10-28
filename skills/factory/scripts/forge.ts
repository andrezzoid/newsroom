// The forge: GitHub pull requests through `gh api`. REST only, because cloud
// sessions block GitHub GraphQL; the one exception is review-thread
// resolution, which REST does not expose: cloud sessions read it from the
// proxy's ccr route, local ones from GraphQL.

import { attributed, type PrFacts } from "./pr.ts";
import { git, run } from "./proc.ts";

const GH = process.env.FACTORY_GH ?? "gh";

export class GhError extends Error {}

export function gh(args: string[], input?: string): string {
  const r = run(GH, args, input);
  if (r.code !== 0) throw new GhError(`gh ${args.slice(0, 2).join(" ")}: ${r.stderr.trim()}`);
  return r.stdout;
}

type ApiOpts = { method?: string; accept?: string; body?: unknown };

export function api<T>(path: string, opts: ApiOpts = {}): T {
  const args = ["api", path];
  if (opts.method) args.push("--method", opts.method);
  if (opts.accept) args.push("-H", `Accept: ${opts.accept}`);
  let input: string | undefined;
  if (opts.body !== undefined) {
    args.push("--input", "-");
    input = JSON.stringify(opts.body);
  }
  const out = gh(args, input);
  if (opts.accept?.includes("diff")) return out as T;
  return (out.trim() ? JSON.parse(out) : null) as T;
}

export function paginate<T>(path: string, pick: (page: any) => T[] = (p) => p, maxPages = 10): T[] {
  const sep = path.includes("?") ? "&" : "?";
  const all: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const batch = pick(api<any>(`${path}${sep}per_page=100&page=${page}`)) ?? [];
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

export type Repo = { owner: string; repo: string };

export function parseRepo(spec: string): Repo | null {
  const m = /([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(spec.trim());
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

export function currentRepo(): Repo | null {
  const url = git(["remote", "get-url", "origin"]);
  return url ? parseRepo(url) : null;
}

export function currentBranch(): string | null {
  const b = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  return b && b !== "HEAD" ? b : null;
}

export function repoRoot(): string | null {
  return git(["rev-parse", "--show-toplevel"]);
}

// Accepts a number, a PR URL, or nothing (the PR for the current branch).
export function resolvePr(
  arg: string | undefined,
  repoFlag: string | undefined,
): Repo & { number: number } {
  const url = arg ? /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/.exec(arg) : null;
  if (url) return { owner: url[1]!, repo: url[2]!, number: Number(url[3]) };
  const repo = (repoFlag ? parseRepo(repoFlag) : null) ?? currentRepo();
  if (!repo)
    throw new GhError("cannot tell which repository: pass --repo owner/name or run inside a clone");
  if (arg && /^\d+$/.test(arg)) return { ...repo, number: Number(arg) };
  if (arg) throw new GhError(`not a PR number or URL: ${arg}`);
  const branch = currentBranch();
  if (!branch) throw new GhError("detached HEAD: pass a PR number");
  const pulls = api<any[]>(
    `repos/${repo.owner}/${repo.repo}/pulls?head=${repo.owner}:${encodeURIComponent(branch)}&state=all&per_page=5`,
  );
  if (!pulls?.length) throw new GhError(`no pull request for branch ${branch}`);
  return { ...repo, number: pulls[0].number };
}

// A failed lookup is not cached: the next call retries.
let viewerCache: string | undefined;
export function viewer(): string | null {
  if (viewerCache === undefined) {
    try {
      viewerCache = api<{ login: string }>("user").login;
    } catch {
      return null;
    }
  }
  return viewerCache;
}

// The ccr route's payload shape is not documented, so accept the plausible
// field names and give up (null) rather than guess when none is present.
export function countUnresolved(payload: unknown): number | null {
  const p = payload as any;
  const list: any[] | null = Array.isArray(p)
    ? p
    : (p?.threads ?? p?.review_threads ?? p?.reviewThreads?.nodes ?? p?.nodes ?? null);
  if (!Array.isArray(list)) return null;
  let open = 0;
  for (const t of list) {
    const resolved =
      t?.is_resolved ??
      t?.isResolved ??
      t?.resolved ??
      (typeof t?.state === "string" ? t.state.toLowerCase() === "resolved" : undefined);
    if (typeof resolved !== "boolean") return null;
    if (!resolved) open++;
  }
  return open;
}

const THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved}}}}}`;

export function unresolvedThreads(r: Repo, number: number): number | null {
  const viaCcr = () =>
    countUnresolved(api(`repos/${r.owner}/${r.repo}/pulls/${number}/ccr/review_threads`));
  const viaGraphql = () => {
    const out = gh([
      "api",
      "graphql",
      "-f",
      `query=${THREADS_QUERY}`,
      "-f",
      `owner=${r.owner}`,
      "-f",
      `name=${r.repo}`,
      "-F",
      `number=${number}`,
    ]);
    return countUnresolved(JSON.parse(out)?.data?.repository?.pullRequest?.reviewThreads?.nodes);
  };
  const order =
    process.env.CLAUDE_CODE_REMOTE === "true" ? [viaCcr, viaGraphql] : [viaGraphql, viaCcr];
  for (const attempt of order) {
    try {
      const n = attempt();
      if (n !== null) return n;
    } catch {
      // fall through to the other route
    }
  }
  return null;
}

// A write REST does not expose: the ccr route first in a cloud session, which
// blocks GraphQL, and GraphQL first locally, each the other's fallback.
function eitherRoute(what: string, viaCcr: () => void, viaGraphql: () => void): void {
  const order =
    process.env.CLAUDE_CODE_REMOTE === "true" ? [viaCcr, viaGraphql] : [viaGraphql, viaCcr];
  const failures: string[] = [];
  for (const attempt of order) {
    try {
      attempt();
      return;
    } catch (e) {
      failures.push((e as Error).message);
    }
  }
  throw new GhError(`could not ${what}: ${failures.join("; ")}`);
}

const THREAD_OF_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved comments(first:100){nodes{databaseId}}}}}}}`;
const RESOLVE_MUTATION = `mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}`;

// Resolves the review thread holding a comment.
export function resolveThread(r: Repo, number: number, commentId: number): void {
  eitherRoute(
    `resolve the thread of comment ${commentId}`,
    () =>
      api(`repos/${r.owner}/${r.repo}/pulls/${number}/ccr/comments/${commentId}/resolve`, {
        method: "POST",
      }),
    () => {
      const out = JSON.parse(
        gh([
          "api",
          "graphql",
          "-f",
          `query=${THREAD_OF_QUERY}`,
          "-f",
          `owner=${r.owner}`,
          "-f",
          `name=${r.repo}`,
          "-F",
          `number=${number}`,
        ]),
      );
      const threads: any[] = out?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
      const thread = threads.find((t) =>
        t?.comments?.nodes?.some((c: any) => c?.databaseId === commentId),
      );
      if (!thread) throw new GhError("no review thread holds it");
      if (!thread.isResolved)
        gh(["api", "graphql", "-f", `query=${RESOLVE_MUTATION}`, "-f", `id=${thread.id}`]);
    },
  );
}

const DRAFT_MUTATION = `mutation($id:ID!){convertPullRequestToDraft(input:{pullRequestId:$id}){pullRequest{isDraft}}}`;

// Turns a pull request back into a draft, the factory's sign that it waits on
// the user.
export function convertToDraft(r: Repo, number: number): void {
  eitherRoute(
    `turn #${number} into a draft`,
    () =>
      api(`repos/${r.owner}/${r.repo}/pulls/${number}/ccr/convert_to_draft`, { method: "POST" }),
    () =>
      gh([
        "api",
        "graphql",
        "-f",
        `query=${DRAFT_MUTATION}`,
        "-f",
        `id=${api<any>(`repos/${r.owner}/${r.repo}/pulls/${number}`).node_id}`,
      ]),
  );
}

// Posts a comment on a pull request or issue, with the Claude Code footer.
export function comment(r: Repo, number: number, body: string): void {
  api(`repos/${r.owner}/${r.repo}/issues/${number}/comments`, {
    method: "POST",
    body: { body: attributed(body) },
  });
}

// Replies in the review thread of a comment, with the Claude Code footer.
export function replyTo(r: Repo, number: number, commentId: number, body: string): void {
  api(`repos/${r.owner}/${r.repo}/pulls/${number}/comments/${commentId}/replies`, {
    method: "POST",
    body: { body: attributed(body) },
  });
}

export function prFacts(r: Repo, number: number): PrFacts {
  const base = `repos/${r.owner}/${r.repo}`;
  const pull = api<any>(`${base}/pulls/${number}`);
  const sha: string = pull.head.sha;
  return {
    number,
    url: pull.html_url,
    title: pull.title,
    body: pull.body ?? null,
    state: pull.state,
    merged: Boolean(pull.merged),
    draft: Boolean(pull.draft),
    mergeable: pull.mergeable,
    mergeableState: pull.mergeable_state ?? "unknown",
    headSha: sha,
    headRef: pull.head.ref,
    baseRef: pull.base.ref,
    updatedAt: pull.updated_at ?? new Date().toISOString(),
    checkRuns: paginate<any>(`${base}/commits/${sha}/check-runs`, (p) => p.check_runs, 3),
    statuses: api<any>(`${base}/commits/${sha}/status`)?.statuses ?? [],
    reviews: paginate<any>(`${base}/pulls/${number}/reviews`),
    unresolvedThreads: pull.state === "open" ? unresolvedThreads(r, number) : 0,
  };
}

// Opens a pull request from the current branch to the repository's default
// branch, ready for review. Pushes the branch to origin first, unless origin's
// push URL already holds its last commit. Asks the remote itself, since the
// clone's tracking ref outlives a branch the remote deleted after a merge.
export function openPr(r: Repo, title: string, body: string): { number: number; url: string } {
  const head = currentBranch();
  if (!head) throw new Error("detached HEAD: check out the branch the pull request comes from");
  const base = api<any>(`repos/${r.owner}/${r.repo}`).default_branch;
  if (head === base)
    throw new Error(`${head} is the default branch: open the pull request from a feature branch`);
  // The full ref name keeps a branch such as --force from reading as an option.
  const ref = `refs/heads/${head}`;
  const remote = git([
    "ls-remote",
    git(["remote", "get-url", "--push", "origin"]) ?? "origin",
    ref,
  ])?.split("\t")[0];
  if (remote !== git(["rev-parse", "HEAD"])) {
    const push = run("git", ["push", "-u", "origin", ref]);
    if (push.code !== 0) throw new Error(`git push: ${push.stderr.trim()}`);
  }
  const pull = api<any>(`repos/${r.owner}/${r.repo}/pulls`, {
    method: "POST",
    body: { title, head, base, body, draft: false },
  });
  return { number: pull.number, url: pull.html_url };
}

// Merge the way the repository allows: squash where it can, else a merge
// commit, else rebase.
export function mergeMethod(r: Repo): "squash" | "merge" | "rebase" {
  const repo = api<any>(`repos/${r.owner}/${r.repo}`);
  if (repo?.allow_squash_merge !== false) return "squash";
  return repo.allow_merge_commit !== false ? "merge" : "rebase";
}

export type Comment = { id: string; body: string; createdAt: string };

// The conversation on a pull request or issue, oldest first: where reports go.
export function comments(repo: string, number: number): Comment[] {
  return paginate<any>(`repos/${repo}/issues/${number}/comments`).map((c) => ({
    id: String(c.id),
    body: c.body ?? "",
    createdAt: c.created_at,
  }));
}

// The newest comment on a pull request: in its conversation, on its diff, or
// a review's own text.
export function lastWord(r: Repo, number: number): string | null {
  const base = `repos/${r.owner}/${r.repo}`;
  const all = [
    ...paginate<any>(`${base}/issues/${number}/comments`).map((c) => ({
      at: c.created_at,
      body: c.body,
    })),
    ...paginate<any>(`${base}/pulls/${number}/comments`).map((c) => ({
      at: c.created_at,
      body: c.body,
    })),
    ...paginate<any>(`${base}/pulls/${number}/reviews`)
      .filter((v) => v.body)
      .map((v) => ({ at: v.submitted_at, body: v.body })),
  ];
  return all.sort((x, y) => Date.parse(x.at) - Date.parse(y.at)).at(-1)?.body ?? null;
}

export type Merged = { repo: string; number: number; url: string; title: string; mergedAt: string };

// Pull requests merged since a moment, read from the 300 most recently
// updated closed ones: enough for a week.
export function mergedSince(repo: string, since: string): Merged[] {
  return paginate<any>(`repos/${repo}/pulls?state=closed&sort=updated&direction=desc`, (p) => p, 3)
    .filter((p) => p.merged_at && Date.parse(p.merged_at) >= Date.parse(since))
    .map((p) => ({
      repo,
      number: p.number,
      url: p.html_url,
      title: p.title,
      mergedAt: p.merged_at,
    }));
}

// The first line of each review comment on a pull request's diff.
export function reviewComments(
  repo: string,
  number: number,
): { author: string; path: string; text: string }[] {
  return paginate<any>(`repos/${repo}/pulls/${number}/comments`).map((c) => ({
    author: c.user?.login ?? "?",
    path: c.path ?? "",
    text: (
      String(c.body ?? "")
        .trim()
        .split("\n", 1)[0] ?? ""
    ).slice(0, 200),
  }));
}

// A ticket's open pull requests are those from its branch, plus the ones its
// tracker links while they stay open.
export function openPrs(repo: string, branch: string, linked: string[]): string[] {
  const urls = new Set<string>();
  try {
    for (const p of api<any[]>(
      `repos/${repo}/pulls?head=${repo.split("/")[0]}:${branch}&state=open`,
    ) ?? [])
      urls.add(p.html_url);
  } catch {
    // no such branch or no access: no open pull request we can see
  }
  for (const url of linked) {
    const m = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(url);
    if (!m || urls.has(url)) continue;
    try {
      if (api<any>(`repos/${m[1]}/pulls/${m[2]}`).state === "open") urls.add(url);
    } catch {
      // unreadable: not counted as open
    }
  }
  return [...urls];
}

export function readRepoFile(r: Repo, path: string): string | null {
  try {
    const f = api<{ content: string; encoding: string }>(
      `repos/${r.owner}/${r.repo}/contents/${path}`,
    );
    return f.encoding === "base64" ? Buffer.from(f.content, "base64").toString("utf8") : f.content;
  } catch {
    return null;
  }
}
