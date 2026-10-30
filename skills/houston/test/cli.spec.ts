// End to end: the real CLI as a subprocess, a fake `gh`, a fake `claude`, and
// a mock Linear.

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { expectedSkills, parseArgs } from "../scripts/cli.ts";
import { claimLog } from "../scripts/tickets.ts";
import { expect } from "./expect.ts";
import { githubIssue, linearIssue } from "./fixtures.ts";

const CLI = join(import.meta.dirname, "..", "scripts", "cli.ts");
const FAKE_GH = join(import.meta.dirname, "fake-gh.ts");
const SHA = "c".repeat(40);
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

type LinearCall = { op: string; variables: any; auth: string | undefined };
let linearCalls: LinearCall[] = [];
let linearIssues: any[] = [];
let doneIssues: any[] = [];
// Comments on ENG-1, or on whichever ticket a test names in commentsFor.
let issueComments: any[] = [];
let commentsFor: Record<string, any[]> = {};
// Labels the mock workspace lacks.
let missingLabels: string[] = [];
// Linear pages every issue list; a test shrinks the page to make the CLI follow the cursor.
let pageSize = 100;
// The error Linear answers every request with, as for a disabled account.
let linearDown: string | null = null;
// The workspace's team keys.
let linearTeams = ["ENG"];
// Linear answers an unknown issue with an error instead of null.
let notFoundAsError = false;

function page(nodes: any[], after: string | null | undefined) {
  const start = after ? Number(after) : 0;
  const end = start + pageSize;
  return {
    nodes: nodes.slice(start, end),
    pageInfo: { hasNextPage: end < nodes.length, endCursor: String(end) },
  };
}

function answer(op: string, variables: any): { status: number; body: unknown } {
  const data = (d: unknown) => ({ status: 200, body: { data: d } });
  switch (op) {
    case "HoustonOpen":
      return data({ issues: page(linearIssues, variables.after) });
    case "HoustonDone":
      return data({ issues: page(doneIssues, variables.after) });
    case "HoustonIssue": {
      const found = [...linearIssues, ...doneIssues].find((i) => i.identifier === variables.id);
      if (!found && notFoundAsError)
        return {
          status: 200,
          body: {
            errors: [{ message: "Entity not found: Issue - Could not find referenced Issue." }],
          },
        };
      return data({
        issue: found
          ? { ...found, comments: { nodes: commentsFor[variables.id] ?? issueComments } }
          : null,
      });
    }
    case "HoustonTeams":
      return data({ teams: { nodes: linearTeams.map((key) => ({ key })) } });
    case "HoustonViewer":
      return data({ viewer: { id: "me", name: "André" } });
    case "HoustonTeamStates":
      return data({
        team: {
          states: {
            nodes: [
              { id: "s-todo", type: "unstarted", position: 1 },
              { id: "s-review", type: "started", position: 3 },
              { id: "s-doing", type: "started", position: 2 },
            ],
          },
        },
      });
    case "HoustonUpdate":
      return data({ issueUpdate: { success: true } });
    case "HoustonComment":
      issueComments.push({
        id: `c-${issueComments.length}`,
        body: variables.body,
        createdAt: new Date().toISOString(),
        user: { name: "André" },
      });
      return data({ commentCreate: { success: true, comment: { id: "c" } } });
    case "HoustonLabel":
      return data({
        issueLabels: {
          nodes: missingLabels.includes(variables.name)
            ? []
            : [{ id: `lbl-${variables.name}`, name: variables.name, team: null }],
        },
      });
    case "HoustonCreate":
      return data({ issueCreate: { success: true, issue: { identifier: "ENG-50" } } });
    case "HoustonRemoveLabel":
      return data({ issueRemoveLabel: { success: true } });
    case "HoustonAddLabel":
      return data({ issueAddLabel: { success: true } });
    default:
      return { status: 400, body: { errors: [{ message: `unexpected ${op}` }] } };
  }
}

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const { query, variables } = JSON.parse(raw);
    const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "?";
    linearCalls.push({ op, variables, auth: req.headers.authorization });
    const { status, body } = linearDown
      ? { status: 200, body: { errors: [{ message: linearDown }] } }
      : answer(op, variables);
    res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  });
});
let linearUrl = "";
before(async () => {
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  linearUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`;
});
after(() => server.close());

// A pull request as `gh api repos/o/r/pulls/<n>` returns it.
function pull(number: number, over: Record<string, unknown> = {}) {
  return {
    number,
    html_url: `https://github.com/o/r/pull/${number}`,
    title: "App: thing",
    body: "Does it.\n\nCloses ENG-1",
    state: "open",
    merged: false,
    draft: false,
    mergeable: true,
    mergeable_state: "clean",
    updated_at: hoursAgo(1),
    head: { sha: SHA, ref: "andre/eng-1-thing" },
    base: { ref: "main" },
    ...over,
  };
}

let dir: string;
function routes(over: Record<string, unknown> = {}) {
  const all = {
    "GET repos/o/r/pulls/7": pull(7),
    [`GET repos/o/r/commits/${SHA}/check-runs`]: {
      check_runs: [{ id: 1, name: "test", status: "completed", conclusion: "success" }],
    },
    [`GET repos/o/r/commits/${SHA}/status`]: { state: "success", statuses: [] },
    "GET repos/o/r/pulls/7/reviews": [],
    "GET repos/o/r": {
      allow_squash_merge: true,
      allow_merge_commit: true,
      allow_rebase_merge: true,
    },
    "GET user": { login: "andrezzoid" },
    GRAPHQL: {
      data: { repository: { pullRequest: { reviewThreads: { nodes: [{ isResolved: true }] } } } },
    },
    "PUT repos/o/r/pulls/7/merge": { merged: true },
    ...over,
  };
  writeFileSync(join(dir, "routes.json"), JSON.stringify(all));
}
const current = () => JSON.parse(readFileSync(join(dir, "routes.json"), "utf8"));

function ghCalls(): { args: string[]; stdin: string | null }[] {
  try {
    return readFileSync(join(dir, "calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

const sent = (method: string, path: string) =>
  ghCalls()
    .filter((c) => c.args[1] === path && c.args.includes(method))
    .map((c) => JSON.parse(c.stdin ?? "null"));
const ops = (op: string) => linearCalls.filter((c) => c.op === op).map((c) => c.variables);

// Async on purpose: the mock Linear answers from this same process. Runs in
// a scratch folder unless told otherwise, so no real clone leaks in, and with
// no session of its own, since these tests run inside one.
function run(
  args: string[],
  env: Record<string, string> = {},
  cwd = dir,
): Promise<{ out: string; err: string; code: number }> {
  const p = spawn(process.execPath, [CLI, ...args], {
    cwd,
    env: {
      ...process.env,
      HOUSTON_GH: FAKE_GH,
      FAKE_GH_DIR: dir,
      HOUSTON_LINEAR_URL: linearUrl,
      HOUSTON_CLAUDE: "/nonexistent/claude",
      LINEAR_API_KEY: "lin_api_test",
      HOUSTON_GITHUB_REPOS: "",
      CLAUDE_CODE_REMOTE: "",
      CLAUDE_CODE_REMOTE_SESSION_ID: "",
      CLAUDE_CODE_SESSION_ID: "",
      ...env,
    },
  });
  let out = "";
  let err = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (err += d));
  return new Promise((ok) => p.on("close", (code) => ok({ out, err, code: code ?? 1 })));
}

function clone(): string {
  const path = join(dir, "clone");
  spawnSync("git", ["init", "-q", path]);
  spawnSync("git", ["-C", path, "remote", "add", "origin", "https://github.com/o/r.git"]);
  return path;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "houston-cli-"));
  linearCalls = [];
  issueComments = [];
  commentsFor = {};
  missingLabels = [];
  doneIssues = [];
  pageSize = 100;
  linearDown = null;
  linearTeams = ["ENG"];
  notFoundAsError = false;
  linearIssues = [linearIssue({ identifier: "ENG-1" })];
  routes();
});

// Stow installs the skill behind symlinks; bin/houston resolves them, but
// anything that starts cli.ts directly must not silently do nothing.
test("cli.ts runs when started through a symlink", () => {
  const link = join(mkdtempSync(join(tmpdir(), "houston-link-")), "cli.ts");
  symlinkSync(CLI, link);
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", link, "--help"], {
    encoding: "utf8",
  });
  expect(r.stdout).toContain("houston:");
});

// Node before 22.18 cannot load cli.ts at all, so only the shim can say why.
test("bin/houston runs on Node 22.18 or later, and names the minimum below it", () => {
  const shim = join(import.meta.dirname, "..", "bin", "houston");
  const ok = spawnSync(shim, ["--help"], { encoding: "utf8" });
  expect(ok.stdout).toContain("houston:");
  const bin = mkdtempSync(join(tmpdir(), "houston-node-"));
  const node = join(bin, "node");
  writeFileSync(node, "#!/bin/sh\necho v22.17.0\n");
  chmodSync(node, 0o755);
  const old = spawnSync(shim, ["--help"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
  });
  expect(old.status).toBe(127);
  expect(old.stderr).toContain("houston needs Node 22.18 or later, and found v22.17.0");
  // A version manager's shim can answer with an error instead of a version.
  writeFileSync(node, "#!/bin/sh\necho mise ERROR no version set\n");
  const junk = spawnSync(shim, ["--help"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
  });
  expect(junk.status).toBe(127);
  expect(junk.stderr).toBe(
    "houston needs Node 22.18 or later, and found mise ERROR no version set (mise install node)\n",
  );
});

