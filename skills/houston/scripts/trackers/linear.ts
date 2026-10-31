// Linear adapter: GraphQL over fetch. The key comes from LINEAR_API_KEY or,
// locally, from the linear CLI's own login. In a cloud environment the key can
// instead be an API credential that the agent proxy adds to requests for
// api.linear.app, unseen by the session: LINEAR_API_KEY=proxy-injected (the
// placeholder the cloud uses for GitHub too) says so, and the CLI sends no key.
// The query documents are validated against Linear's published schema.

import { parsePrUrl } from "../forge.ts";
import { run } from "../proc.ts";
import {
  BRIEF_HEADING,
  CLAIMED_LABEL,
  HOUSTON_LABELS,
  HUMAN_LABEL,
  latestBrief,
  READY_LABEL,
} from "../tickets.ts";
import {
  NotFound,
  type Ticket,
  type TicketComment,
  type TicketState,
  type Tracker,
} from "./types.ts";

const ENDPOINT = process.env.HOUSTON_LINEAR_URL ?? "https://api.linear.app/graphql";
export const PROXY_INJECTED = "proxy-injected";

export class LinearError extends Error {}

// The linear CLI's token, asked for once per process, since a command makes
// many requests.
let cliToken: string | null | undefined;

export function linearToken(): string | null {
  if (process.env.LINEAR_API_KEY) return process.env.LINEAR_API_KEY;
  if (cliToken === undefined) {
    const r = run("linear", ["auth", "token"]);
    cliToken = r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  }
  return cliToken;
}

export async function linear<T>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const key = linearToken();
  if (!key)
    throw new LinearError(
      "no Linear credentials: run `linear auth login` locally; in the cloud set LINEAR_API_KEY, or add an API credential for api.linear.app and set LINEAR_API_KEY=proxy-injected",
    );
  const auth: Record<string, string> =
    key === PROXY_INJECTED
      ? {}
      : { Authorization: key.startsWith("lin_api_") ? key : `Bearer ${key}` };
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify({ query, variables }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || json.errors) {
    throw new LinearError(
      `Linear: ${json.errors?.map((e: any) => e.message).join("; ") ?? `HTTP ${res.status}`}`,
    );
  }
  return json.data as T;
}

// Linear prices a query before it runs it and rejects one over 10,000 points,
// and a connection with no page size counts as 50 nodes, so every connection
// here names a small one: test/linear.spec.ts prices each query. The children
// are only the open ones, since readiness asks whether any is open. `briefs`
// holds the comments that may be triage's agent brief, which can carry the
// Repo line a reporter's description lacks.
export const ISSUE_FIELDS = `
fragment IssueFields on Issue {
  id identifier title description url branchName priority createdAt updatedAt completedAt
  state { id name type }
  team { id key }
  assignee { id name isMe }
  labels(first: 20) { nodes { id name parent { name } } }
  parent { identifier }
  children(first: 10, filter: { state: { type: { nin: ["completed", "canceled"] } } }) { nodes { identifier title state { type name } } }
  inverseRelations(first: 20) { nodes { type issue { identifier title state { type name } } } }
  attachments(first: 10) { nodes { url title } }
  briefs: comments(last: 3, filter: { body: { contains: "${BRIEF_HEADING}" } }) { nodes { id body createdAt } }
}`;

// Open tickets Houston reads: labelled with one of its labels, or new,
// with none of them, and filed by or assigned to the viewer.
export const OPEN_QUERY = `
query HoustonOpen($labels: [String!], $after: String) {
  issues(first: 50, after: $after, filter: {
    state: { type: { nin: ["completed", "canceled"] } }
    or: [
      { labels: { some: { name: { in: $labels } } } }
      { and: [
        { or: [{ labels: { length: { eq: 0 } } }, { labels: { every: { name: { nin: $labels } } } }] }
        { or: [{ creator: { isMe: { eq: true } } }, { assignee: { isMe: { eq: true } } }] }
      ] }
    ]
  }) { nodes { ...IssueFields } pageInfo { hasNextPage endCursor } }
}
${ISSUE_FIELDS}`;

