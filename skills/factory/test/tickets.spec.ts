import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  byPriority,
  claimant,
  claimLog,
  closedBy,
  latestClaim,
  plan,
  latestReport,
  nextTickets,
  phaseOf,
  readiness,
  report,
  ticketFromBranch,
  ticketsOfPr,
} from "../scripts/tickets.ts";
import { blockedByRefs, slug, toTicket as githubTicket } from "../scripts/trackers/github.ts";
import { normalizeId, trackerLine, trackerOf } from "../scripts/trackers/index.ts";
import { repoOf, toTicket as linearTicket } from "../scripts/trackers/linear.ts";
import { expect } from "./expect.ts";
import { githubIssue, linearIssue, ticket } from "./fixtures.ts";

describe("readiness", () => {
  test("labelled, queued, unblocked and with a repo is ready", () => {
    expect(readiness(ticket())).toEqual({ ready: true });
  });

  test("each missing condition names itself", () => {
    expect(readiness(ticket({ labels: [] }))).toEqual({
      ready: false,
      reason: "no ready-for-agent label",
    });
    expect(readiness(ticket({ labels: ["ready-for-agent", "in-progress"] }))).toEqual({
      ready: false,
      reason: "claimed (in-progress)",
    });
    expect(readiness(ticket({ state: "started", stateName: "In Progress" }))).toEqual({
      ready: false,
      reason: "state is In Progress",
    });
    expect(readiness(ticket({ repo: null }))).toEqual({
      ready: false,
      reason: "no repository: add a Repo: owner/name line",
    });
  });

  test("an open blocker blocks; a done one does not", () => {
    expect(readiness(ticket({ blockers: [{ id: "ENG-0", title: "", done: false }] }))).toEqual({
      ready: false,
      reason: "blocked by ENG-0",
    });
    expect(readiness(ticket({ blockers: [{ id: "ENG-0", title: "", done: true }] })).ready).toBe(
      true,
    );
  });

  test("a parent with open children is a spec, not a slice", () => {
    expect(readiness(ticket({ openChildren: 1 }))).toEqual({
      ready: false,
      reason: "parent of 1 open ticket(s)",
    });
  });

  test("a ticket assigned to someone else is theirs; unassigned or mine is ready", () => {
    expect(readiness(ticket({ assignees: [{ name: "Rita", me: false }] }))).toEqual({
      ready: false,
      reason: "assigned to Rita",
    });
    expect(
      readiness(
        ticket({
          assignees: [
            { name: "Rita", me: false },
            { name: "André", me: true },
          ],
        }),
      ).ready,
    ).toBe(true);
  });

  test("--repo filters to one repository, case-insensitively", () => {
    expect(readiness(ticket(), { repo: "AndreZzoid/App" }).ready).toBe(true);
    expect(readiness(ticket(), { repo: "andrezzoid/other" })).toEqual({
      ready: false,
      reason: "belongs to andrezzoid/app",
    });
  });
});

