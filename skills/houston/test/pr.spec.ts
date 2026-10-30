import { describe, test } from "node:test";
import {
  classifyChecks,
  classifyReviews,
  fingerprint,
  mergeBlockers,
  status,
  type PrFacts,
} from "../scripts/pr.ts";
import { expect } from "./expect.ts";

const SHA = "a".repeat(40);

function facts(over: Partial<PrFacts> = {}): PrFacts {
  return {
    number: 7,
    url: "https://github.com/o/r/pull/7",
    title: "App: do the thing",
    body: "Closes ENG-12",
    state: "open",
    merged: false,
    draft: false,
    mergeable: true,
    mergeableState: "clean",
    headSha: SHA,
    headRef: "andre/eng-12-thing",
    baseRef: "main",
    updatedAt: "2026-10-01T00:00:00Z",
    checkRuns: [{ id: 1, name: "test", status: "completed", conclusion: "success" }],
    statuses: [],
    reviews: [],
    unresolvedThreads: 0,
    ...over,
  };
}

describe("status", () => {
  test("reports facts: state, conflicts, checks, reviews and threads", () => {
    expect(status(facts())).toMatchObject({
      number: 7,
      state: "open",
      draft: false,
      conflicts: false,
      mergeableState: "clean",
      checks: { failing: [], pending: [], passing: 1 },
      unresolvedThreads: 0,
    });
    expect(status(facts({ merged: true, state: "closed" })).state).toBe("merged");
    expect(status(facts({ state: "closed" })).state).toBe("closed");
  });

  test("conflicts come from mergeable or a dirty state, and stay unknown while GitHub computes them", () => {
    expect(status(facts({ mergeable: false })).conflicts).toBe(true);
    expect(status(facts({ mergeable: null, mergeableState: "dirty" })).conflicts).toBe(true);
    expect(status(facts({ mergeable: null, mergeableState: "unknown" })).conflicts).toBe(null);
  });
});

describe("mergeBlockers", () => {
  const blockers = (over: Partial<PrFacts>) =>
    mergeBlockers(status(facts(over))).map((b) => b.text);

  test("a clean, green, reviewed-clean pull request has none", () => {
    expect(blockers({})).toEqual([]);
    expect(blockers({ checkRuns: [], mergeableState: "unstable" })).toEqual([]);
  });

  test("each fact that stops a merge names itself", () => {
    expect(blockers({ merged: true, state: "closed" })).toEqual(["it is merged"]);
    // GitHub stops computing mergeability once a pull request closes.
    expect(blockers({ merged: true, state: "closed", mergeable: null })).toEqual(["it is merged"]);
    expect(blockers({ state: "closed", mergeable: null })).toEqual(["it is closed"]);
    expect(blockers({ draft: true, mergeableState: "draft" })).toEqual(["it is a draft"]);
    expect(blockers({ mergeable: false, mergeableState: "dirty" })).toEqual([
      "it conflicts with main",
    ]);
    expect(blockers({ mergeable: null, mergeableState: "unknown" })).toEqual([
      "GitHub is still computing whether it conflicts",
    ]);
    expect(
      blockers({
        checkRuns: [{ id: 1, name: "lint", status: "completed", conclusion: "failure" }],
      }),
    ).toEqual(["failing: lint"]);
    expect(
      blockers({ checkRuns: [{ id: 1, name: "e2e", status: "in_progress", conclusion: null }] }),
    ).toEqual(["pending: e2e"]);
    expect(blockers({ reviews: [{ user: { login: "kim" }, state: "CHANGES_REQUESTED" }] })).toEqual(
      ["changes requested by kim"],
    );
    expect(blockers({ unresolvedThreads: 2 })).toEqual(["2 open review thread(s)"]);
    expect(blockers({ unresolvedThreads: null })).toEqual(["review threads could not be read"]);
    expect(blockers({ mergeableState: "behind" })).toEqual(["behind main: update the branch"]);
    expect(blockers({ mergeableState: "blocked" })).toEqual([
      "branch protection blocks it: a required review or check",
    ]);
  });

  test("a failing check blocks even where branch protection requires none", () => {
    expect(
      blockers({
        mergeableState: "unstable",
        checkRuns: [{ id: 1, name: "flaky", status: "completed", conclusion: "failure" }],
      }),
    ).toEqual(["failing: flaky"]);
  });
});

test("the fingerprint changes when something an agent acts on changes", () => {
  const base = fingerprint(status(facts()));
  expect(fingerprint(status(facts({ updatedAt: "2026-10-09T00:00:00Z" })))).toBe(base);
  for (const over of [
    { draft: true },
    { unresolvedThreads: 1 },
    { mergeable: false },
    { headSha: "b".repeat(40) },
    { reviews: [{ user: { login: "kim" }, state: "CHANGES_REQUESTED" }] },
  ]) {
    expect(fingerprint(status(facts(over)))).not.toBe(base);
  }
});

describe("classifyChecks", () => {
  test("a rerun replaces the failed run of the same name", () => {
    const c = classifyChecks(
      [
        { id: 1, name: "test", status: "completed", conclusion: "failure" },
        { id: 2, name: "test", status: "completed", conclusion: "success" },
      ],
      [],
    );
    expect(c.failing).toEqual([]);
    expect(c.passing).toBe(1);
  });

  test("two workflows with a job of the same name both count", () => {
    const c = classifyChecks(
      [
        {
          id: 100,
          name: "test",
          status: "completed",
          conclusion: "failure",
          check_suite: { id: 1 },
        },
        {
          id: 101,
          name: "test",
          status: "completed",
          conclusion: "success",
          check_suite: { id: 2 },
        },
      ],
      [],
    );
    expect(c.failing).toEqual(["test"]);
  });

  test("statuses and check runs both count; neutral and skipped pass", () => {
    const c = classifyChecks(
      [
        { id: 1, name: "lint", status: "completed", conclusion: "neutral" },
        { id: 2, name: "e2e", status: "completed", conclusion: "skipped" },
        { id: 3, name: "build", status: "completed", conclusion: "timed_out" },
      ],
      [
        { context: "vercel", state: "pending" },
        { context: "ci/legacy", state: "error" },
      ],
    );
    expect(c.failing.sort()).toEqual(["build", "ci/legacy"]);
    expect(c.pending).toEqual(["vercel"]);
  });
});

describe("classifyReviews", () => {
  test("a reviewer's latest decisive review wins", () => {
    const r = classifyReviews([
      { user: { login: "kim" }, state: "CHANGES_REQUESTED" },
      { user: { login: "kim" }, state: "COMMENTED" },
      { user: { login: "kim" }, state: "APPROVED" },
    ]);
    expect(r).toEqual({ approved: true, changesRequested: [] });
  });

  test("one blocking reviewer outweighs an approval", () => {
    const r = classifyReviews([
      { user: { login: "kim" }, state: "APPROVED" },
      { user: { login: "lee" }, state: "CHANGES_REQUESTED" },
    ]);
    expect(r).toEqual({ approved: false, changesRequested: ["lee"] });
  });
});