describe("pr status", () => {
  test("reports facts as JSON and exits 0", async () => {
    const r = await run(["pr", "status", "--json", "7", "--repo", "o/r"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const s = JSON.parse(r.out);
    expect(s).toMatchObject({
      number: 7,
      state: "open",
      draft: false,
      conflicts: false,
      unresolvedThreads: 0,
      checks: { failing: [], pending: [], passing: 1 },
      blockers: [],
    });
    expect("next" in s || "verdict" in s).toBe(false);
    expect(s.mergeableState).toBe("clean");
    for (const gone of ["body", "pr", "mergeState"]) expect(gone in s).toBe(false);
  });

  test("cloud sessions read review threads from the ccr route", async () => {
    routes({
      "GET repos/o/r/pulls/7/ccr/review_threads": [{ is_resolved: false }],
      GRAPHQL: undefined,
    });
    const r = await run(["pr", "status", "7", "--repo", "o/r", "--json"], {
      CLAUDE_CODE_REMOTE: "true",
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).unresolvedThreads).toBe(1);
  });

  test("threads neither route can read block a merge instead of counting as none", async () => {
    routes({ GRAPHQL: { data: { repository: null } } });
    const s = JSON.parse((await run(["pr", "status", "7", "--repo", "o/r", "--json"])).out);
    expect(s.unresolvedThreads).toBe(null);
    expect(s.blockers).toContain("review threads could not be read");
  });

  test("names a failing check, and what blocks a merge, and still exits 0", async () => {
    routes({
      [`GET repos/o/r/commits/${SHA}/check-runs`]: {
        check_runs: [{ id: 1, name: "lint", status: "completed", conclusion: "failure" }],
      },
    });
    const r = await run(["pr", "status", "7", "--repo", "o/r"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("blocks a merge: failing: lint");
  });
});

describe("pr watch", () => {
  test("refuses an interval that is not a positive number of seconds", async () => {
    // A closed pull request ends the watch after one poll, should the interval get through.
    routes({ "GET repos/o/r/pulls/7": pull(7, { state: "closed" }) });
    for (const interval of ["1m", "0"]) {
      const r = await run(["pr", "watch", "7", "--repo", "o/r", "--interval", interval]);
      expect(r.code).toBe(64);
      expect(r.err).toContain("usage: houston pr watch");
    }
    expect(ghCalls()).toEqual([]);
  });
});

describe("pr merge", () => {
  test("merges at the checked head with the repo's method, then takes Houston's labels off its ticket", async () => {
    linearIssues = [
      linearIssue({ identifier: "ENG-1", labels: ["ready-for-agent", "in-progress"] }),
    ];
    const r = await run(["pr", "merge", "7", "--repo", "o/r"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(sent("PUT", "repos/o/r/pulls/7/merge")).toEqual([{ merge_method: "squash", sha: SHA }]);
    expect(ops("HoustonRemoveLabel")).toEqual([
      { id: "uuid-1", labelId: "lbl-0" },
      { id: "uuid-1", labelId: "lbl-1" },
    ]);
  });

  test("refuses with every blocker named and never calls the merge endpoint", async () => {
    routes({
      [`GET repos/o/r/commits/${SHA}/check-runs`]: {
        check_runs: [{ id: 1, name: "lint", status: "completed", conclusion: "failure" }],
      },
      GRAPHQL: {
        data: {
          repository: { pullRequest: { reviewThreads: { nodes: [{ isResolved: false }] } } },
        },
      },
    });
    const r = await run(["pr", "merge", "7", "--repo", "o/r"]);
    expect(r.code).toBe(3);
    expect(r.out).toContain("failing: lint");
    expect(r.out).toContain("1 open review thread(s)");
    expect(ghCalls().some((c) => c.args.includes("PUT"))).toBe(false);
  });

  test("refuses while the ticket the pull request names is handed back", async () => {
    linearIssues = [linearIssue({ identifier: "ENG-1", labels: ["ready-for-human"] })];
    const r = await run(["pr", "merge", "7", "--repo", "o/r"]);
    expect(r.code).toBe(3);
    expect(r.out).toContain("ENG-1 is handed back (ready-for-human)");
    expect(ghCalls().some((c) => c.args.includes("PUT"))).toBe(false);
  });

  test("uses a merge commit where the repo turns squash off", async () => {
    routes({ "GET repos/o/r": { allow_squash_merge: false, allow_merge_commit: true } });
    expect((await run(["pr", "merge", "7", "--repo", "o/r"])).code).toBe(0);
    expect(sent("PUT", "repos/o/r/pulls/7/merge")).toEqual([{ merge_method: "merge", sha: SHA }]);
  });

  test("checks and releases the GitHub issue its branch names", async () => {
    routes({
      "GET repos/o/r/pulls/7": pull(7, { body: null, head: { sha: SHA, ref: "issue-12-thing" } }),
      "GET repos/o/r/issues/12": githubIssue({ labels: ["ready-for-agent", "in-progress"] }),
      "GET repos/o/r/issues/12/comments": [],
      "GET repos/o/r/pulls?state=open": [
        pull(7, { body: null, head: { sha: SHA, ref: "issue-12-thing" } }),
      ],
      "DELETE repos/o/r/issues/12/labels/ready-for-agent": [],
      "DELETE repos/o/r/issues/12/labels/in-progress": [],
    });
    const r = await run(["pr", "merge", "7", "--repo", "o/r"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(
      ghCalls()
        .filter((c) => c.args.includes("DELETE"))
        .map((c) => c.args[1]),
    ).toEqual([
      "repos/o/r/issues/12/labels/ready-for-agent",
      "repos/o/r/issues/12/labels/in-progress",
    ]);
    expect(linearCalls).toEqual([]);
  });

  test("an id its tracker does not know is noted, not checked, and the merge goes on", async () => {
    routes({
      "GET repos/o/r/pulls/7": pull(7, {
        body: "Fixes #99",
        head: { sha: SHA, ref: "fix-eng-404" },
      }),
    });
    const r = await run(["pr", "merge", "7", "--repo", "o/r"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("ENG-404 names no ticket");
    expect(r.out).toContain("o/r#99 names no ticket");
    // Linear can also answer an unknown identifier with an error instead of null.
    notFoundAsError = true;
    const again = await run(["pr", "merge", "7", "--repo", "o/r"]);
    expect(again.code).toBe(0);
    expect(again.out).toContain("ENG-404 names no ticket");
    expect(sent("PUT", "repos/o/r/pulls/7/merge")).toHaveLength(2);
  });

  // Branch names such as fix-utf-8 or release-2024-10 look like Linear keys.
  test("a Linear-looking id names a ticket only when its team is in the connected workspace", async () => {
    routes({
      "GET repos/o/r/pulls/7": pull(7, { body: null, head: { sha: SHA, ref: "fix-utf-8" } }),
    });
    const r = await run(["pr", "merge", "7", "--repo", "o/r"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("UTF-8 names no ticket, so it was not checked: Linear has no team UTF");
    expect(ops("HoustonIssue")).toEqual([]);
  });

  test("without Linear connected, a Linear-looking id names no ticket and the merge goes on", async () => {
    routes({
      "GET repos/o/r/pulls/7": pull(7, {
        body: null,
        head: { sha: SHA, ref: "andre/eng-1-thing" },
      }),
    });
    const r = await run(["pr", "merge", "7", "--repo", "o/r"], {
      LINEAR_API_KEY: "",
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      "ENG-1 names no ticket, so it was not checked: Linear is not connected",
    );
    expect(linearCalls).toEqual([]);
  });

  test("refuses when Linear fails with an error that only mentions not found", async () => {
    linearDown = "Credential not found for api.linear.app";
    const r = await run(["pr", "merge", "7", "--repo", "o/r"]);
    expect(r.code).toBe(3);
    expect(r.out).toContain(
      "ENG-1 could not be read: Linear: Credential not found for api.linear.app",
    );
    expect(ghCalls().some((c) => c.args.includes("PUT"))).toBe(false);
  });

  test("refuses when the tracker fails to answer for a ticket the pull request names", async () => {
    linearDown = "Rate limit exceeded";
    const r = await run(["pr", "merge", "7", "--repo", "o/r"]);
    expect(r.code).toBe(3);
    expect(r.out).toContain("ENG-1 could not be read: Linear: Rate limit exceeded");
    expect(ghCalls().some((c) => c.args.includes("PUT"))).toBe(false);
  });
});

describe("pr reply and resolve", () => {
  const FOOTER = "\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_";
  const threads = {
    GRAPHQL: {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [{ id: "T1", isResolved: false, comments: { nodes: [{ databaseId: 55 }] } }],
            },
          },
        },
        resolveReviewThread: { thread: { isResolved: true } },
      },
    },
  };
  const graphqlCalls = () =>
    ghCalls()
      .filter((c) => c.args[1] === "graphql")
      .map((c) => c.args.join(" "));

  test("reply posts to the comment's thread with the Claude Code footer", async () => {
    routes({ "POST repos/o/r/pulls/7/comments/55/replies": { id: 56 } });
    const body = join(dir, "reply.md");
    writeFileSync(body, "Fixed in abc1234: the retry now backs off.\n");
    const r = await run([
      "pr",
      "reply",
      "7",
      "--repo",
      "o/r",
      "--comment",
      "55",
      "--body-file",
      body,
    ]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(sent("POST", "repos/o/r/pulls/7/comments/55/replies")).toEqual([
      { body: `Fixed in abc1234: the retry now backs off.${FOOTER}` },
    ]);
    expect(graphqlCalls()).toEqual([]);
  });

  test("reply --resolve also resolves the thread, through GraphQL locally", async () => {
    routes({ "POST repos/o/r/pulls/7/comments/55/replies": { id: 56 }, ...threads });
    const r = await run([
      "pr",
      "reply",
      "7",
      "--repo",
      "o/r",
      "--comment",
      "55",
      "--body",
      "Rejected: no caller passes null.",
      "--resolve",
    ]);
    expect(r.err).toBe("");
    expect(sent("POST", "repos/o/r/pulls/7/comments/55/replies")).toEqual([
      { body: `Rejected: no caller passes null.${FOOTER}` },
    ]);
    expect(graphqlCalls().find((c) => c.includes("resolveReviewThread"))).toContain("id=T1");
  });

  test("resolve uses the ccr route in a cloud session, where GraphQL is blocked", async () => {
    routes({ "POST repos/o/r/pulls/7/ccr/comments/55/resolve": {} });
    const r = await run(["pr", "resolve", "7", "--repo", "o/r", "--comment", "55"], {
      CLAUDE_CODE_REMOTE: "true",
    });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(
      ghCalls().filter((c) => c.args[1] === "repos/o/r/pulls/7/ccr/comments/55/resolve"),
    ).toHaveLength(1);
    expect(graphqlCalls()).toEqual([]);
  });

  test("resolve fails, naming the comment, when no route resolves its thread", async () => {
    routes({
      GRAPHQL: { data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } },
    });
    const r = await run(["pr", "resolve", "7", "--repo", "o/r", "--comment", "55"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("comment 55");
  });

  test("report posts with the footer; one that needs the user turns the PR into a draft, through GraphQL locally", async () => {
    routes({
      "POST repos/o/r/issues/7/comments": { id: 1 },
      GRAPHQL: { data: { convertPullRequestToDraft: { pullRequest: { isDraft: true } } } },
      "GET repos/o/r/pulls/7": { ...pull(7), node_id: "PR_7" },
    });
    const plain = await run([
      "pr",
      "report",
      "7",
      "--repo",
      "o/r",
      "--body",
      "## Done · kept the old endpoint\n\n**Why:** x",
    ]);
    expect(plain.err).toBe("");
    expect(sent("POST", "repos/o/r/issues/7/comments")).toEqual([
      { body: `## Done · kept the old endpoint\n\n**Why:** x${FOOTER}` },
    ]);
    expect(graphqlCalls()).toEqual([]);
    const needs = await run([
      "pr",
      "report",
      "7",
      "--repo",
      "o/r",
      "--body",
      "## Handed back · the iOS layout\n\n**Needs you:** check it on a phone",
    ]);
    expect(needs.out).toContain("turned it into a draft");
    expect(graphqlCalls().find((c) => c.includes("convertPullRequestToDraft"))).toContain(
      "id=PR_7",
    );
  });

  test("a Done report, the debrief, posts with the footer and leaves the PR as it is", async () => {
    routes({
      "POST repos/o/r/issues/7/comments": { id: 1 },
      "GET repos/o/r/pulls/7": { ...pull(7), node_id: "PR_7" },
    });
    const done = await run([
      "pr",
      "report",
      "7",
      "--repo",
      "o/r",
      "--body",
      "**Done · the export skips archived rows**\n\n**Proof:** x",
    ]);
    expect(done.err).toBe("");
    expect(sent("POST", "repos/o/r/issues/7/comments")).toEqual([
      { body: `**Done · the export skips archived rows**\n\n**Proof:** x${FOOTER}` },
    ]);
    expect(graphqlCalls()).toEqual([]);
  });

  test("a Done report with a Needs you line leaves the PR as it is", async () => {
    routes({
      "POST repos/o/r/issues/7/comments": { id: 1 },
      "POST repos/o/r/pulls/7/ccr/convert_to_draft": {},
    });
    const r = await run(
      [
        "pr",
        "report",
        "7",
        "--repo",
        "o/r",
        "--body",
        "## Done · the export skips archived rows\n\n**Needs you:** nothing",
      ],
      { CLAUDE_CODE_REMOTE: "true" },
    );
    expect(r.err).toBe("");
    expect(r.out).not.toContain("draft");
    expect(
      ghCalls().filter((c) => c.args[1] === "repos/o/r/pulls/7/ccr/convert_to_draft"),
    ).toHaveLength(0);
  });

  test("report turns the PR into a draft through the ccr route in a cloud session", async () => {
    routes({
      "POST repos/o/r/issues/7/comments": { id: 1 },
      "POST repos/o/r/pulls/7/ccr/convert_to_draft": {},
    });
    const r = await run(
      [
        "pr",
        "report",
        "7",
        "--repo",
        "o/r",
        "--body",
        "## Handed back · x\n\n**Needs you:** pick one",
      ],
      { CLAUDE_CODE_REMOTE: "true" },
    );
    expect(r.err).toBe("");
    expect(
      ghCalls().filter((c) => c.args[1] === "repos/o/r/pulls/7/ccr/convert_to_draft"),
    ).toHaveLength(1);
    expect(graphqlCalls()).toEqual([]);
  });

  test("a hand-back on the pull request turns it into a draft, with or without a Needs you", async () => {
    routes({
      "POST repos/o/r/issues/7/comments": { id: 1 },
      "POST repos/o/r/pulls/7/ccr/convert_to_draft": {},
    });
    const r = await run(
      [
        "pr",
        "report",
        "7",
        "--repo",
        "o/r",
        "--body",
        "## Handed back · the reviewer disputes acceptance line 2",
      ],
      { CLAUDE_CODE_REMOTE: "true" },
    );
    expect(r.out).toContain("turned it into a draft");
    expect(
      ghCalls().filter((c) => c.args[1] === "repos/o/r/pulls/7/ccr/convert_to_draft"),
    ).toHaveLength(1);
  });

  test("report takes only a pull request's kinds of report", async () => {
    expect(
      (await run(["pr", "report", "7", "--repo", "o/r", "--body", "## Revised · x"])).err,
    ).toContain("goes on the ticket");
    expect(
      (await run(["pr", "report", "7", "--repo", "o/r", "--body", "Some thoughts"])).code,
    ).toBe(64);
    expect(ghCalls().some((c) => c.args.includes("POST"))).toBe(false);
  });

  test("reply needs a comment and a body", async () => {
    expect((await run(["pr", "reply", "7", "--repo", "o/r", "--body", "x"])).code).toBe(64);
    expect((await run(["pr", "reply", "7", "--repo", "o/r", "--comment", "55"])).code).toBe(64);
  });
});

describe("pr open", () => {
  const PR = { number: 41, html_url: "https://github.com/o/r/pull/41" };
  const opened = () => sent("POST", "repos/o/r/pulls");
  const bodyFile = (text: string) => {
    const path = join(dir, "body.md");
    writeFileSync(path, text);
    return path;
  };

  // A clone on branch feature with one commit. Its pushes land in a local bare
  // repository instead of GitHub, and its pre-push hook logs each push to the
  // fake gh's call log, so a test sees whether the push came before the pull
  // request. The hook runs even for a push with nothing to send, which the
  // bare repository never hears of.
  function branch(): string {
    const path = clone();
    const origin = join(dir, "origin.git");
    spawnSync("git", ["init", "-q", "--bare", origin]);
    const hook = join(path, ".git", "hooks", "pre-push");
    writeFileSync(
      hook,
      `#!/bin/sh\necho '{"args":["git push"],"stdin":null}' >> "${join(dir, "calls.jsonl")}"\n`,
    );
    chmodSync(hook, 0o755);
    const git = (...args: string[]) => spawnSync("git", ["-C", path, ...args]);
    git("remote", "set-url", "--push", "origin", origin);
    git("checkout", "-q", "-b", "feature");
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "Do it",
    );
    return path;
  }

  // GitHub issue 12 of a repository, as the GitHub tracker reads it.
  const issue = (repo: string) => ({
    [`GET repos/${repo}/issues/12`]: githubIssue({
      html_url: `https://github.com/${repo}/issues/12`,
    }),
    [`GET repos/${repo}/issues/12/comments`]: [],
    [`GET repos/${repo}/pulls?state=open`]: [],
  });
  const pushedOrOpened = () =>
    ghCalls().filter((c) => c.args[0] === "git push" || c.args.includes("POST"));

  beforeEach(() => {
    routes({ "GET repos/o/r": { default_branch: "trunk" }, "POST repos/o/r/pulls": PR });
    linearIssues = [
      linearIssue({ identifier: "ENG-1", description: "Repo: o/r\n\n## What to build" }),
    ];
  });

  test("without --title, exits 64 with the usage", async () => {
    const r = await run(["pr", "open", "--body", "Does it."], {}, branch());
    expect(r.code).toBe(64);
    expect(r.err).toContain("usage: houston pr open");
    expect(pushedOrOpened()).toEqual([]);
  });

  test("refuses a --ticket with no value or an empty one before it pushes or opens anything", async () => {
    const path = branch();
    for (const ticket of [["--ticket"], ["--ticket", ""]]) {
      const r = await run(
        ["pr", "open", ...ticket, "--title", "Do it", "--body", "Does it."],
        {},
        path,
      );
      expect(r.code).toBe(64);
      expect(r.err).toContain("usage: houston pr open");
    }
    expect(pushedOrOpened()).toEqual([]);
  });

  test("refuses to open from the default branch before it pushes anything", async () => {
    const path = branch();
    spawnSync("git", ["-C", path, "checkout", "-q", "-b", "trunk"]);
    const r = await run(["pr", "open", "--title", "Do it", "--body", "Does it."], {}, path);
    expect(r.code).toBe(1);
    expect(r.err).toContain("feature branch");
    expect(pushedOrOpened()).toEqual([]);
  });

  test("outside a clone, says to run inside one", async () => {
    const r = await run(["pr", "open", "--title", "Do it", "--body", "Does it."]);
    expect(r.code).toBe(64);
    expect(r.err).toBe("cannot tell which repository: run inside a clone\n");
  });

  test("without --ticket, sends the file's content unchanged, ready for review, to the default branch", async () => {
    const r = await run(
      ["pr", "open", "--title", "Do it", "--body-file", bodyFile("Does it.\n\nSee #12 for why.")],
      {},
      branch(),
    );
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(opened()).toEqual([
      {
        title: "Do it",
        head: "feature",
        base: "trunk",
        body: "Does it.\n\nSee #12 for why.",
        draft: false,
      },
    ]);
  });

  test("with --ticket, ends a body that doesn't close the ticket with its closes line", async () => {
    const r = await run(
      ["pr", "open", "--ticket", "ENG-1", "--title", "Do it", "--body", "Does it."],
      {},
      branch(),
    );
    expect(r.err).toBe("");
    expect(opened().map((p) => p.body)).toEqual(["Does it.\n\nCloses ENG-1"]);
  });

  test("with --ticket, sends a body that already closes the ticket unchanged", async () => {
    const r = await run(
      ["pr", "open", "--ticket", "eng-1", "--title", "Do it", "--body", "Does it.\n\nFixes eng-1"],
      {},
      branch(),
    );
    expect(r.err).toBe("");
    expect(opened().map((p) => p.body)).toEqual(["Does it.\n\nFixes eng-1"]);
  });

  test("with a GitHub --ticket in the same repository, ends the body with Closes #12", async () => {
    routes({ ...current(), ...issue("o/r") });
    const r = await run(
      ["pr", "open", "--ticket", "#12", "--title", "Do it", "--body", "Does it."],
      {},
      branch(),
    );
    expect(r.err).toBe("");
    expect(opened().map((p) => p.body)).toEqual(["Does it.\n\nCloses #12"]);
  });

  test("refuses a GitHub --ticket from another repository before it pushes or opens anything", async () => {
    routes({ ...current(), ...issue("other/x") });
    const r = await run(
      ["pr", "open", "--ticket", "other/x#12", "--title", "Do it", "--body", "Does it."],
      {},
      branch(),
    );
    expect(r.code).toBe(3);
    expect(r.err).toContain("other/x");
    expect(r.err).toContain("o/r");
    expect(pushedOrOpened()).toEqual([]);
  });

  test("refuses a Linear --ticket whose repository is another one before it pushes or opens anything", async () => {
    linearIssues = [linearIssue({ identifier: "ENG-1" })];
    const r = await run(
      ["pr", "open", "--ticket", "ENG-1", "--title", "Do it", "--body", "Does it."],
      {},
      branch(),
    );
    expect(r.code).toBe(3);
    expect(r.err).toContain("andrezzoid/app");
    expect(r.err).toContain("o/r");
    expect(pushedOrOpened()).toEqual([]);
  });

  test("pushes a branch the remote lacks before it opens the pull request", async () => {
    const r = await run(["pr", "open", "--title", "Do it", "--body", "Does it."], {}, branch());
    expect(r.err).toBe("");
    const steps = ghCalls()
      .map((c) => c.args.join(" "))
      .filter((s) => s === "git push" || s.includes("--method POST"));
    expect(steps).toEqual(["git push", "api repos/o/r/pulls --method POST --input -"]);
  });

  test("doesn't push a branch the remote already holds", async () => {
    const path = branch();
    spawnSync("git", ["-C", path, "push", "-q", "-u", "origin", "feature"]);
    rmSync(join(dir, "calls.jsonl"));
    const r = await run(["pr", "open", "--title", "Do it", "--body", "Does it."], {}, path);
    expect(r.err).toBe("");
    expect(opened()).toHaveLength(1);
    expect(ghCalls().filter((c) => c.args[0] === "git push")).toEqual([]);
  });

  test("pushes a branch the remote deleted, though the clone still tracks it at its last commit", async () => {
    const path = branch();
    spawnSync("git", ["-C", path, "push", "-q", "-u", "origin", "feature"]);
    spawnSync("git", ["-C", join(dir, "origin.git"), "update-ref", "-d", "refs/heads/feature"]);
    rmSync(join(dir, "calls.jsonl"));
    const r = await run(["pr", "open", "--title", "Do it", "--body", "Does it."], {}, path);
    expect(r.err).toBe("");
    expect(ghCalls().filter((c) => c.args[0] === "git push")).toHaveLength(1);
    expect(opened()).toHaveLength(1);
  });

  test("pushes a branch whose name looks like an option", async () => {
    const path = branch();
    spawnSync("git", ["-C", path, "branch", "-m", "feature", "tmp"]);
    spawnSync("git", ["-C", path, "update-ref", "refs/heads/--dry-run", "HEAD"]);
    spawnSync("git", ["-C", path, "symbolic-ref", "HEAD", "refs/heads/--dry-run"]);
    const r = await run(["pr", "open", "--title", "Do it", "--body", "Does it."], {}, path);
    expect(r.err).toBe("");
    expect(
      spawnSync("git", ["-C", join(dir, "origin.git"), "for-each-ref", "--format=%(refname)"], {
        encoding: "utf8",
      }).stdout,
    ).toBe("refs/heads/--dry-run\n");
    expect(opened().map((p) => p.head)).toEqual(["--dry-run"]);
  });

  test("prints the pull request's number and URL once it opens", async () => {
    const r = await run(["pr", "open", "--title", "Do it", "--body", "Does it."], {}, branch());
    expect(r.out).toBe("opened #41 https://github.com/o/r/pull/41\n");
  });

  test("a ticket that can't be read fails the command before it pushes or opens anything", async () => {
    const r = await run(
      ["pr", "open", "--ticket", "ENG-404", "--title", "Do it", "--body", "Does it."],
      {},
      branch(),
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain("ENG-404");
    expect(pushedOrOpened()).toEqual([]);
  });
});

describe("Linear tickets", () => {
  const file = (name: string, text: string) => {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  };

  test("next lists ready tickets and says why the rest wait", async () => {
    linearIssues.push(
      linearIssue({
        id: "u2",
        identifier: "ENG-2",
        inverseRelations: {
          nodes: [{ type: "blocks", issue: { identifier: "ENG-1", state: { type: "unstarted" } } }],
        },
      }),
      linearIssue({ id: "u3", identifier: "ENG-3", labels: ["ready-for-agent", "in-progress"] }),
      linearIssue({ id: "u4", identifier: "ENG-4", labels: ["needs-triage"] }),
    );
    const r = await run(["mission", "next", "--json"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const d = JSON.parse(r.out);
    expect(d.ready.map((t: any) => t.id)).toEqual(["ENG-1"]);
    expect(d.ready[0]).toMatchObject({
      tracker: "linear",
      repo: "andrezzoid/app",
      closes: "Closes ENG-1",
    });
    expect(d.skipped).toEqual([
      { id: "ENG-2", reason: "blocked by ENG-1" },
      { id: "ENG-3", reason: "claimed (in-progress)" },
    ]);
  });

  test("next takes the repo from triage's latest agent brief when the description names none", async () => {
    linearIssues = [
      linearIssue({
        description: "The reporter's words, with no repo line.",
        briefs: {
          nodes: [
            {
              id: "b1",
              body: "## Agent Brief\n\nRepo: andrezzoid/old",
              createdAt: "2026-10-02T00:00:00Z",
            },
            {
              id: "b2",
              body: "## Agent Brief\n\nRepo: andrezzoid/app",
              createdAt: "2026-10-03T00:00:00Z",
            },
          ],
        },
      }),
    ];
    const r = await run(["mission", "next", "--json"]);
    expect(r.err).toBe("");
    expect(JSON.parse(r.out).ready.map((t: any) => [t.id, t.repo])).toEqual([
      ["ENG-1", "andrezzoid/app"],
    ]);
  });

  test("next pages through every open ticket", async () => {
    pageSize = 1;
    linearIssues.push(linearIssue({ id: "u2", identifier: "ENG-2" }));
    const r = await run(["mission", "next", "--json"]);
    expect(JSON.parse(r.out).ready.map((t: any) => t.id)).toEqual(["ENG-1", "ENG-2"]);
    expect(ops("HoustonOpen")).toHaveLength(2);
  });

  test("sends the personal key as is, and no key when the cloud proxy injects it", async () => {
    await run(["mission", "show", "ENG-1"]);
    expect(linearCalls.map((c) => c.auth)).toEqual(["lin_api_test"]);
    linearCalls = [];
    const r = await run(["mission", "show", "ENG-1"], { LINEAR_API_KEY: "proxy-injected" });
    expect(r.code).toBe(0);
    expect(linearCalls.map((c) => c.auth)).toEqual([undefined]);
  });

  test("with no LINEAR_API_KEY, asks the linear CLI for its token once per command", async () => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const linear = join(bin, "linear");
    writeFileSync(
      linear,
      `#!/bin/sh\necho "$@" >> "${join(dir, "linear-calls")}"\necho lin_api_from_cli\n`,
    );
    chmodSync(linear, 0o755);
    const env = { LINEAR_API_KEY: "", PATH: `${bin}:${process.env.PATH}` };
    expect((await run(["mission", "claim", "ENG-1"], env)).code).toBe(0);
    expect((await run(["inbox"], env)).code).toBe(0);
    expect(linearCalls.every((c) => c.auth === "lin_api_from_cli")).toBe(true);
    expect(readFileSync(join(dir, "linear-calls"), "utf8")).toBe("auth token\nauth token\n");
  });

  test("claim labels it in-progress, assigns, starts it and logs the local session", async () => {
    const r = await run(["mission", "claim", "eng-1"], { CLAUDE_CODE_SESSION_ID: "sess-1" });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(ops("HoustonAddLabel")).toEqual([{ id: "uuid-1", labelId: "lbl-in-progress" }]);
    expect(ops("HoustonUpdate")[0].input).toEqual({ assigneeId: "me", stateId: "s-doing" });
    expect(issueComments[0].body).toMatch(/^Claimed by local session sess-1 on .+\.$/);
  });

  test("a cloud session's claim links the session", async () => {
    await run(["mission", "claim", "ENG-1"], { CLAUDE_CODE_REMOTE_SESSION_ID: "cse_abc" });
    expect(issueComments[0].body).toBe(
      "Claimed by [a cloud session](https://claude.ai/code/session_abc).",
    );
  });

  test("a claimed ticket refuses another session; --take-over replaces the claim and names it", async () => {
    linearIssues = [
      linearIssue({ identifier: "ENG-1", labels: ["ready-for-agent", "in-progress"] }),
    ];
    issueComments.push({
      id: "theirs",
      body: claimLog("[a cloud session](https://claude.ai/code/session_x)", null),
      createdAt: "2026-09-01T10:00:00Z",
    });
    const refused = await run(["mission", "claim", "ENG-1"]);
    expect(refused.code).toBe(3);
    expect(refused.err).toContain(
      "claimed by [a cloud session](https://claude.ai/code/session_x), claimed 2026-09-01 10:00",
    );
    expect(refused.err).toContain("--take-over");
    expect(ops("HoustonComment")).toEqual([]);
    expect((await run(["mission", "claim", "--take-over", "ENG-1"])).code).toBe(0);
    expect(issueComments.at(-1).body).toContain(
      "Takes over from [a cloud session](https://claude.ai/code/session_x), claimed 2026-09-01 10:00.",
    );
    expect(ops("HoustonAddLabel")).toEqual([]);
  });

  test("the session that holds the claim may claim again", async () => {
    linearIssues = [
      linearIssue({ identifier: "ENG-1", labels: ["ready-for-agent", "in-progress"] }),
    ];
    issueComments.push({
      id: "own",
      body: claimLog("[a cloud session](https://claude.ai/code/session_abc)", null),
      createdAt: hoursAgo(1),
    });
    const r = await run(["mission", "claim", "ENG-1"], {
      CLAUDE_CODE_REMOTE_SESSION_ID: "cse_abc",
    });
    expect(r.code).toBe(0);
    expect(ops("HoustonComment")).toEqual([]);
  });

  test("claim refuses a ticket that is not ready-for-agent", async () => {
    linearIssues = [linearIssue({ identifier: "ENG-1", labels: ["needs-info"] })];
    const r = await run(["mission", "claim", "ENG-1"]);
    expect(r.code).toBe(3);
    expect(r.err).toContain("no ready-for-agent label");
  });

  test("claim refuses a ticket with an open blocker or open children", async () => {
    linearIssues = [
      linearIssue({
        identifier: "ENG-1",
        inverseRelations: {
          nodes: [{ type: "blocks", issue: { identifier: "ENG-0", state: { type: "started" } } }],
        },
      }),
    ];
    const blocked = await run(["mission", "claim", "ENG-1"]);
    expect(blocked.code).toBe(3);
    expect(blocked.err).toContain("blocked by ENG-0");
    linearIssues = [
      linearIssue({
        identifier: "ENG-1",
        children: { nodes: [{ identifier: "ENG-2", state: { type: "unstarted" } }] },
      }),
    ];
    expect((await run(["mission", "claim", "ENG-1"])).err).toContain("parent of 1 open ticket(s)");
    expect([...ops("HoustonAddLabel"), ...ops("HoustonComment")]).toEqual([]);
  });

  test("claim refuses what mission next refuses: a colleague's ticket, or one with no repository", async () => {
    linearIssues = [
      linearIssue({ identifier: "ENG-1", assignee: { id: "r", name: "Rita", isMe: false } }),
    ];
    const theirs = await run(["mission", "claim", "ENG-1"]);
    expect(theirs.code).toBe(3);
    expect(theirs.err).toContain("assigned to Rita");
    linearIssues = [linearIssue({ identifier: "ENG-1", description: "No repo line." })];
    const nowhere = await run(["mission", "claim", "ENG-1"]);
    expect(nowhere.code).toBe(3);
    expect(nowhere.err).toContain("no repository");
    expect([...ops("HoustonUpdate"), ...ops("HoustonAddLabel"), ...ops("HoustonComment")]).toEqual(
      [],
    );
  });

  test("claim fails before writing anything when Linear has no in-progress label", async () => {
    missingLabels = ["in-progress"];
    const r = await run(["mission", "claim", "ENG-1"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("no in-progress label exists in Linear");
    expect([...ops("HoustonUpdate"), ...ops("HoustonAddLabel"), ...ops("HoustonComment")]).toEqual(
      [],
    );
  });

  test("problem posts the report, swaps the labels and moves the ticket back", async () => {
    linearIssues = [
      linearIssue({ identifier: "ENG-1", labels: ["ready-for-agent", "in-progress"] }),
    ];
    const report = file(
      "report.md",
      "## Handed back · acceptance line 2 cannot hold\n\n**Expected:** x",
    );
    const r = await run(["mission", "problem", "ENG-1", "--body-file", report]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(ops("HoustonComment")[0].body).toContain(
      "## Handed back · acceptance line 2 cannot hold",
    );
    expect(ops("HoustonRemoveLabel").map((v) => v.labelId)).toEqual(["lbl-0", "lbl-1"]);
    expect(ops("HoustonAddLabel")).toEqual([{ id: "uuid-1", labelId: "lbl-ready-for-human" }]);
    expect(ops("HoustonUpdate")[0].input).toEqual({ stateId: "s-todo" });
  });

  test("problem and revise post only a report of their own kind", async () => {
    const wrong = file("wrong.md", "## Revised · drop the export");
    expect((await run(["mission", "problem", "ENG-1", "--body-file", wrong])).code).toBe(64);
    expect(
      (await run(["mission", "revise", "ENG-1", "--body", "Revised the plan, see thread"])).code,
    ).toBe(64);
    expect(ops("HoustonComment")).toEqual([]);
  });

  test("revise posts a revision that mission show reads into the plan", async () => {
    const revision = file(
      "revision.md",
      "## Revised · drop the CSV export\n\n**Expected:** no CSV button",
    );
    const r = await run(["mission", "revise", "ENG-1", "--body-file", revision]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const d = JSON.parse((await run(["mission", "show", "ENG-1", "--json"])).out);
    expect(d.plan.map((p: any) => p.kind)).toEqual(["body", "revised"]);
    expect(d.plan[1].text).toContain("drop the CSV export");
  });

  test("new files an unlabelled follow-up in the ticket's team, linked back to it", async () => {
    const r = await run([
      "mission",
      "followup",
      "--from",
      "ENG-1",
      "--title",
      "Drop the dead flag",
      "--body",
      "No caller reads it.",
    ]);
    expect(r.err).toBe("");
    expect(r.out).toContain("filed ENG-50, a follow-up of ENG-1");
    expect(ops("HoustonCreate")).toEqual([
      {
        input: {
          teamId: "team-1",
          title: "Drop the dead flag",
          description: "No caller reads it.\n\nFollow-up of ENG-1.",
        },
      },
    ]);
    expect((await run(["mission", "followup", "--from", "ENG-1", "--body", "x"])).code).toBe(64);
  });

  test("show names the phase, the open pull requests and the claim", async () => {
    linearIssues = [
      linearIssue({ identifier: "ENG-1", labels: ["ready-for-agent", "in-progress"] }),
    ];
    issueComments.push({
      id: "c",
      body: claimLog("local session s1 on mac", null),
      createdAt: hoursAgo(1),
    });
    const d = JSON.parse((await run(["mission", "show", "ENG-1", "--json"])).out);
    expect(d).toMatchObject({
      phase: "iterate",
      openPrs: [],
      claimedBy: "local session s1 on mac",
    });
    expect(d.comments.map((c: any) => c.body)).toEqual(["Claimed by local session s1 on mac."]);
  });
});

describe("GitHub Issues tickets", () => {
  const gh = { HOUSTON_GITHUB_REPOS: "O/R", LINEAR_API_KEY: "" };
  const agentSkills = (tracker: string) => ({
    encoding: "base64",
    content: Buffer.from(`# R\n\n## Agent skills\n\nTracker: ${tracker}\n`).toString("base64"),
  });

  beforeEach(() => {
    linearIssues = [];
    routes({
      "GET repos/o/r/issues?state=open": [
        githubIssue({ number: 12 }),
        githubIssue({ number: 13, title: "Second", body: "Blocked by: #12" }),
        { ...githubIssue({ number: 14 }), pull_request: { url: "x" } },
        githubIssue({ number: 15, title: "Parent" }),
        githubIssue({
          number: 16,
          title: "A bug nobody triaged into Houston",
          labels: ["bug"],
        }),
      ],
      "GET repos/o/r/pulls?state=open": [],
      "GET repos/o/r/issues/12/dependencies/blocked_by": [],
      "GET repos/o/r/issues/12/sub_issues": [],
      "GET repos/o/r/issues/13/sub_issues": [{ number: 20, state: "closed" }],
      "GET repos/o/r/issues/15/sub_issues": [
        { number: 21, state: "open" },
        { number: 22, state: "closed" },
      ],
      "GET repos/o/r/issues/12": githubIssue({ number: 12 }),
      "GET repos/o/r/issues/12/comments": [],
      "POST repos/o/r/issues/12/comments": "$append",
      "POST repos/o/r/issues/12/assignees": {},
      "POST repos/o/r/issues/12/labels": [],
      "DELETE repos/o/r/issues/12/labels/ready-for-agent": [],
      "DELETE repos/o/r/issues/12/labels/in-progress": [],
    });
  });

  test("next reads the repos in HOUSTON_GITHUB_REPOS and honours Blocked by lines", async () => {
    const r = await run(["mission", "next", "--json"], gh);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const d = JSON.parse(r.out);
    expect(d.ready.map((t: any) => t.id)).toEqual(["o/r#12"]);
    expect(d.ready[0]).toMatchObject({
      tracker: "github",
      repo: "o/r",
      status: "queued",
      branchName: "issue-12-app-do-the-thing",
      closes: "Closes #12",
    });
    expect(d.skipped).toEqual([
      { id: "o/r#13", reason: "blocked by o/r#12" },
      { id: "o/r#15", reason: "parent of 1 open ticket(s)" },
    ]);
  });

  test("an issue a reporter labelled bug is still new until triage gives it a state", async () => {
    const d = JSON.parse((await run(["inbox", "--human", "--json"], gh)).out);
    expect(d.human.map((i: any) => [i.id, i.why])).toEqual([["o/r#16", "new, needs triage"]]);
  });

  test("a repo whose CLAUDE.md names GitHub Issues joins without HOUSTON_GITHUB_REPOS", async () => {
    // From a clone of another repo, so --repo o/r reads o/r's default branch.
    const path = clone();
    spawnSync("git", ["-C", path, "remote", "set-url", "origin", "https://github.com/p/q.git"]);
    routes({ ...current(), "GET repos/o/r/contents/CLAUDE.md": agentSkills("GitHub Issues") });
    const r = await run(
      ["mission", "next", "--repo", "o/r", "--json"],
      { LINEAR_API_KEY: "" },
      path,
    );
    expect(r.err).toBe("");
    expect(JSON.parse(r.out).ready.map((t: any) => t.id)).toEqual(["o/r#12"]);
  });

  test("inside a clone whose AGENTS.md names GitHub Issues, preflight and inbox use its issues", async () => {
    const path = clone();
    writeFileSync(join(path, "AGENTS.md"), "# R\n\n## Agent skills\n\nTracker: GitHub Issues\n");
    const env = { LINEAR_API_KEY: "", HOUSTON_GITHUB_REPOS: "" };
    const preflight = await run(["preflight"], env, path);
    expect(preflight.out).toContain("issues in o/r as andrezzoid");
    expect(preflight.out).toContain("AGENTS.md names github");
    const inbox = await run(["inbox", "--agent", "--json"], env, path);
    expect(inbox.err).toBe("");
    expect(JSON.parse(inbox.out)).toEqual({
      agent: [
        {
          id: "o/r#12",
          title: "App: do the thing",
          url: "https://github.com/o/r/issues/12",
          repo: "o/r",
          why: "ready to build",
        },
      ],
    });
  });

  test("inside a clone, inbox follows the branch's CLAUDE.md, not the default branch's", async () => {
    const path = clone();
    writeFileSync(join(path, "CLAUDE.md"), "# R\n\n## Agent skills\n\nTracker: GitHub Issues\n");
    routes({
      ...current(),
      "GET repos/o/r/contents/CLAUDE.md": {
        encoding: "base64",
        content: Buffer.from("# R\n\n## Gates\n").toString("base64"),
      },
    });
    const inbox = await run(["inbox", "--agent", "--json"], { LINEAR_API_KEY: "" }, path);
    expect(inbox.err).toBe("");
    expect(JSON.parse(inbox.out).agent.map((i: any) => i.id)).toEqual(["o/r#12"]);
  });

  test("preflight counts a skill linked into the clone's own .claude/skills as installed", async () => {
    const path = clone();
    mkdirSync(join(path, ".claude"), { recursive: true });
    symlinkSync(join(import.meta.dirname, "..", ".."), join(path, ".claude", "skills"));
    routes(current());
    const home = mkdtempSync(join(tmpdir(), "home-"));
    const preflight = await run(
      ["preflight"],
      { HOME: home, LINEAR_API_KEY: "", HOUSTON_GITHUB_REPOS: "" },
      path,
    );
    expect(preflight.out).not.toContain("missing in");
  });

  test("claim assigns the viewer, labels it in-progress and logs the session", async () => {
    const r = await run(["mission", "claim", "#12", "--repo", "o/r"], gh);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(sent("POST", "repos/o/r/issues/12/assignees")).toEqual([{ assignees: ["andrezzoid"] }]);
    expect(sent("POST", "repos/o/r/issues/12/labels")).toEqual([{ labels: ["in-progress"] }]);
    expect(sent("POST", "repos/o/r/issues/12/comments")[0].body).toMatch(
      /^Claimed by a local session on .+\.$/,
    );
  });

  test("claim leaves the assignee of a ticket assigned to the viewer", async () => {
    routes({
      ...current(),
      "GET repos/o/r/issues/12": githubIssue({ number: 12, assignees: [{ login: "andrezzoid" }] }),
    });
    expect((await run(["mission", "claim", "o/r#12"], gh)).code).toBe(0);
    expect(sent("POST", "repos/o/r/issues/12/assignees")).toEqual([]);
    expect(sent("POST", "repos/o/r/issues/12/labels")).toEqual([{ labels: ["in-progress"] }]);
  });

  test("claim refuses a colleague's ticket, as mission next does", async () => {
    routes({
      ...current(),
      "GET repos/o/r/issues/12": githubIssue({ number: 12, assignees: [{ login: "rita" }] }),
    });
    const r = await run(["mission", "claim", "o/r#12"], gh);
    expect(r.code).toBe(3);
    expect(r.err).toContain("assigned to rita");
    expect(ghCalls().some((c) => c.args.includes("POST"))).toBe(false);
  });

  test("--repo takes a remote URL or any case, for tickets as for pull requests", async () => {
    const r = await run(
      ["mission", "show", "#12", "--repo", "https://github.com/O/R.git", "--json"],
      gh,
    );
    expect(r.err).toBe("");
    expect(JSON.parse(r.out).id).toBe("o/r#12");
    const pr = await run(
      ["mission", "show", "#12", "--repo", "https://github.com/o/r/pull/5", "--json"],
      gh,
    );
    expect(JSON.parse(pr.out).id).toBe("o/r#12");
  });

  test("show is in babysit while a pull request from its branch is open", async () => {
    routes({
      ...current(),
      "GET repos/o/r/pulls?head=o:issue-12-app-do-the-thing&state=open": [
        { number: 7, html_url: "https://github.com/o/r/pull/7" },
      ],
    });
    const d = JSON.parse((await run(["mission", "show", "o/r#12", "--json"], gh)).out);
    expect(d.phase).toBe("babysit");
    expect(d.openPrs).toEqual(["https://github.com/o/r/pull/7"]);
  });

  test("show is in babysit while a pull request that closes the issue is open, whatever its branch", async () => {
    routes({
      ...current(),
      "GET repos/o/r/pulls?state=open": [
        pull(8, { body: "Closes #12", head: { sha: SHA, ref: "fix-the-thing" } }),
      ],
      "GET repos/o/r/pulls/8": pull(8),
    });
    const d = JSON.parse((await run(["mission", "show", "o/r#12", "--json"], gh)).out);
    expect(d.phase).toBe("babysit");
    expect(d.openPrs).toEqual(["https://github.com/o/r/pull/8"]);
  });

  test("show finds a pull request that closes the issue on any closing line, in any form closedBy reads", async () => {
    routes({
      ...current(),
      "GET repos/o/r/pulls?state=open": [
        pull(8, { body: "Closes #3\nFixes: #12", head: { sha: SHA, ref: "a" } }),
        pull(9, { body: "Resolves O/R#12", head: { sha: SHA, ref: "b" } }),
        pull(10, { body: "Closes https://github.com/o/r/issues/12", head: { sha: SHA, ref: "c" } }),
      ],
      "GET repos/o/r/pulls/8": pull(8),
      "GET repos/o/r/pulls/9": pull(9),
      "GET repos/o/r/pulls/10": pull(10),
    });
    const d = JSON.parse((await run(["mission", "show", "o/r#12", "--json"], gh)).out);
    expect(d.openPrs).toEqual([
      "https://github.com/o/r/pull/8",
      "https://github.com/o/r/pull/9",
      "https://github.com/o/r/pull/10",
    ]);
  });

  test("inbox reads a handed-back issue's comments without fetching the issue again", async () => {
    routes({
      ...current(),
      "GET repos/o/r/issues?state=open": [
        githubIssue({ number: 17, title: "Bounced", labels: ["ready-for-human"] }),
      ],
      "GET repos/o/r/issues/17": githubIssue({
        number: 17,
        title: "Bounced",
        labels: ["ready-for-human"],
      }),
      "GET repos/o/r/issues/17/comments": [
        { id: 1, body: "## Handed back · line 2 cannot hold", created_at: hoursAgo(1) },
      ],
    });
    const r = await run(["inbox", "--human", "--json"], gh);
    expect(r.err).toBe("");
    expect(JSON.parse(r.out).human.map((i: any) => [i.id, i.why])).toEqual([
      ["o/r#17", "waiting on your decision: Handed back · line 2 cannot hold"],
    ]);
    expect(ghCalls().filter((c) => c.args[1] === "repos/o/r/issues/17")).toEqual([]);
  });

  test("a tracker that fails is named on stderr, and every command goes on with the others", async () => {
    linearDown = "Account disabled";
    routes({
      ...current(),
      "GET repos/o/r/issues": [],
      "GET repos/o/r/pulls?state=closed&sort=updated&direction=desc": [],
    });
    const env = { HOUSTON_GITHUB_REPOS: "O/R" };
    const next = await run(["mission", "next", "--json"], env);
    expect(next.code).toBe(0);
    expect(next.err).toContain("Linear: Account disabled");
    expect(JSON.parse(next.out).ready.map((t: any) => t.id)).toEqual(["o/r#12"]);
    const inbox = await run(["inbox", "--human", "--json"], env);
    expect(inbox.code).toBe(0);
    expect(JSON.parse(inbox.out).human.map((i: any) => i.id)).toEqual(["o/r#16"]);
    const stats = await run(["stats", "--json"], env);
    expect(stats.code).toBe(0);
    expect(stats.err.match(/skipped linear/g)).toHaveLength(1);
    const preflight = await run(["preflight"], env);
    expect(preflight.out).toMatch(/^warn\s+linear\s+Linear: Account disabled$/m);
    expect(preflight.out).toMatch(/^ok\s+github\s/m);
  });

  test("a command fails when every tracker fails", async () => {
    linearDown = "Account disabled";
    const r = await run(["inbox"], { HOUSTON_GITHUB_REPOS: "" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("Linear: Account disabled");
    expect((await run(["preflight"])).out).toMatch(/^fail\s+linear\s+Linear: Account disabled$/m);
  });

  test("problem posts the report, takes off ready-for-agent and in-progress, and labels it ready-for-human", async () => {
    const report = join(dir, "report.md");
    writeFileSync(report, "**Handed back · acceptance line 2 cannot hold**");
    const r = await run(["mission", "problem", "#12", "--repo", "o/r", "--body-file", report], gh);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(
      ghCalls()
        .filter((c) => c.args.includes("DELETE"))
        .map((c) => c.args[1]),
    ).toEqual([
      "repos/o/r/issues/12/labels/ready-for-agent",
      "repos/o/r/issues/12/labels/in-progress",
    ]);
    expect(sent("POST", "repos/o/r/issues/12/labels")).toEqual([{ labels: ["ready-for-human"] }]);
    expect(sent("POST", "repos/o/r/issues/12/comments")[0].body).toBe(
      "**Handed back · acceptance line 2 cannot hold**",
    );
  });

  test("new files the follow-up in the ticket's repository", async () => {
    routes({ ...current(), "POST repos/o/r/issues": { number: 31 } });
    const r = await run(
      [
        "mission",
        "followup",
        "--from",
        "o/r#12",
        "--title",
        "Drop the dead flag",
        "--body",
        "No caller reads it.",
      ],
      gh,
    );
    expect(r.err).toBe("");
    expect(r.out).toContain("filed o/r#31, a follow-up of o/r#12");
    expect(sent("POST", "repos/o/r/issues")).toEqual([
      { title: "Drop the dead flag", body: "No caller reads it.\n\nFollow-up of o/r#12." },
    ]);
  });

  test("next --launch starts a background session per ready ticket of this clone", async () => {
    const claude = join(dir, "claude");
    writeFileSync(
      claude,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(dir, "claude-args")}"\necho "started abc123"\n`,
    );
    chmodSync(claude, 0o755);
    routes({
      ...current(),
      "GET repos/o/r/issues?state=open": [
        githubIssue({ number: 12 }),
        githubIssue({ number: 17, title: "Later", created_at: "2026-10-05T00:00:00Z" }),
      ],
      "GET repos/o/r/issues/17/sub_issues": [],
    });
    const r = await run(
      ["mission", "next", "--launch", "--max", "1"],
      { ...gh, HOUSTON_CLAUDE: claude },
      clone(),
    );
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toBe("launched o/r#12: started abc123\n");
    expect(readFileSync(join(dir, "claude-args"), "utf8").trim().split("\n")).toEqual([
      "--bg",
      "-n",
      "o/r#12",
      "-w",
      "o-r-12",
      "--permission-mode",
      "auto",
      "/houston o/r#12",
    ]);
  });

  test("next --launch refuses in a cloud session, which launches with create_session", async () => {
    const r = await run(
      ["mission", "next", "--launch"],
      { ...gh, CLAUDE_CODE_REMOTE: "true" },
      clone(),
    );
    expect(r.code).toBe(64);
    expect(r.err).toContain("create_session");
  });
});

describe("inbox", () => {
  const SHA8 = "d".repeat(40);
  const SHA9 = "e".repeat(40);
  const claimed = (id: string, n: number, over: Record<string, unknown> = {}) =>
    linearIssue({
      id: `u${n}`,
      identifier: id,
      title: `T${n}`,
      labels: ["ready-for-agent", "in-progress"],
      state: { name: "In Progress", type: "started" },
      ...over,
    });
  const pr = (n: number) => ({
    attachments: { nodes: [{ url: `https://github.com/o/r/pull/${n}` }] },
  });

  beforeEach(() => {
    linearIssues = [
      linearIssue({ id: "u1", identifier: "ENG-1", title: "T1" }),
      linearIssue({ id: "u2", identifier: "ENG-2", title: "T2", labels: ["needs-triage"] }),
      linearIssue({ id: "u3", identifier: "ENG-3", title: "T3", labels: [] }),
      linearIssue({ id: "u4", identifier: "ENG-4", title: "T4", labels: ["needs-info"] }),
      linearIssue({ id: "u5", identifier: "ENG-5", title: "T5", labels: ["ready-for-human"] }),
      claimed("ENG-6", 6, { updatedAt: hoursAgo(5) }),
      claimed("ENG-7", 7, pr(7)),
      claimed("ENG-8", 8, pr(8)),
      claimed("ENG-9", 9, pr(9)),
    ];
    const session = (s: string) => [{ id: "c", body: claimLog(s, null), createdAt: hoursAgo(6) }];
    commentsFor = {
      "ENG-5": [
        ...session("[a cloud session](https://claude.ai/code/session_5)"),
        { id: "r", body: "## Handed back · line 2 cannot hold", createdAt: hoursAgo(2) },
      ],
      "ENG-6": session("local session s6 on mac"),
      "ENG-7": session("local session s7 on mac"),
      "ENG-8": session("local session s8 on mac"),
      "ENG-9": session("local session s9 on mac"),
    };
    routes({
      "GET repos/o/r/pulls/8": pull(8, {
        draft: true,
        mergeable_state: "draft",
        head: { sha: SHA8, ref: "andre/eng-8" },
      }),
      "GET repos/o/r/pulls/8/reviews": [],
      "GET repos/o/r/issues/8/comments": [
        {
          id: 1,
          body: "## Handed back · kept the old endpoint\n\n**Needs you:** pick one",
          created_at: hoursAgo(1),
        },
      ],
      [`GET repos/o/r/commits/${SHA8}/check-runs`]: { check_runs: [] },
      [`GET repos/o/r/commits/${SHA8}/status`]: { statuses: [] },
      "GET repos/o/r/pulls/9": pull(9, {
        updated_at: hoursAgo(5),
        head: { sha: SHA9, ref: "andre/eng-9" },
      }),
      "GET repos/o/r/pulls/9/reviews": [],
      [`GET repos/o/r/commits/${SHA9}/check-runs`]: {
        check_runs: [{ id: 1, name: "test", status: "completed", conclusion: "failure" }],
      },
      [`GET repos/o/r/commits/${SHA9}/status`]: { statuses: [] },
    });
  });

  test("lists what needs the user and what an agent can pick up, each with its session", async () => {
    const r = await run(["inbox", "--json"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const d = JSON.parse(r.out);
    expect(d.human.map((i: any) => [i.id, i.why, i.pr ?? null, i.session ?? null])).toEqual([
      ["ENG-2", "new, needs triage", null, null],
      ["ENG-3", "new, needs triage", null, null],
      ["ENG-4", "waiting on more information", null, null],
      [
        "ENG-5",
        "waiting on your decision: Handed back · line 2 cannot hold",
        null,
        "[a cloud session](https://claude.ai/code/session_5)",
      ],
      [
        "ENG-6",
        "claimed, but no pull request and no signal for over 3h",
        null,
        "local session s6 on mac",
      ],
      ["ENG-7", "ready to merge", "https://github.com/o/r/pull/7", "local session s7 on mac"],
      [
        "ENG-8",
        "a draft pull request: Handed back · kept the old endpoint",
        "https://github.com/o/r/pull/8",
        "local session s8 on mac",
      ],
    ]);
    expect(d.agent.map((i: any) => [i.id, i.why, i.pr ?? null, i.session ?? null])).toEqual([
      [
        "ENG-9",
        "its pull request fails test, no signal for over 3h",
        "https://github.com/o/r/pull/9",
        "local session s9 on mac",
      ],
      ["ENG-1", "ready to build", null, null],
    ]);
    expect(d.agent[1].repo).toBe("andrezzoid/app");
  });

  test("--human and --agent each show one list", async () => {
    const human = await run(["inbox", "--human"]);
    expect(human.out).toContain("## Needs you");
    expect(human.out).toContain(
      "- ENG-7 T7: ready to merge · https://github.com/o/r/pull/7 · local session s7 on mac",
    );
    expect(human.out).not.toContain("## For agents");
    const agent = await run(["inbox", "--agent"]);
    expect(agent.out).toBe(
      "## For agents\n- ENG-9 T9: its pull request fails test, no signal for over 3h · https://github.com/o/r/pull/9 · local session s9 on mac\n- ENG-1 T1: ready to build\n",
    );
  });

  test("an open thread counts against a pull request that lost signal only when someone else spoke last", async () => {
    const silentPr = (n: number) =>
      pull(n, { updated_at: hoursAgo(5), head: { sha: SHA, ref: `andre/eng-${n}` } });
    linearIssues = [claimed("ENG-7", 7, pr(7)), claimed("ENG-10", 10, pr(10))];
    commentsFor = { "ENG-7": [], "ENG-10": [] };
    routes({
      "GET repos/o/r/pulls/7": silentPr(7),
      "GET repos/o/r/pulls/10": silentPr(10),
      "GET repos/o/r/pulls/7/reviews": [],
      "GET repos/o/r/pulls/10/reviews": [],
      GRAPHQL: {
        data: {
          repository: { pullRequest: { reviewThreads: { nodes: [{ isResolved: false }] } } },
        },
      },
      "GET repos/o/r/issues/7/comments": [],
      "GET repos/o/r/pulls/7/comments": [
        { created_at: hoursAgo(9), body: "Why not reuse the parser?" },
        {
          created_at: hoursAgo(6),
          body: "Asked the author.\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_",
        },
      ],
      "GET repos/o/r/issues/10/comments": [],
      "GET repos/o/r/pulls/10/comments": [
        { created_at: hoursAgo(6), body: "Why not reuse the parser?" },
      ],
    });
    const d = JSON.parse((await run(["inbox", "--agent", "--json"])).out);
    expect(d.agent.map((i: any) => [i.id, i.why])).toEqual([
      [
        "ENG-10",
        "its pull request has 1 open thread(s) waiting on an answer, no signal for over 3h",
      ],
    ]);
  });

  test("a pull request behind its base goes to an agent; one waiting on a required review goes to the user", async () => {
    linearIssues = [claimed("ENG-7", 7, pr(7)), claimed("ENG-10", 10, pr(10))];
    commentsFor = { "ENG-7": [], "ENG-10": [] };
    routes({
      "GET repos/o/r/pulls/7": pull(7, { updated_at: hoursAgo(5), mergeable_state: "behind" }),
      "GET repos/o/r/pulls/10": pull(10, {
        mergeable_state: "blocked",
        head: { sha: SHA, ref: "andre/eng-10" },
      }),
      "GET repos/o/r/pulls/7/reviews": [],
      "GET repos/o/r/pulls/10/reviews": [],
    });
    const d = JSON.parse((await run(["inbox", "--json"])).out);
    expect(d.agent.map((i: any) => [i.id, i.why])).toEqual([
      ["ENG-7", "its pull request is behind main, no signal for over 3h"],
    ]);
    expect(d.human.map((i: any) => [i.id, i.why])).toEqual([
      ["ENG-10", "its pull request waits on a required review"],
    ]);
  });

  test("a pull request broken several ways names them conflicts, behind, failing, then changes", async () => {
    linearIssues = [claimed("ENG-7", 7, pr(7))];
    commentsFor = { "ENG-7": [] };
    routes({
      "GET repos/o/r/pulls/7": pull(7, { updated_at: hoursAgo(5), mergeable_state: "behind" }),
      "GET repos/o/r/pulls/7/reviews": [],
      [`GET repos/o/r/commits/${SHA}/check-runs`]: {
        check_runs: [{ id: 1, name: "test", status: "completed", conclusion: "failure" }],
      },
    });
    const d = JSON.parse((await run(["inbox", "--json"])).out);
    expect(d.agent.map((i: any) => i.why)).toEqual([
      "its pull request is behind main, fails test, no signal for over 3h",
    ]);
  });

  test("with no tracker configured, says how to configure one", async () => {
    const r = await run(["inbox"], { LINEAR_API_KEY: "", PATH: "/nonexistent" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("HOUSTON_GITHUB_REPOS");
  });
});

describe("stats", () => {
  test("counts what got done, what went wrong and what is still open", async () => {
    doneIssues = [
      {
        ...linearIssue({ id: "u1", identifier: "ENG-1", title: "Shipped", labels: [] }),
        completedAt: hoursAgo(4),
        history: {
          nodes: [
            { createdAt: hoursAgo(30), addedLabelIds: ["lbl-ready-for-agent"] },
            { createdAt: hoursAgo(40), addedLabelIds: ["lbl-other"] },
          ],
        },
      },
      {
        ...linearIssue({ id: "u2", identifier: "ENG-2", title: "By hand", labels: [] }),
        completedAt: hoursAgo(10),
        history: { nodes: [] },
      },
    ];
    linearIssues = [
      linearIssue({
        id: "u3",
        identifier: "ENG-3",
        title: "Bounced",
        labels: ["ready-for-human"],
        createdAt: hoursAgo(240),
        updatedAt: hoursAgo(2),
      }),
      linearIssue({
        id: "u4",
        identifier: "ENG-4",
        title: "Rita's",
        labels: ["ready-for-agent"],
        assignee: { id: "r", name: "Rita", isMe: false },
      }),
    ];
    commentsFor = {
      "ENG-3": [
        { id: "h", body: "## Handed back · line 2 cannot hold", createdAt: hoursAgo(3) },
        { id: "o", body: "## Handed back · an old one", createdAt: hoursAgo(400) },
      ],
    };
    routes({
      "GET repos/andrezzoid/app/pulls?state=closed&sort=updated&direction=desc": [
        {
          number: 21,
          html_url: "https://github.com/andrezzoid/app/pull/21",
          title: "Add export",
          merged_at: hoursAgo(5),
        },
        {
          number: 22,
          html_url: "https://github.com/andrezzoid/app/pull/22",
          title: 'Revert "Add export"',
          merged_at: hoursAgo(1),
        },
        {
          number: 23,
          html_url: "https://github.com/andrezzoid/app/pull/23",
          title: "Old",
          merged_at: hoursAgo(24 * 30),
        },
        {
          number: 24,
          html_url: "https://github.com/andrezzoid/app/pull/24",
          title: "Closed unmerged",
          merged_at: null,
        },
      ],
      "GET repos/andrezzoid/app/issues/21/comments": [
        {
          id: 1,
          body: "## Handed back · kept the old endpoint\n\n**Needs you:** pick one",
          created_at: hoursAgo(6),
        },
      ],
      "GET repos/andrezzoid/app/issues/22/comments": [],
      "GET repos/andrezzoid/app/pulls/21/comments": [
        { user: { login: "claude" }, path: "src/a.ts", body: "Missing null check\n\nDetails." },
      ],
      "GET repos/andrezzoid/app/pulls/22/comments": [],
    });
    const r = await run(["stats", "--json"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const d = JSON.parse(r.out);
    expect(d.done.tickets.map((t: any) => [t.id, t.readyToDoneHours])).toEqual([
      ["ENG-1", 26],
      ["ENG-2", null],
    ]);
    expect(d.done.merged.map((p: any) => p.number)).toEqual([21, 22]);
    expect(d.wrong.handBacks.map((x: any) => [x.where, x.title])).toEqual([
      ["ENG-3", "Handed back · line 2 cannot hold"],
      ["andrezzoid/app#21", "Handed back · kept the old endpoint"],
    ]);
    expect(d.wrong.needsYou.map((x: any) => x.where)).toEqual(["andrezzoid/app#21"]);
    expect(d.wrong.reverts.map((p: any) => p.number)).toEqual([22]);
    expect(d.wrong.reviewComments).toEqual([
      { pr: "andrezzoid/app#21", author: "claude", path: "src/a.ts", text: "Missing null check" },
    ]);
    expect(d.open.map((t: any) => [t.id, t.ageDays])).toEqual([["ENG-3", 10]]);
  });

  test("reads when a GitHub issue became ready from its label events", async () => {
    routes({
      "GET repos/o/r/issues?state=open": [],
      "GET repos/o/r/pulls?state=open": [],
      "GET repos/o/r/issues": [
        githubIssue({
          number: 11,
          state: "closed",
          state_reason: "completed",
          closed_at: hoursAgo(4),
          labels: [],
        }),
      ],
      "GET repos/o/r/issues/11/events": [
        { event: "labeled", label: { name: "ready-for-agent" }, created_at: hoursAgo(30) },
      ],
      "GET repos/o/r/issues/11": githubIssue({
        number: 11,
        state: "closed",
        closed_at: hoursAgo(4),
      }),
      "GET repos/o/r/issues/11/comments": [],
      "GET repos/o/r/pulls?state=closed&sort=updated&direction=desc": [],
    });
    const r = await run(["stats", "--json", "--since", "48h"], {
      HOUSTON_GITHUB_REPOS: "o/r",
      LINEAR_API_KEY: "",
    });
    expect(r.err).toBe("");
    expect(JSON.parse(r.out).done.tickets.map((t: any) => [t.id, t.readyToDoneHours])).toEqual([
      ["o/r#11", 26],
    ]);
  });

  test("a since it cannot read is a usage error", async () => {
    expect((await run(["stats", "--since", "last week"])).code).toBe(64);
  });
});

test("a flag's value keeps every = after the first", () => {
  expect(parseArgs(["mission", "followup", "--title=Fix a=b parsing"]).flags.title).toBe(
    "Fix a=b parsing",
  );
});

// The usage lines in the help are the one list of flags: a flag they give no
// value is a switch, and leaves the next word alone.
test("a flag the help gives no value takes none, and one it gives a value takes the next word", () => {
  for (const flag of ["json", "help", "human", "agent", "here", "launch", "take-over", "resolve"])
    expect(parseArgs([`--${flag}`, "x"])).toEqual({ _: ["x"], flags: { [flag]: true } });
  for (const flag of [
    "repo",
    "since",
    "max",
    "from",
    "title",
    "body",
    "body-file",
    "comment",
    "interval",
    "ticket",
  ])
    expect(parseArgs([`--${flag}`, "x"])).toEqual({ _: [], flags: { [flag]: "x" } });
});

test("a wrong call prints its own command's usage line from the help", async () => {
  const r = await run(["mission", "revise", "ENG-1"]);
  expect(r.code).toBe(64);
  expect(r.err).toBe(
    "usage: houston mission revise <ID> [--repo o/r] (--body TEXT | --body-file F)\n",
  );
  expect((await run(["--help"])).out).toContain(
    "houston mission revise <ID> [--repo o/r] (--body TEXT | --body-file F)",
  );
});

test("unknown commands print help and exit 64", async () => {
  for (const name of ["frobnicate", "constructor", "__proto__", "tickets", "doctor"]) {
    const r = await run([name]);
    expect(r.code).toBe(64);
    expect(r.out).toContain("houston preflight");
  }
});

test("a flag that takes a value, given none, is a usage error", async () => {
  const r = await run(["pr", "watch", "7", "--repo", "o/r", "--interval"]);
  expect(r.code).toBe(64);
  expect(r.err).toBe(
    "--interval takes a value\nusage: houston pr watch [PR] [--repo o/r] [--interval 60]\n",
  );
});

test("every command that reads --repo lists it in its usage line", async () => {
  const help = (await run(["--help"])).out;
  for (const command of [
    "inbox",
    "stats",
    "mission next",
    "mission show",
    "mission claim",
    "mission followup",
    "mission revise",
    "mission problem",
    "pr status",
    "pr watch",
    "pr reply",
    "pr resolve",
    "pr report",
    "pr merge",
  ]) {
    const line = help.split("\n").find((l) => l.startsWith(`  houston ${command} `)) ?? "";
    expect(line).toContain("--repo o/r");
  }
});

test("preflight expects every skill folder next to houston", () => {
  const skills = expectedSkills(join(import.meta.dirname, "..", ".."));
  for (const s of ["houston", "implement", "grilling", "correct"]) expect(skills).toContain(s);
  expect(skills).not.toContain("rem-cli");
});