describe("ordering and branches", () => {
  test("urgent first, no-priority last, then oldest", () => {
    const a = ticket({ id: "A", priority: 0 });
    const b = ticket({ id: "B", priority: 1 });
    const c = ticket({ id: "C", priority: 3, createdAt: "2026-01-01T00:00:00Z" });
    const d = ticket({ id: "D", priority: 3, createdAt: "2026-02-01T00:00:00Z" });
    expect([a, d, c, b].sort(byPriority).map((t) => t.id)).toEqual(["B", "C", "D", "A"]);
    expect(nextTickets([a, ticket({ id: "X", labels: [] })]).skipped).toEqual([
      { id: "X", reason: "no ready-for-agent label" },
    ]);
  });

  for (const [branch, repo, expected] of [
    ["andre/eng-123-fix-login", "o/r", "ENG-123"],
    ["eng-7", null, "ENG-7"],
    ["feature/ABC2-44_thing", null, "ABC2-44"],
    ["issue-12-fix-login", "o/r", "o/r#12"],
    ["andre/issue-3", "o/r", "o/r#3"],
    ["issue-12-fix-login", null, null],
    ["main", "o/r", null],
  ] as const) {
    test(`ticket from branch ${branch} in ${repo}`, () => {
      expect(ticketFromBranch(branch, repo)).toBe(expected);
    });
  }

  test("a PR names its tickets in its branch and its closing lines", () => {
    expect(
      ticketsOfPr(
        {
          headRef: "andre/eng-1-thing",
          body: "Closes ENG-2\nfixes #12, resolves o/api#3\nCloses https://github.com/O/Web/issues/9\nSee #99",
        },
        "O/R",
      ),
    ).toEqual(["ENG-1", "ENG-2", "o/r#12", "o/api#3", "o/web#9"]);
    expect(ticketsOfPr({ headRef: "main", body: null }, "o/r")).toEqual([]);
  });

  // `pr merge` passes the repository as --repo or the PR's URL spells it.
  test("the branch and closing line a ticket gives name that ticket, and only it", () => {
    for (const [t, repo] of [
      [githubTicket(githubIssue(), "o/r"), "O/R"],
      [linearTicket(linearIssue()), "o/r"],
    ] as const) {
      expect(ticketsOfPr({ headRef: t.branchName, body: `Does it.\n\n${t.closes}` }, repo)).toEqual(
        [t.id],
      );
    }
  });

  test("slugs are short, ascii and hyphenated", () => {
    expect(slug("Café: fix the  Login flow!")).toBe("cafe-fix-the-login-flow");
    expect(slug("a".repeat(60)).length).toBe(40);
  });
});

describe("claims", () => {
  const log = (id: string, createdAt: string, session: string) => ({
    id,
    createdAt,
    body: claimLog(session, null),
  });

  test("the latest claim log names the session holding the ticket", () => {
    const cloud = log(
      "a",
      "2026-10-01T10:00:00Z",
      "[a cloud session](https://claude.ai/code/session_a)",
    );
    const local = log("b", "2026-10-02T10:00:00Z", "local session 1234 on andre-mac.local");
    const comments = [
      cloud,
      {
        id: "x",
        createdAt: "2026-10-03T10:00:00Z",
        body: "Unrelated, mentions Claimed by in passing",
      },
      local,
    ];
    expect(latestClaim(comments)).toBe(local);
    expect(claimant(local)).toBe("local session 1234 on andre-mac.local");
    expect(claimant(cloud)).toBe("[a cloud session](https://claude.ai/code/session_a)");
    expect(latestClaim([])).toBe(null);
  });

  test("a takeover names the claim it replaces", () => {
    expect(claimLog("a local session on mac", "a cloud session, claimed 2026-10-07 07:00")).toBe(
      "Claimed by a local session on mac. Takes over from a cloud session, claimed 2026-10-07 07:00.",
    );
  });
});

describe("reports", () => {
  const at = "2026-10-05T00:00:00Z";

  for (const [title, kind] of [
    ["## Handed back · acceptance line 2 cannot hold", "Handed back"],
    ["**Revised · the export drops archived rows**", "Revised"],
    ["Done · the export skips archived rows", "Done"],
    ["### done · the export skips archived rows", "Done"],
    ["**Done · the export skips archived rows**", "Done"],
  ]) {
    test(`"${title}" is a ${kind} report`, () => {
      expect(report(`${title}\n\nExpected: x`, at)?.kind).toBe(kind);
    });
  }

  test("other comments are not reports, and Needs you marks the ones only the user can move", () => {
    expect(report("Revised the plan, see below", at)).toBe(null);
    expect(report("Claimed by a cloud session.", at)).toBe(null);
    expect(report("Revised: no, I meant the title", at)).toBe(null);
    expect(report("Done: thanks", at)).toBe(null);
    expect(report("**Done - thanks**", at)).toBe(null);
    expect(report("## Handed back — see the thread", at)).toBe(null);
    expect(report("## Handed back · x\n\n**Needs you:** pick one", at)?.needsYou).toBe(true);
    expect(report("## Handed back · x\n\n### Needs you\n\nPick one", at)?.needsYou).toBe(true);
    expect(report("## Done · x\n\nNothing needs you.", at)?.needsYou).toBe(false);
    expect(report("## Deviation · x", at)).toBe(null);
    expect(report("## Unverified · x", at)).toBe(null);
  });

  test("the latest report wins, whatever order the comments arrive in", () => {
    const comments = [
      { id: "b", createdAt: "2026-10-06T00:00:00Z", body: "## Handed back · second" },
      { id: "a", createdAt: "2026-10-05T00:00:00Z", body: "## Handed back · first" },
    ];
    expect(latestReport(comments)?.title).toBe("Handed back · second");
    expect(comments[0]?.id).toBe("b");
  });
});

