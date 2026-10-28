// Pure ticket policy over the normalized Ticket: which tickets an agent may
// pick up, what a ticket asks for, which session holds it and where it stands.
// No tracker is named here.

import type { Ticket, TicketComment } from "./trackers/types.ts";

// Triage's state labels, plus the claim.
export const TRIAGE_LABEL = "needs-triage";
export const INFO_LABEL = "needs-info";
export const READY_LABEL = "ready-for-agent";
export const HUMAN_LABEL = "ready-for-human";
export const WONTFIX_LABEL = "wontfix";
export const CLAIMED_LABEL = "in-progress";
// A ticket with none of these is new, whatever else it carries: a reporter's
// `bug` label is not triage.
export const FACTORY_LABELS = [TRIAGE_LABEL, INFO_LABEL, READY_LABEL, HUMAN_LABEL, WONTFIX_LABEL, CLAIMED_LABEL];

export type Readiness = { ready: true } | { ready: false; reason: string };

// Whether an agent may build the ticket, whichever session holds it now:
// `tickets claim` asks this, and a take-over passes a claimed ticket.
export function claimable(t: Ticket): Readiness {
  if (!t.labels.includes(READY_LABEL)) return { ready: false, reason: `no ${READY_LABEL} label` };
  if (t.state === "done" || t.state === "canceled") return { ready: false, reason: `state is ${t.stateName}` };
  const open = t.blockers.filter((b) => !b.done);
  if (open.length > 0) return { ready: false, reason: `blocked by ${open.map((b) => b.id).join(", ")}` };
  // A parent with open children is a spec, so building it would build every
  // child at once (Matt Pocock's to-spec hazard).
  if (t.openChildren > 0) return { ready: false, reason: `parent of ${t.openChildren} open ticket(s)` };
  if (!t.repo) return { ready: false, reason: "no repository: add a Repo: owner/name line" };
  // The assignee is the human the ticket belongs to, and a colleague's ticket
  // is for their agents.
  if (t.assignees.length > 0 && !t.assignees.some((a) => a.me)) {
    return { ready: false, reason: `assigned to ${t.assignees.map((a) => a.name).join(", ")}` };
  }
  return { ready: true };
}

// Whether `tickets next` offers the ticket: claimable, and nobody holds it.
export function readiness(t: Ticket, opts: { repo?: string } = {}): Readiness {
  const c = claimable(t);
  if (!c.ready) return c;
  if (t.labels.includes(CLAIMED_LABEL)) return { ready: false, reason: `claimed (${CLAIMED_LABEL})` };
  if (t.state !== "queued") return { ready: false, reason: `state is ${t.stateName}` };
  if (opts.repo && t.repo !== opts.repo.toLowerCase()) return { ready: false, reason: `belongs to ${t.repo}` };
  return { ready: true };
}

// Priority 1 urgent … 4 low, 0 none; none sorts last, then oldest first.
export function byPriority(a: Ticket, b: Ticket): number {
  const pa = a.priority === 0 ? 5 : a.priority;
  const pb = b.priority === 0 ? 5 : b.priority;
  return pa - pb || a.createdAt.localeCompare(b.createdAt);
}

export function nextTickets(tickets: Ticket[], opts: { repo?: string } = {}) {
  const ready: Ticket[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const t of tickets) {
    const r = readiness(t, opts);
    if (r.ready) ready.push(t);
    else skipped.push({ id: t.id, reason: r.reason });
  }
  ready.sort(byPriority);
  return { ready, skipped };
}

const oldestFirst = (a: TicketComment, b: TicketComment) => Date.parse(a.createdAt) - Date.parse(b.createdAt);

// The claim is the in-progress label. Each claim also logs a comment naming
// the session, so anyone reading the ticket can find that session and steer
// it. Two sessions that claim one ticket at the same moment can both win:
// accepted, since one hourly routine does the dispatching.
export function claimLog(session: string, replaces: string | null): string {
  return `Claimed by ${session}.${replaces ? ` Takes over from ${replaces}.` : ""}`;
}

export function latestClaim(comments: TicketComment[]): TicketComment | null {
  return comments.filter((c) => c.body.startsWith("Claimed by ")).sort(oldestFirst).at(-1) ?? null;
}

// Who a claim log names: the session link, or the local session and host.
export function claimant(c: Pick<TicketComment, "body">): string {
  return /^Claimed by (.*?)\.(?:\s|$)/.exec(c.body)?.[1] ?? "an earlier session";
}