export const ISSUE_QUERY = `
query HoustonIssue($id: String!) {
  issue(id: $id) {
    ...IssueFields
    comments(last: 50) { nodes { id body createdAt user { name } } }
  }
}
${ISSUE_FIELDS}`;

// The viewer's tickets completed since a moment, with the label changes that
// say when each became ready-for-agent.
export const DONE_QUERY = `
query HoustonDone($since: DateTimeOrDuration!, $after: String) {
  issues(first: 25, after: $after, filter: {
    assignee: { isMe: { eq: true } }
    completedAt: { gt: $since }
  }) { nodes { ...IssueFields history(first: 50) { nodes { createdAt addedLabelIds } } } pageInfo { hasNextPage endCursor } }
}
${ISSUE_FIELDS}`;

export const VIEWER_QUERY = `query HoustonViewer { viewer { id name } }`;

export const TEAMS_QUERY = `query HoustonTeams { teams(first: 250) { nodes { key } } }`;

// The workspace's team keys, uppercased, asked for once per process.
let teamKeys: Promise<Set<string>> | undefined;
export function linearTeams(): Promise<Set<string>> {
  teamKeys ??= linear<{ teams: { nodes: { key: string }[] } }>(TEAMS_QUERY).then(
    (d) => new Set(d.teams.nodes.map((t) => t.key.toUpperCase())),
  );
  return teamKeys;
}

export const TEAM_STATES_QUERY = `
query HoustonTeamStates($id: String!) {
  team(id: $id) { states { nodes { id name type position } } }
}`;

export const LABEL_QUERY = `
query HoustonLabel($name: String!) {
  issueLabels(first: 20, filter: { name: { eqIgnoreCase: $name } }) { nodes { id name team { id } } }
}`;

export const UPDATE_ISSUE = `
mutation HoustonUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success }
}`;

export const ADD_LABEL = `
mutation HoustonAddLabel($id: String!, $labelId: String!) {
  issueAddLabel(id: $id, labelId: $labelId) { success }
}`;

export const REMOVE_LABEL = `
mutation HoustonRemoveLabel($id: String!, $labelId: String!) {
  issueRemoveLabel(id: $id, labelId: $labelId) { success }
}`;

export const CREATE_COMMENT = `
mutation HoustonComment($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id } }
}`;

export const CREATE_ISSUE = `
mutation HoustonCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { identifier } }
}`;

type Ref = { identifier: string; title?: string; state: { type: string; name?: string } };
export type LinearIssue = {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  branchName: string;
  priority: number;
  createdAt: string;
  updatedAt?: string;
  completedAt?: string | null;
  state: { id?: string; name: string; type: string };
  team: { id: string; key: string };
  assignee: { id: string; name: string; isMe?: boolean } | null;
  labels: { nodes: { id?: string; name: string; parent?: { name: string } | null }[] };
  parent: { identifier: string } | null;
  children: { nodes: Ref[] };
  inverseRelations: { nodes: { type: string; issue: Ref }[] };
  attachments: { nodes: { url: string; title?: string | null }[] };
  briefs: { nodes: TicketComment[] };
};
type WithComments = LinearIssue & {
  comments: { nodes: { id: string; body: string; createdAt: string }[] };
};
type WithHistory = LinearIssue & {
  history: { nodes: { createdAt: string; addedLabelIds: string[] | null }[] };
};

const DONE = ["completed", "canceled"];
const STATE: Record<string, TicketState> = {
  triage: "queued",
  backlog: "queued",
  unstarted: "queued",
  started: "started",
  completed: "done",
  canceled: "canceled",
};

const REPO_LINE =
  /^[ \t>*_-]*repo(?:sitory)?[*_]*\s*:[\s*_`]*(?:https:\/\/github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\.git)?[`*_]*\s*$/im;
const GITHUB_URL = /github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?(?:\/|$)/;