describe("plan", () => {
  const brief = (id: string, createdAt: string, text: string) => ({
    id,
    createdAt,
    body: `> *This was generated by AI during triage.*\n\n## Agent Brief\n\n${text}`,
  });
  const revised = (id: string, createdAt: string, text: string) => ({
    id,
    createdAt,
    body: `## Revised · ${text}`,
  });

  test("the body is the plan until triage posts an agent brief", () => {
    expect(
      plan(ticket(), [{ id: "c", createdAt: "2026-10-02T00:00:00Z", body: "Deviation: none" }]),
    ).toEqual([{ kind: "body", at: ticket().createdAt, text: ticket().body }]);
  });

  test("the latest agent brief wins over the body and older briefs", () => {
    const c = plan(ticket(), [
      brief("old", "2026-10-02T00:00:00Z", "first"),
      brief("new", "2026-10-03T00:00:00Z", "second"),
      { id: "x", createdAt: "2026-10-04T00:00:00Z", body: "Mentions ## Agent Brief inline" },
    ]);
    expect(c).toHaveLength(1);
    expect(c[0]?.kind).toBe("brief");
    expect(c[0]?.text).toContain("second");
  });

  test("revisions after the latest brief join it, oldest first; a newer brief replaces older revisions", () => {
    const comments = [
      revised("r0", "2026-10-02T12:00:00Z", "before the brief"),
      brief("b", "2026-10-03T00:00:00Z", "the brief"),
      revised("r2", "2026-10-05T00:00:00Z", "second"),
      revised("r1", "2026-10-04T00:00:00Z", "first"),
    ];
    expect(plan(ticket(), comments).map((p) => [p.kind, p.at])).toEqual([
      ["brief", "2026-10-03T00:00:00Z"],
      ["revised", "2026-10-04T00:00:00Z"],
      ["revised", "2026-10-05T00:00:00Z"],
    ]);
    expect(
      plan(ticket(), [revised("r", "2026-10-04T00:00:00Z", "no brief")]).map((p) => p.kind),
    ).toEqual(["body", "revised"]);
  });
});

describe("phase", () => {
  test("a closed ticket is done, an open PR means babysit, the ready label means iterate", () => {
    expect(phaseOf(ticket({ state: "done" }), [])).toBe("done");
    expect(phaseOf(ticket({ state: "canceled" }), ["https://github.com/o/r/pull/7"])).toBe("done");
    expect(
      phaseOf(ticket({ labels: [], state: "started" }), ["https://github.com/o/r/pull/7"]),
    ).toBe("babysit");
    expect(phaseOf(ticket(), [])).toBe("iterate");
    expect(phaseOf(ticket({ state: "started" }), [])).toBe("iterate");
  });

  test("anything else is shape, including a ticket waiting on a human", () => {
    expect(phaseOf(ticket({ labels: ["needs-info"] }), [])).toBe("shape");
    expect(phaseOf(ticket({ labels: ["ready-for-human"] }), [])).toBe("shape");
    expect(phaseOf(ticket({ labels: ["ready-for-agent", "ready-for-human"] }), [])).toBe("shape");
  });

  test("a ticket handed back with its pull request still open waits on the human", () => {
    expect(
      phaseOf(ticket({ labels: ["ready-for-human"], state: "started" }), [
        "https://github.com/o/r/pull/7",
      ]),
    ).toBe("shape");
  });
});

