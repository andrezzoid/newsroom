import type { GhIssue } from "../scripts/trackers/github.ts";
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
export function githubIssue(over: Partial<GhIssue> & { labels?: string[] } = {}): GhIssue {
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

// A Claude Code transcript, one JSON record per line, shaped like a 2.1.317
// cloud session's: a user turn, the instructions and skills it loaded, an
// assistant turn, and a subagent's turn on another model.
export function transcript(over: { entrypoint?: string; claudeMd?: string } = {}): string {
  const base = { sessionId: "s-1", entrypoint: over.entrypoint ?? "remote_projects" };
  return [
    { ...base, type: "user", version: "2.1.316", message: { role: "user", content: "hi" } },
    {
      ...base,
      type: "attachment",
      version: "2.1.316",
      attachment: {
        type: "instructions",
        files: [{ path: "/w/r/CLAUDE.md", type: "Project", content: over.claudeMd ?? "# Rules" }],
      },
    },
    {
      ...base,
      type: "attachment",
      attachment: {
        type: "skill_listing",
        names: ["tdd", "pr"],
        digests: ["aaaa", "bbbb"],
        skillCount: 2,
      },
    },
    { type: "attachment", attachment: { type: "session_context", context: "me@example.com" } },
    {
      ...base,
      type: "assistant",
      version: "2.1.317",
      effort: "high",
      message: { model: "claude-opus-5-5" },
    },
    { ...base, type: "assistant", version: "2.1.317", message: { model: "<synthetic>" } },
    { ...base, type: "assistant", isSidechain: true, message: { model: "claude-haiku-5-5" } },
  ]
    .map((r) => JSON.stringify(r))
    .concat("not json")
    .join("\n");
}
