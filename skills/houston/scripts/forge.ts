// The forge: GitHub pull requests through `gh api`. REST only, because cloud
// sessions block GitHub GraphQL; the one exception is review-thread
// resolution, which REST does not expose: cloud sessions read it from the
// proxy's ccr route, local ones from GraphQL.
//
// A repository is its lowercased "owner/name" everywhere, as tickets name it,
// and a pull request or issue is a Ref to one.

import { setTimeout as sleep } from "node:timers/promises";
import {
  attributed,
  type CheckRun,
  type CommitStatus,
  type PrFacts,
  type Review,
  status,
  type Status,
} from "./pr.ts";
import { git, inCloud, run } from "./proc.ts";

const GH = process.env.HOUSTON_GH ?? "gh";

export class GhError extends Error {}

export function gh(args: string[], input?: string): string {
  const r = run(GH, args, input);
  if (r.code !== 0) throw new GhError(`gh ${args.slice(0, 2).join(" ")}: ${r.stderr.trim()}`);
  return r.stdout;
}

type ApiOpts = { method?: string; body?: unknown };

// The JSON that `gh api` answers, as the declared type T: the one place a
// response becomes typed, so the compiler checks every read after it. Nothing
// checks the JSON against T at run time. T declares only the fields the CLI
// reads, and marks optional each field the CLI already does without. A route
// that answers nothing reads as null, whatever T says.
export function api<T = unknown>(path: string, opts: ApiOpts = {}): T {
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

// Every item of a list route, 100 to a page, up to maxPages pages (10 unless
// told). A route whose page is an object around the list, Page, names the list
// with pick. A page that answers nothing ends the list.
export function paginate<T>(path: string, opts?: { maxPages?: number }): T[];
export function paginate<T, Page>(
  path: string,
  opts: { pick: (page: Page) => T[]; maxPages?: number },
): T[];
export function paginate<T, Page>(
  path: string,
  { pick, maxPages = 10 }: { pick?: (page: Page) => T[]; maxPages?: number } = {},
): T[] {
  const sep = path.includes("?") ? "&" : "?";
  const all: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const body = api<Page | null>(`${path}${sep}per_page=100&page=${page}`);
    // Without pick, the first overload made the page a list of T.
    const batch = body === null ? [] : pick ? pick(body) : (body as T[]);
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

export type Ref = { repo: string; number: number };

// What GitHub's REST routes answer, as far as the CLI reads it.

// A pull request as the list routes return it.
export type GhPull = {
  number: number;
  node_id: string;
  html_url: string;
  title: string;
  body: string | null;
  state: "open" | "closed";
  draft?: boolean;
  updated_at?: string;
  merged_at: string | null;
  head: { sha: string; ref: string };
  base: { ref: string };
};
// One pull request, which adds what GitHub computes for it alone. mergeable is
// null while GitHub still computes it.
type GhPullDetail = GhPull & {
  merged?: boolean;
  mergeable: boolean | null;
  mergeable_state?: string;
};
type GhRepo = {
  default_branch: string;
  allow_squash_merge?: boolean;
  allow_merge_commit?: boolean;
};
// A comment in the conversation of an issue or pull request, or, with a path,
// on a pull request's diff.
type GhComment = {
  id: number;
  body: string | null;
  created_at: string;
  user: { login: string } | null;
};
type GhReviewComment = GhComment & { path?: string };
type GhReview = Review & { body: string | null; submitted_at: string };

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
  const pulls = api<GhPull[] | null>(
    `repos/${repo}/pulls?head=${ownerOf(repo)}:${encodeURIComponent(branch)}&state=all&per_page=5`,
  );
  const pull = pulls?.[0];
  if (!pull) throw new GhError(`no pull request for branch ${branch}`);
  return { repo, number: pull.number };
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

// A JSON object's fields, or undefined for anything else.
function fields(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;
}

// The ccr route's payload shape is not documented, so accept the plausible
// field names and give up (null) rather than guess when none is present.
function countUnresolved(payload: unknown): number | null {
  const p = fields(payload);
  const list: unknown = Array.isArray(payload)
    ? payload
    : (p?.threads ?? p?.review_threads ?? fields(p?.reviewThreads)?.nodes ?? p?.nodes ?? null);
  if (!Array.isArray(list)) return null;
  let open = 0;
  for (const thread of list as unknown[]) {
    const t = fields(thread);
    const state = t?.state;
    const resolved =
      t?.is_resolved ??
      t?.isResolved ??
      t?.resolved ??
      (typeof state === "string" ? state.toLowerCase() === "resolved" : undefined);
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
// Each query's thread type follows it.
const THREAD_STATES_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved}}}}}`;
type ThreadState = { isResolved: boolean };
const THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved comments(first:100){nodes{databaseId}}}}}}}`;
type Thread = ThreadState & { id: string; comments: { nodes: { databaseId: number }[] } };
const RESOLVE_MUTATION = `mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}`;