describe("ticket ids", () => {
  test("the id says which tracker owns the ticket", () => {
    expect(trackerOf("ENG-12")).toBe("linear");
    expect(trackerOf("andrezzoid/app#12")).toBe("github");
    expect(trackerOf("#12")).toBe("github");
    expect(trackerOf("12")).toBe(null);
  });

  test("every reader of an id accepts the same Linear keys", () => {
    for (const key of ["A-1", "ENG-12", "ABCDEFGHIJ-3"]) {
      expect(trackerOf(key)).toBe("linear");
      expect(ticketFromBranch(`andre/${key.toLowerCase()}-thing`, null)).toBe(key);
      expect(closedBy(`Closes ${key}`, "o/r")).toEqual([key]);
    }
    expect(trackerOf("ABCDEFGHIJK-3")).toBe(null);
  });

  test("a repo names its tracker in the Tracker line of its Agent skills block", () => {
    const md = (block: string) =>
      `# Repo\n\n## Agent skills\n\n${block}\n\n## Testing\n\nTracker: Linear, in another section`;
    expect(trackerLine(md("Tracker: GitHub Issues\nLabels: needs-triage"))).toBe("github");
    expect(trackerLine(md("- **Tracker:** Linear, team ENG"))).toBe("linear");
    expect(trackerLine(md("Labels: needs-triage"))).toBe(null);
    expect(trackerLine("Tracker: GitHub Issues")).toBe(null);
    expect(trackerLine(null)).toBe(null);
  });

  test("#12 needs the repository at hand", () => {
    expect(normalizeId("#12", "AndreZzoid/App")).toBe("andrezzoid/app#12");
    expect(normalizeId("eng-4", null)).toBe("ENG-4");
    expect(() => normalizeId("#12", null)).toThrow(/needs a repository/);
  });
});

describe("Linear adapter", () => {
  for (const [description, expected] of [
    ["Repo: andrezzoid/app", "andrezzoid/app"],
    ["**Repo:** `andrezzoid/app`", "andrezzoid/app"],
    ["repository: https://github.com/Org/Thing.git", "org/thing"],
    ["> Repo: org/my.repo", "org/my.repo"],
  ] as const) {
    test(`repo from "${description}"`, () => {
      expect(repoOf({ description, attachments: { nodes: [] }, briefs: { nodes: [] } })).toBe(
        expected,
      );
    });
  }

  test("repo falls back to a GitHub attachment", () => {
    expect(
      repoOf({
        description: null,
        attachments: { nodes: [{ url: "https://github.com/org/app/pull/3" }] },
        briefs: { nodes: [] },
      }),
    ).toBe("org/app");
  });

  test("triage's agent brief names the repo over the description, as it is the plan", () => {
    const briefs = {
      nodes: [
        { id: "b1", body: "## Agent Brief\n\nRepo: org/new", createdAt: "2026-10-02T00:00:00Z" },
      ],
    };
    expect(repoOf({ description: "Repo: org/old", attachments: { nodes: [] }, briefs })).toBe(
      "org/new",
    );
  });

  test("a brief with no Repo line leaves the description's", () => {
    const briefs = {
      nodes: [
        { id: "b1", body: "## Agent Brief\n\nNo repo here.", createdAt: "2026-10-02T00:00:00Z" },
      ],
    };
    expect(repoOf({ description: "Repo: org/app", attachments: { nodes: [] }, briefs })).toBe(
      "org/app",
    );
  });

  test("normalizes state, blockers, children and linked PRs", () => {
    const t = linearTicket(
      linearIssue({
        state: { name: "In Review", type: "started" },
        inverseRelations: {
          nodes: [
            {
              type: "blocks",
              issue: { identifier: "ENG-0", title: "First", state: { type: "canceled" } },
            },
            { type: "related", issue: { identifier: "ENG-9", state: { type: "started" } } },
          ],
        },
        children: {
          nodes: [
            { identifier: "ENG-2", state: { type: "unstarted" } },
            { identifier: "ENG-3", state: { type: "completed" } },
          ],
        },
        attachments: {
          nodes: [{ url: "https://github.com/o/r/pull/4" }, { url: "https://figma.com/x" }],
        },
      }),
    );
    expect(t).toMatchObject({
      id: "ENG-1",
      tracker: "linear",
      state: "started",
      stateName: "In Review",
      repo: "andrezzoid/app",
      blockers: [{ id: "ENG-0", title: "First", done: true }],
      openChildren: 1,
      prs: ["https://github.com/o/r/pull/4"],
      closes: "Closes ENG-1",
    });
  });

  test("the assignee says whether the ticket is the viewer's", () => {
    expect(
      linearTicket(linearIssue({ assignee: { id: "u9", name: "Rita", isMe: false } })).assignees,
    ).toEqual([{ name: "Rita", me: false }]);
    expect(linearTicket(linearIssue()).assignees).toEqual([]);
  });
});