// A report starts with a title line "<Kind> · <subject>", as a heading or in
// bold. Hand-backs and revisions go on the ticket, the debrief (Done) and a
// hand-back after the pull request opens go on the pull request. Needs you
// marks one only the user can move.
const REPORT_TITLE = /^(Handed back|Revised|Done)\s*·\s*\S/i;
const NEEDS_YOU = /^\s*(?:#{1,6}\s*|\*\*|__)?Needs you\b/im;

export type Report = { kind: string; title: string; needsYou: boolean; at: string };

export function report(c: TicketComment): Report | null {
  const title = (c.body.trimStart().split("\n", 1)[0] ?? "").replace(/^#{1,6}\s*/, "").replace(/^(\*\*|__)(.*)\1$/, "$2").trim();
  const m = REPORT_TITLE.exec(title);
  if (!m) return null;
  const kind = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1).toLowerCase();
  return { kind, title, needsYou: NEEDS_YOU.test(c.body), at: c.createdAt };
}

export function latestReport(comments: TicketComment[]): Report | null {
  return [...comments].sort(oldestFirst).map(report).filter((r) => r !== null).at(-1) ?? null;
}

// Triage posts its agent brief as a comment and leaves the reporter's text
// alone, so the latest comment with an "## Agent Brief" heading is the brief.
export function latestBrief(comments: TicketComment[]): TicketComment | null {
  return comments.filter((c) => /^## Agent Brief\s*$/m.test(c.body)).sort(oldestFirst).at(-1) ?? null;
}

export type PlanPart = { kind: "body" | "brief" | "revised"; at: string; text: string };

// What a ticket asks for: triage's latest agent brief, or the body until one
// exists, then every Revised report posted after it, oldest first. A revision
// records an acceptance change the user agreed in a session; a newer brief
// replaces the revisions before it.
export function plan(t: Pick<Ticket, "body" | "createdAt">, comments: TicketComment[]): PlanPart[] {
  const brief = latestBrief(comments);
  const since = brief ? Date.parse(brief.createdAt) : -Infinity;
  const revisions = [...comments]
    .sort(oldestFirst)
    .filter((c) => Date.parse(c.createdAt) > since && report(c)?.kind === "Revised")
    .map((c) => ({ kind: "revised" as const, at: c.createdAt, text: c.body }));
  const head: PlanPart = brief ? { kind: "brief", at: brief.createdAt, text: brief.body } : { kind: "body", at: t.createdAt, text: t.body };
  return [head, ...revisions];
}

// Where a ticket is in the factory: the phase that acts on it next. Shape is
// the user's (or triage's); iterate builds it; babysit lands its pull request.
// A ticket handed back waits on the human even while its pull request is open.
export type Phase = "shape" | "iterate" | "babysit" | "done";
export function phaseOf(t: Pick<Ticket, "state" | "labels">, openPrs: string[]): Phase {
  if (t.state === "done" || t.state === "canceled") return "done";
  if (t.labels.includes(HUMAN_LABEL)) return "shape";
  if (openPrs.length > 0) return "babysit";
  if (t.labels.includes(READY_LABEL)) return "iterate";
  return "shape";
}

// The ticket a branch works on. GitHub branches are issue-<n>-slug (checked
// first, since "issue-12" also looks like a Linear key); Linear's suggested
// branch names carry the key, as in andre/eng-123-fix-login.
export function ticketFromBranch(branch: string, repo: string | null): string | null {
  const gh = /(?:^|\/)issue-(\d+)(?:-|$)/.exec(branch);
  if (gh) return repo ? `${repo.toLowerCase()}#${gh[1]}` : null;
  const m = /(?:^|[/_-])([a-z][a-z0-9]{1,9}-\d+)(?:[/_-]|$)/i.exec(branch);
  return m ? m[1]!.toUpperCase() : null;
}

// The tickets a pull request names itself: in its branch, or on a closing
// line of its body. `pr merge` checks these for a hand-back and clears their
// labels.
export function ticketsOfPr(pr: { body: string | null; headRef: string }, repo: string): string[] {
  const branch = ticketFromBranch(pr.headRef, repo);
  return [...new Set([...(branch ? [branch] : []), ...closedBy(pr.body ?? "", repo)])];
}

// The tickets a body closes, one per closing line: Closes ENG-123, Fixes #12,
// Resolves o/r#12 or an issue URL. A bare #12 is an issue of `repo`.
const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+(https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+|[\w.-]+\/[\w.-]+#\d+|#\d+|[a-z][a-z0-9]{1,9}-\d+)\b/gi;
export function closedBy(body: string, repo: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(CLOSING)) {
    const ref = m[1] ?? "";
    const url = /github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/.exec(ref);
    if (url) out.add(`${url[1]}#${url[2]}`.toLowerCase());
    else if (ref.startsWith("#")) out.add(`${repo.toLowerCase()}${ref}`);
    else if (ref.includes("#")) out.add(ref.toLowerCase());
    else out.add(ref.toUpperCase());
  }
  return [...out];
}

export function slug(title: string, max = 40): string {
  return title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, max)
    .replace(/-+$/, "");
}