// to-tickets writes a `Repo: owner/name` line in the description, and triage
// writes one in its agent brief, which is the plan once it exists, so the
// brief's line wins. Linear's GitHub integration attaches PR and commit links,
// which name the repo as well.
export function repoOf(
  issue: Pick<LinearIssue, "description" | "attachments" | "briefs">,
): string | null {
  for (const text of [latestBrief(issue.briefs.nodes)?.body ?? "", issue.description ?? ""]) {
    const [, repo] = REPO_LINE.exec(text) ?? [];
    if (repo) return repo.toLowerCase();
  }
  for (const a of issue.attachments.nodes) {
    const [, repo] = GITHUB_URL.exec(a.url) ?? [];
    if (repo) return repo.toLowerCase();
  }
  return null;
}

export function toTicket(i: LinearIssue): Ticket {
  return {
    id: i.identifier,
    tracker: "linear",
    title: i.title,
    body: i.description ?? "",
    url: i.url,
    state: STATE[i.state.type] ?? "queued",
    stateName: i.state.name,
    labels: i.labels.nodes.map((l) =>
      (l.parent?.name ? `${l.parent.name}:${l.name}` : l.name).toLowerCase(),
    ),
    repo: repoOf(i),
    branchName: i.branchName,
    priority: i.priority,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt ?? i.createdAt,
    completedAt: i.completedAt ?? null,
    blockers: i.inverseRelations.nodes
      .filter((r) => r.type === "blocks")
      .map((r) => ({
        id: r.issue.identifier,
        title: r.issue.title ?? "",
        done: DONE.includes(r.issue.state.type),
      })),
    openChildren: i.children.nodes.filter((c) => !DONE.includes(c.state.type)).length,
    prs: i.attachments.nodes.map((a) => a.url).filter((u) => parsePrUrl(u) !== null),
    closes: `Closes ${i.identifier}`,
    assignees: i.assignee ? [{ name: i.assignee.name, me: i.assignee.isMe === true }] : [],
  };
}