// The review threads of a pull request, each as the query asks for it: T is
// that query's thread type.
function threadsViaGraphql<T>({ repo, number }: Ref, query: string): T[] {
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
  const answer = JSON.parse(out) as {
    data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: T[] } } } | null };
  } | null;
  const nodes = answer?.data?.repository?.pullRequest?.reviewThreads?.nodes;
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
      () => counted(threadsViaGraphql<ThreadState>(pr, THREAD_STATES_QUERY)),
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
      const thread = threadsViaGraphql<Thread>(pr, THREADS_QUERY).find((t) =>
        t.comments.nodes.some((c) => c.databaseId === commentId),
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
        `id=${api<GhPull>(`repos/${pr.repo}/pulls/${pr.number}`).node_id}`,
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
  const pull = api<GhPullDetail>(`${base}/pulls/${number}`);
  const sha = pull.head.sha;
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
    checkRuns: paginate<CheckRun, { check_runs: CheckRun[] }>(`${base}/commits/${sha}/check-runs`, {
      pick: (p) => p.check_runs,
      maxPages: 3,
    }),
    statuses:
      api<{ statuses?: CommitStatus[] } | null>(`${base}/commits/${sha}/status`)?.statuses ?? [],
    reviews: paginate<GhReview>(`${base}/pulls/${number}/reviews`),
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
  const base = api<GhRepo>(`repos/${repo}`).default_branch;
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
  const pull = api<GhPull>(`repos/${repo}/pulls`, {
    method: "POST",
    body: { title, head, base, body, draft: false },
  });
  return { repo, number: pull.number, url: pull.html_url };
}

// Merges at the head the caller checked, the way the repository allows:
// squash where it can, else a merge commit, else rebase. Returns the method.
export function merge(pr: Ref, sha: string): "squash" | "merge" | "rebase" {
  const allows = api<GhRepo | null>(`repos/${pr.repo}`);
  const method =
    allows?.allow_squash_merge !== false
      ? "squash"
      : allows?.allow_merge_commit !== false
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
  return paginate<GhComment>(`repos/${on.repo}/issues/${on.number}/comments`).map((c) => ({
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
    ...paginate<GhComment>(`${base}/issues/${number}/comments`).map((c) => ({
      at: c.created_at,
      body: c.body,
    })),
    ...paginate<GhReviewComment>(`${base}/pulls/${number}/comments`).map((c) => ({
      at: c.created_at,
      body: c.body,
    })),
    ...paginate<GhReview>(`${base}/pulls/${number}/reviews`)
      .filter((v) => v.body)
      .map((v) => ({ at: v.submitted_at, body: v.body })),
  ];
  return all.sort((x, y) => Date.parse(x.at) - Date.parse(y.at)).at(-1)?.body ?? null;
}

export type Merged = Ref & { url: string; title: string; mergedAt: string };

// Pull requests merged since a moment, read from the 300 most recently
// updated closed ones: enough for a week.
export function mergedSince(repo: string, since: string): Merged[] {
  return paginate<GhPull>(`repos/${repo}/pulls?state=closed&sort=updated&direction=desc`, {
    maxPages: 3,
  })
    .filter((p): p is GhPull & { merged_at: string } =>
      Boolean(p.merged_at && Date.parse(p.merged_at) >= Date.parse(since)),
    )
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
  return paginate<GhReviewComment>(`repos/${pr.repo}/pulls/${pr.number}/comments`).map((c) => ({
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
    for (const p of api<GhPull[] | null>(
      `repos/${repo}/pulls?head=${ownerOf(repo)}:${branch}&state=open`,
    ) ?? [])
      urls.add(p.html_url);
  } catch {
    // no such branch or no access: no open pull request we can see
  }
  for (const url of linked) {
    const pr = parsePrUrl(url);
    if (!pr || urls.has(url)) continue;
    try {
      if (api<GhPull>(`repos/${pr.repo}/pulls/${pr.number}`).state === "open") urls.add(url);
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
