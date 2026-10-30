// The forge: GitHub pull requests through `gh api`. REST only, because cloud
// sessions block GitHub GraphQL; the one exception is review-thread
// resolution, which REST does not expose: cloud sessions read it from the
// proxy's ccr route, local ones from GraphQL.
//
// A repository is its lowercased "owner/name" everywhere, as tickets name it,
// and a pull request or issue is a Ref to one.

import { setTimeout as sleep } from "node:timers/promises";
import { attributed, type PrFacts, status, type Status } from "./pr.ts";
import { git, inCloud, run } from "./proc.ts";

const GH = process.env.HOUSTON_GH ?? "gh";

export class GhError extends Error {}

export function gh(args: string[], input?: string): string {
  const r = run(GH, args, input);
  if (r.code !== 0) throw new GhError(`gh ${args.slice(0, 2).join(" ")}: ${r.stderr.trim()}`);
  return r.stdout;
}

type ApiOpts = { method?: string; body?: unknown };

export function api<T>(path: string, opts: ApiOpts = {}): T {
  const args = ["api", path];
  if (opts.method) args.push("--method", opts.method);
  let input: string | undefined;
  if (opts.body !== undefined) {
    args.push("--input", "-");
    input = JSON.stringify(opts.body);
  }
  const out = gh(args, input);
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

export type Ref = { repo: string; number: number };

// owner/name from an owner/name spec, a remote, or any GitHub URL under the
// repository, as a pull request's.
export function parseRepo(spec: string): string | null {
  const [, repo] =
    /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?(?:[/?#]|$)/.exec(spec) ??
    /([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(spec.trim()) ??
    [];
  return repo ? repo.toLowerCase() : null;
}

const ownerOf = (repo: string) => repo.split("/")[0] ?? "";

export function parsePrUrl(url: string): Ref | null {
  const [, repo, number] = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(url) ?? [];
  return repo ? { repo: repo.toLowerCase(), number: Number(number) } : null;
}

export function currentRepo(): string | null {
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

// Accepts a number, a PR URL, or nothing (the PR for the current branch). A
// number or nothing needs the repository it is in.
export function resolvePr(arg: string | undefined, repo: string | null): Ref {
  const url = arg ? parsePrUrl(arg) : null;
  if (url) return url;
  if (!repo)
    throw new GhError("cannot tell which repository: pass --repo owner/name or run inside a clone");
  if (arg && /^\d+$/.test(arg)) return { repo, number: Number(arg) };
  if (arg) throw new GhError(`not a PR number or URL: ${arg}`);
  const branch = currentBranch();
  if (!branch) throw new GhError("detached HEAD: pass a PR number");
  const pulls = api<any[]>(
    `repos/${repo}/pulls?head=${ownerOf(repo)}:${encodeURIComponent(branch)}&state=all&per_page=5`,
  );
  if (!pulls?.length) throw new GhError(`no pull request for branch ${branch}`);
  return { repo, number: pulls[0].number };
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
function countUnresolved(payload: unknown): number | null {
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

// What REST does not expose: the ccr route first in a cloud session, which
// blocks GraphQL, and GraphQL first locally, each the other's fallback.
function eitherRoute<T>(what: string, viaCcr: () => T, viaGraphql: () => T): T {
  const failures: string[] = [];
  for (const attempt of inCloud() ? [viaCcr, viaGraphql] : [viaGraphql, viaCcr]) {
    try {
      return attempt();
    } catch (e) {
      failures.push((e as Error).message);
    }
  }
  throw new GhError(`could not ${what}: ${failures.join("; ")}`);
}

// Counting needs only each thread's state; resolving needs its comments too.
const THREAD_STATES_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved}}}}}`;
const THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved comments(first:100){nodes{databaseId}}}}}}}`;
const RESOLVE_MUTATION = `mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}`;

function threadsViaGraphql({ repo, number }: Ref, query: string): any[] {
  const [owner = "", name = ""] = repo.split("/");
  const out = gh([
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
    "-F",
    `number=${number}`,
  ]);
  const nodes = JSON.parse(out)?.data?.repository?.pullRequest?.reviewThreads?.nodes;
  // An answer without threads must not read as a pull request with none open.
  if (!Array.isArray(nodes)) throw new GhError("GraphQL returned no review threads");
  return nodes;
}

// null when neither route answers in a shape countUnresolved can read.
function unresolvedThreads(pr: Ref): number | null {
  const counted = (payload: unknown) => {
    const n = countUnresolved(payload);
    if (n === null) throw new GhError("no thread states in the answer");
    return n;
  };
  try {
    return eitherRoute(
      "count the open review threads",
      () => counted(api(`repos/${pr.repo}/pulls/${pr.number}/ccr/review_threads`)),
      () => counted(threadsViaGraphql(pr, THREAD_STATES_QUERY)),
    );
  } catch {
    return null;
  }
}

// Resolves the review thread holding a comment.
export function resolveThread(pr: Ref, commentId: number): void {
  eitherRoute(
    `resolve the thread of comment ${commentId}`,
    () =>
      api(`repos/${pr.repo}/pulls/${pr.number}/ccr/comments/${commentId}/resolve`, {
        method: "POST",
      }),
    () => {
      const thread = threadsViaGraphql(pr, THREADS_QUERY).find((t) =>
        t?.comments?.nodes?.some((c: any) => c?.databaseId === commentId),
      );
      if (!thread) throw new GhError("no review thread holds it");
      if (!thread.isResolved)
        gh(["api", "graphql", "-f", `query=${RESOLVE_MUTATION}`, "-f", `id=${thread.id}`]);
    },
  );
}

const DRAFT_MUTATION = `mutation($id:ID!){convertPullRequestToDraft(input:{pullRequestId:$id}){pullRequest{isDraft}}}`;

// Turns a pull request back into a draft, Houston's sign that it waits on
// the user.
export function convertToDraft(pr: Ref): void {
  eitherRoute(
    `turn #${pr.number} into a draft`,
    () => api(`repos/${pr.repo}/pulls/${pr.number}/ccr/convert_to_draft`, { method: "POST" }),
    () =>
      gh([
        "api",
        "graphql",
        "-f",
        `query=${DRAFT_MUTATION}`,
        "-f",
        `id=${api<any>(`repos/${pr.repo}/pulls/${pr.number}`).node_id}`,
      ]),
  );
}

// Posts a comment on a pull request or issue, with the Claude Code footer.
export function comment(on: Ref, body: string): void {
  api(`repos/${on.repo}/issues/${on.number}/comments`, {
    method: "POST",
    body: { body: attributed(body) },
  });
}

// Replies in the review thread of a comment, with the Claude Code footer.
export function replyTo(pr: Ref, commentId: number, body: string): void {
  api(`repos/${pr.repo}/pulls/${pr.number}/comments/${commentId}/replies`, {
    method: "POST",
    body: { body: attributed(body) },
  });
}

function prFacts(pr: Ref): PrFacts {
  const { number } = pr;
  const base = `repos/${pr.repo}`;
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
    unresolvedThreads: pull.state === "open" ? unresolvedThreads(pr) : 0,
  };
}

// GitHub computes mergeability after each push: ask once more, 3 seconds
// later, before reporting it unknown.
export async function pullStatus(pr: Ref): Promise<Status> {
  let facts = prFacts(pr);
  if (facts.state === "open" && facts.mergeable === null) {
    await sleep(3000);
    facts = prFacts(pr);
  }
  return status(facts);
}

// Opens a pull request from the current branch to the repository's default
// branch, ready for review. Pushes the branch to origin first, unless origin's
// push URL already holds its last commit. Asks the remote itself, since the
// clone's tracking ref outlives a branch the remote deleted after a merge.
export function openPr(repo: string, title: string, body: string): Ref & { url: string } {
  const head = currentBranch();
  if (!head) throw new Error("detached HEAD: check out the branch the pull request comes from");
  const base = api<any>(`repos/${repo}`).default_branch;
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
  const pull = api<any>(`repos/${repo}/pulls`, {
    method: "POST",
    body: { title, head, base, body, draft: false },
  });
  return { repo, number: pull.number, url: pull.html_url };
}

// Merges at the head the caller checked, the way the repository allows:
// squash where it can, else a merge commit, else rebase. Returns the method.
export function merge(pr: Ref, sha: string): "squash" | "merge" | "rebase" {
  const allows = api<any>(`repos/${pr.repo}`);
  const method =
    allows?.allow_squash_merge !== false
      ? "squash"
      : allows.allow_merge_commit !== false
        ? "merge"
        : "rebase";
  api(`repos/${pr.repo}/pulls/${pr.number}/merge`, {
    method: "PUT",
    body: { merge_method: method, sha },
  });
  return method;
}

export type Comment = { id: string; body: string; createdAt: string };

// The conversation on a pull request or issue, oldest first: where reports go.
export function comments(on: Ref): Comment[] {
  return paginate<any>(`repos/${on.repo}/issues/${on.number}/comments`).map((c) => ({
    id: String(c.id),
    body: c.body ?? "",
    createdAt: c.created_at,
  }));
}

// The newest comment on a pull request: in its conversation, on its diff, or
// a review's own text.
export function lastWord(pr: Ref): string | null {
  const { number } = pr;
  const base = `repos/${pr.repo}`;
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

export type Merged = Ref & { url: string; title: string; mergedAt: string };

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
export function reviewComments(pr: Ref): { author: string; path: string; text: string }[] {
  return paginate<any>(`repos/${pr.repo}/pulls/${pr.number}/comments`).map((c) => ({
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
    for (const p of api<any[]>(`repos/${repo}/pulls?head=${ownerOf(repo)}:${branch}&state=open`) ??
      [])
      urls.add(p.html_url);
  } catch {
    // no such branch or no access: no open pull request we can see
  }
  for (const url of linked) {
    const pr = parsePrUrl(url);
    if (!pr || urls.has(url)) continue;
    try {
      if (api<any>(`repos/${pr.repo}/pulls/${pr.number}`).state === "open") urls.add(url);
    } catch {
      // unreadable: not counted as open
    }
  }
  return [...urls];
}

export function readRepoFile(repo: string, path: string): string | null {
  try {
    const f = api<{ content: string; encoding: string }>(`repos/${repo}/contents/${path}`);
    return f.encoding === "base64" ? Buffer.from(f.content, "base64").toString("utf8") : f.content;
  } catch {
    return null;
  }
}
