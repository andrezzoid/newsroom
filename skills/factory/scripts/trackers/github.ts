// GitHub Issues adapter, through `gh api` REST on repository-scoped routes so
// it works in cloud sessions, which block GraphQL and cross-repo search.
// GitHub has no workflow states: an open issue labelled in-progress is
// started, any other open issue is queued.

import { api, comments, paginate, viewer as forgeViewer } from "../forge.ts";
import { CLAIMED_LABEL, HUMAN_LABEL, READY_LABEL, slug, ticketsOfPr } from "../tickets.ts";
import {
  NotFound,
  type Ticket,
  type TicketComment,
  type TicketRef,
  type Tracker,
} from "./types.ts";

export class GithubError extends Error {}

export function parseId(id: string): { repo: string; number: number } {
  const [, repo, number] = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(id) ?? [];
  if (!repo) throw new GithubError(`not a GitHub issue id (owner/repo#123): ${id}`);
  return { repo: repo.toLowerCase(), number: Number(number) };
}

const BLOCKED_BY_LINE = /^[ \t>*_-]*blocked[ -]by\b[*_]*\s*:?(.*)$/i;
const ISSUE_REF =
  /(?:https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/|(?<![\w/])(?:([\w.-]+\/[\w.-]+))?#)(\d+)\b/g;

function repoOfUrl(url: string | undefined, fallback: string): string {
  const m = /repos\/([\w.-]+\/[\w.-]+)$/.exec(url ?? "");
  return (m?.[1] ?? fallback).toLowerCase();
}

export function toTicket(
  issue: any,
  repo: string,
  blockers: TicketRef[] = [],
  me: string | null = null,
): Ticket {
  const labels: string[] = (issue.labels ?? []).map((l: any) =>
    String(typeof l === "string" ? l : l.name).toLowerCase(),
  );
  const closed = issue.state === "closed";
  const started = !closed && labels.includes(CLAIMED_LABEL);
  const subs = issue.sub_issues_summary;
  return {
    id: `${repo}#${issue.number}`,
    tracker: "github",
    title: issue.title,
    body: issue.body ?? "",
    url: issue.html_url,
    state: closed
      ? issue.state_reason === "not_planned"
        ? "canceled"
        : "done"
      : started
        ? "started"
        : "queued",
    stateName: closed ? "closed" : started ? CLAIMED_LABEL : "open",
    labels,
    repo,
    branchName: `issue-${issue.number}-${slug(issue.title)}`,
    priority: 0,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at ?? issue.created_at,
    completedAt: closed ? (issue.closed_at ?? null) : null,
    blockers,
    openChildren: subs ? Math.max(0, (subs.total ?? 0) - (subs.completed ?? 0)) : 0,
    prs: [],
    closes: `Closes #${issue.number}`,
    assignees: (issue.assignees ?? []).map((a: any) => ({ name: a.login, me: a.login === me })),
  };
}

// Native issue dependencies first; the body covers repositories that do not
// use them, as a "Blocked by: #12, o/r#13" line or a "## Blocked by" section
// (the to-tickets template), with issue URLs too. Returns full ids.
export function blockedByRefs(body: string, repo: string): string[] {
  const out = new Set<string>();
  let section = false;
  for (const line of body.split("\n")) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line.trim());
    if (heading) {
      section = /^blocked[ -]by\b/i.test(heading[1] ?? "");
      continue;
    }
    const text = section ? line : BLOCKED_BY_LINE.exec(line)?.[1];
    for (const m of text?.matchAll(ISSUE_REF) ?? [])
      out.add(`${(m[1] ?? m[2] ?? repo).toLowerCase()}#${m[3]}`);
  }
  return [...out];
}

// The pull requests, of those given, that close the issue: a closing line in
// the body, or an issue-<n>- branch.
function closing(prs: any[], id: string): string[] {
  const { repo } = parseId(id);
  return prs
    .filter((p) => ticketsOfPr({ body: p.body, headRef: p.head?.ref ?? "" }, repo).includes(id))
    .map((p) => p.html_url);
}

export class GithubTracker implements Tracker {
  readonly name = "github" as const;
  readonly repos: string[];

  constructor(repos: string[]) {
    this.repos = [...new Set(repos.map((r) => r.toLowerCase()))];
  }

  private blockers(repo: string, issue: any): TicketRef[] {
    const refs = new Map<string, TicketRef>();
    try {
      for (const b of api<any[]>(`repos/${repo}/issues/${issue.number}/dependencies/blocked_by`) ??
        []) {
        const r = repoOfUrl(b.repository_url, repo);
        refs.set(`${r}#${b.number}`, {
          id: `${r}#${b.number}`,
          title: b.title,
          done: b.state === "closed",
        });
      }
    } catch {
      // repositories without issue dependencies fall back to the body
    }
    for (const id of blockedByRefs(issue.body ?? "", repo)) {
      if (refs.has(id)) continue;
      try {
        const ref = parseId(id);
        const b = api<any>(`repos/${ref.repo}/issues/${ref.number}`);
        refs.set(id, { id, title: b.title, done: b.state === "closed" });
      } catch {
        refs.set(id, { id, title: "(unreadable)", done: false });
      }
    }
    return [...refs.values()];
  }