describe("GitHub adapter", () => {
  test("an open labelled issue is a queued ticket in its repository", () => {
    expect(githubTicket(githubIssue(), "o/r")).toMatchObject({
      id: "o/r#12",
      tracker: "github",
      state: "queued",
      repo: "o/r",
      branchName: "issue-12-app-do-the-thing",
      closes: "Closes #12",
      openChildren: 0,
    });
  });

  test("assignees are marked as the viewer's by login", () => {
    const t = githubTicket(
      githubIssue({ assignees: [{ login: "andrezzoid" }, { login: "rita" }] }),
      "o/r",
      [],
      "andrezzoid",
    );
    expect(t.assignees).toEqual([
      { name: "andrezzoid", me: true },
      { name: "rita", me: false },
    ]);
  });

  test("in-progress means started; closed means done unless not planned", () => {
    expect(
      githubTicket(githubIssue({ labels: ["ready-for-agent", "In-Progress"] }), "o/r").state,
    ).toBe("started");
    expect(
      githubTicket(
        githubIssue({
          state: "closed",
          state_reason: "completed",
          closed_at: "2026-10-02T00:00:00Z",
        }),
        "o/r",
      ),
    ).toMatchObject({ state: "done", completedAt: "2026-10-02T00:00:00Z" });
    expect(
      githubTicket(githubIssue({ state: "closed", state_reason: "not_planned" }), "o/r").state,
    ).toBe("canceled");
  });

  test("open sub-issues make the issue a parent", () => {
    expect(
      githubTicket(githubIssue({ sub_issues_summary: { total: 3, completed: 1 } }), "o/r")
        .openChildren,
    ).toBe(2);
  });

  test("Blocked by lines name blockers when native dependencies are not used", () => {
    expect(
      blockedByRefs("Do it.\n\nBlocked by: #3, O/Other#4\n**Blocked by** #4 and #9", "o/r"),
    ).toEqual(["o/r#3", "o/other#4", "o/r#4", "o/r#9"]);
    expect(blockedByRefs("Fixes #3\n\n## Testing\n\nSee #5", "o/r")).toEqual([]);
    expect(
      blockedByRefs(
        "## Blocked by\n\n- https://github.com/O/R/issues/12\n- https://github.com/o/api/issues/3",
        "o/r",
      ),
    ).toEqual(["o/r#12", "o/api#3"]);
  });

  test("the Blocked by section of the plan protocol's ticket template names blockers", () => {
    const template = readFileSync(
      join(import.meta.dirname, "../../protocol-plan/references/ticket.md"),
      "utf8",
    );
    expect(template).toContain("## Blocked by");
    const body = template
      .replace(/(## Blocked by\n\n)[^\n]*/, "$1- #12\n- o/api#3")
      .replace(/(## Acceptance criteria\n\n)[^\n]*/, "$1- [ ] see #99")
      .replace(/(## Out of scope\n\n)[^\n]*/, "$1- Changing #7");
    expect(blockedByRefs(body, "o/r")).toEqual(["o/r#12", "o/api#3"]);
  });
});