type IssuePage<T> = {
  issues: { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
};

// Every issue a paged `issues` query matches, following its cursor.
async function issues<T = LinearIssue>(
  query: string,
  variables: Record<string, unknown>,
): Promise<T[]> {
  const all: T[] = [];
  let after: string | null = null;
  do {
    const d: IssuePage<T> = await linear<IssuePage<T>>(query, { ...variables, after });
    all.push(...d.issues.nodes);
    after = d.issues.pageInfo.hasNextPage ? d.issues.pageInfo.endCursor : null;
  } while (after);
  return all;
}

export class LinearTracker implements Tracker {
  readonly name = "linear" as const;
  readonly scope = "tickets in Linear";
  private raw = new Map<string, WithComments>();

  // Linear answers an unknown identifier with null or an "Entity not found" error.
  private async issue(id: string): Promise<WithComments> {
    const d = await linear<{ issue: WithComments | null }>(ISSUE_QUERY, { id }).catch((e) => {
      throw e instanceof LinearError && /^Linear: Entity not found\b/.test(e.message)
        ? new NotFound(`no Linear issue ${id}`)
        : e;
    });
    if (!d.issue) throw new NotFound(`no Linear issue ${id}`);
    this.raw.set(id, d.issue);
    return d.issue;
  }

  // The issue an earlier get() fetched, else a fresh one.
  private async node(id: string): Promise<WithComments> {
    return this.raw.get(id) ?? (await this.issue(id));
  }

  private async firstState(teamId: string, type: string): Promise<string | null> {
    const d = await linear<{
      team: { states: { nodes: { id: string; type: string; position: number }[] } };
    }>(TEAM_STATES_QUERY, { id: teamId });
    return (
      d.team.states.nodes.filter((s) => s.type === type).sort((a, b) => a.position - b.position)[0]
        ?.id ?? null
    );
  }

  private async labelIds(name: string): Promise<{ id: string; team: { id: string } | null }[]> {
    return (
      await linear<{ issueLabels: { nodes: { id: string; team: { id: string } | null }[] } }>(
        LABEL_QUERY,
        { name },
      )
    ).issueLabels.nodes;
  }

  // The team's own label by that name, else the workspace's.
  private async labelId(name: string, teamId: string): Promise<string | null> {
    const nodes = await this.labelIds(name);
    return (nodes.find((l) => l.team?.id === teamId) ?? nodes.find((l) => !l.team))?.id ?? null;
  }

  private async unlabel(i: LinearIssue, names: string[]): Promise<void> {
    for (const l of i.labels.nodes.filter((l) => names.includes(l.name.toLowerCase()))) {
      if (l.id) await linear(REMOVE_LABEL, { id: i.id, labelId: l.id });
    }
  }

  async open(): Promise<Ticket[]> {
    return (await issues(OPEN_QUERY, { labels: HOUSTON_LABELS })).map(toTicket);
  }

  async get(id: string): Promise<{ ticket: Ticket; comments: TicketComment[] }> {
    const i = await this.issue(id);
    return {
      ticket: toTicket(i),
      comments: i.comments.nodes.map((c) => ({ id: c.id, body: c.body, createdAt: c.createdAt })),
    };
  }

  // The issue query already carries the comments, so one request costs the same.
  async comments(id: string): Promise<TicketComment[]> {
    return (await this.get(id)).comments;
  }

  async start(t: Ticket): Promise<void> {
    const i = await this.node(t.id);
    const claimed = t.labels.includes(CLAIMED_LABEL)
      ? null
      : await this.labelId(CLAIMED_LABEL, i.team.id);
    if (!t.labels.includes(CLAIMED_LABEL) && !claimed)
      throw new LinearError(
        `no ${CLAIMED_LABEL} label exists in Linear: create it, as /houston setup does`,
      );
    if (claimed) await linear(ADD_LABEL, { id: i.id, labelId: claimed });
    const input: Record<string, string> = {};
    if (t.assignees.length === 0)
      input.assigneeId = (await linear<{ viewer: { id: string } }>(VIEWER_QUERY)).viewer.id;
    if (t.state !== "started") {
      const started = await this.firstState(i.team.id, "started");
      if (started) input.stateId = started;
    }
    if (Object.keys(input).length > 0) await linear(UPDATE_ISSUE, { id: i.id, input });
  }

  async comment(id: string, body: string): Promise<void> {
    const i = await this.node(id);
    await linear(CREATE_COMMENT, { issueId: i.id, body });
  }

  async create(from: Ticket, title: string, body: string): Promise<string> {
    const i = await this.node(from.id);
    const d = await linear<{ issueCreate: { issue: { identifier: string } } }>(CREATE_ISSUE, {
      input: { teamId: i.team.id, title, description: body },
    });
    return d.issueCreate.issue.identifier;
  }

  async handBack(id: string): Promise<{ labelled: boolean }> {
    await this.release(id);
    const i = await this.node(id);
    const human = await this.labelId(HUMAN_LABEL, i.team.id);
    if (human) await linear(ADD_LABEL, { id: i.id, labelId: human });
    const todo = await this.firstState(i.team.id, "unstarted");
    if (todo) await linear(UPDATE_ISSUE, { id: i.id, input: { stateId: todo } });
    return { labelled: Boolean(human) };
  }

  async release(id: string): Promise<void> {
    await this.unlabel(await this.node(id), [READY_LABEL, CLAIMED_LABEL]);
  }

  async done(since: string): Promise<{ ticket: Ticket; readyAt: string | null }[]> {
    const ready = new Set((await this.labelIds(READY_LABEL)).map((l) => l.id));
    return (await issues<WithHistory>(DONE_QUERY, { since })).map((i) => ({
      ticket: toTicket(i),
      readyAt:
        i.history.nodes
          .filter((h) => h.addedLabelIds?.some((id) => ready.has(id)))
          .map((h) => h.createdAt)
          .sort()
          .at(-1) ?? null,
    }));
  }

  async viewer(): Promise<string> {
    return (await linear<{ viewer: { name: string } }>(VIEWER_QUERY)).viewer.name;
  }
}