  // The issue payload carries a sub-issue summary on most hosts; ask the
  // sub-issues route when it does not, since a parent must never read as a slice.
  private full(repo: string, issue: any): Ticket {
    const t = toTicket(issue, repo, this.blockers(repo, issue), forgeViewer());
    if (!issue.sub_issues_summary) {
      try {
        t.openChildren = (
          api<any[]>(`repos/${repo}/issues/${issue.number}/sub_issues`) ?? []
        ).filter((s) => s.state === "open").length;
      } catch {
        // no sub-issues on this host
      }
    }
    return t;
  }

  private issues(repo: string, query: string): any[] {
    return paginate<any>(`repos/${repo}/issues?${query}`).filter((i) => !i.pull_request);
  }

  async open(): Promise<Ticket[]> {
    const me = forgeViewer();
    const out: Ticket[] = [];
    for (const repo of this.repos) {
      const prs = paginate<any>(`repos/${repo}/pulls?state=open`);
      for (const i of this.issues(repo, "state=open")) {
        let t = toTicket(i, repo, [], me);
        if (t.state === "queued" && t.labels.includes(READY_LABEL)) t = this.full(repo, i);
        t.prs = closing(prs, t.id);
        out.push(t);
      }
    }
    return out;
  }

  async get(id: string): Promise<{ ticket: Ticket; comments: TicketComment[] }> {
    const { repo, number } = parseId(id);
    let issue: any;
    try {
      issue = api<any>(`repos/${repo}/issues/${number}`);
    } catch (e) {
      throw /HTTP 404\b/.test((e as Error).message) ? new NotFound(`no GitHub issue ${id}`) : e;
    }
    if (issue.pull_request) throw new NotFound(`${id} is a pull request, not an issue`);
    const ticket = this.full(repo, issue);
    ticket.prs = closing(paginate<any>(`repos/${repo}/pulls?state=open`), ticket.id);
    return { ticket, comments: comments(repo, number) };
  }

  async comments(id: string): Promise<TicketComment[]> {
    const { repo, number } = parseId(id);
    return comments(repo, number);
  }

  async start(t: Ticket): Promise<void> {
    const { repo, number } = parseId(t.id);
    if (t.assignees.length === 0)
      api(`repos/${repo}/issues/${number}/assignees`, {
        method: "POST",
        body: { assignees: [await this.viewer()] },
      });
    if (!t.labels.includes(CLAIMED_LABEL))
      api(`repos/${repo}/issues/${number}/labels`, {
        method: "POST",
        body: { labels: [CLAIMED_LABEL] },
      });
  }

  async comment(id: string, body: string): Promise<void> {
    const { repo, number } = parseId(id);
    api(`repos/${repo}/issues/${number}/comments`, { method: "POST", body: { body } });
  }

  async create(from: Ticket, title: string, body: string): Promise<string> {
    const { repo } = parseId(from.id);
    return `${repo}#${api<any>(`repos/${repo}/issues`, { method: "POST", body: { title, body } }).number}`;
  }

  async handBack(id: string): Promise<{ labelled: boolean }> {
    await this.release(id);
    const { repo, number } = parseId(id);
    api(`repos/${repo}/issues/${number}/labels`, {
      method: "POST",
      body: { labels: [HUMAN_LABEL] },
    });
    return { labelled: true };
  }

  async release(id: string): Promise<void> {
    const { repo, number } = parseId(id);
    for (const label of [READY_LABEL, CLAIMED_LABEL]) {
      try {
        api(`repos/${repo}/issues/${number}/labels/${label}`, { method: "DELETE" });
      } catch {
        // not on the issue
      }
    }
  }

  async done(since: string): Promise<{ ticket: Ticket; readyAt: string | null }[]> {
    const me = forgeViewer();
    const out: { ticket: Ticket; readyAt: string | null }[] = [];
    for (const repo of this.repos) {
      for (const i of this.issues(repo, `state=closed&since=${since}`)) {
        if (i.state_reason === "not_planned" || Date.parse(i.closed_at) < Date.parse(since))
          continue;
        const labelled = paginate<any>(`repos/${repo}/issues/${i.number}/events`).filter(
          (e) => e.event === "labeled" && e.label?.name?.toLowerCase() === READY_LABEL,
        );
        out.push({
          ticket: toTicket(i, repo, [], me),
          readyAt: labelled.at(-1)?.created_at ?? null,
        });
      }
    }
    return out;
  }

  async viewer(): Promise<string> {
    const login = forgeViewer();
    if (!login) throw new GithubError("gh cannot tell who is signed in: run `gh auth login`");
    return login;
  }
}
