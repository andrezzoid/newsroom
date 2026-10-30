import type { LinearIssue } from "../scripts/trackers/linear.ts";
import type { Ticket } from "../scripts/trackers/types.ts";

export function ticket(over: Partial<Ticket> = {}): Ticket {
  return {
    id: "ENG-1",
    tracker: "linear",
    title: "App: do the thing",
    body: "Repo: andrezzoid/app\n\n## What to build",
    url: "https://linear.app/x/issue/ENG-1",
    state: "queued",
    stateName: "Todo",
    labels: ["ready-for-agent"],
    repo: "andrezzoid/app",
    branchName: "andre/eng-1-do-the-thing",
    priority: 2,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    completedAt: null,
    blockers: [],
    openChildren: 0,
    prs: [],
    closes: "Closes ENG-1",
    assignees: [],
    ...over,
  };
}

export function linearIssue(
  over: Omit<Partial<LinearIssue>, "labels"> & { labels?: string[] } = {},
): LinearIssue {
  const { labels, ...rest } = over;
  return {
    id: "uuid-1",
    identifier: "ENG-1",
    title: "App: do the thing",
    description: "Repo: andrezzoid/app\n\n## What to build",
    url: "https://linear.app/x/issue/ENG-1",
    branchName: "andre/eng-1-do-the-thing",
    priority: 2,
    createdAt: "2026-10-01T00:00:00Z",
    state: { name: "Todo", type: "unstarted" },
    team: { id: "team-1", key: "ENG" },
    assignee: null,
    labels: { nodes: (labels ?? ["ready-for-agent"]).map((name, i) => ({ id: `lbl-${i}`, name })) },
    parent: null,
    children: { nodes: [] },
    inverseRelations: { nodes: [] },
    attachments: { nodes: [] },
    briefs: { nodes: [] },
    ...rest,
  };
}

// A GitHub REST issue as `gh api repos/o/r/issues/12` returns it.
export function githubIssue(over: Record<string, unknown> & { labels?: string[] } = {}): any {
  const { labels, ...rest } = over;
  return {
    number: 12,
    title: "App: do the thing",
    body: "## What to build",
    html_url: "https://github.com/o/r/issues/12",
    state: "open",
    state_reason: null,
    labels: (labels ?? ["ready-for-agent"]).map((name) => ({ name })),
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    closed_at: null,
    ...rest,
  };
}
