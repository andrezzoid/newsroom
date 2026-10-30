// Which tracker owns a ticket, and which trackers a run polls.
//
// Linear is on when credentials exist. GitHub Issues covers the repositories
// in FACTORY_GITHUB_REPOS (comma-separated owner/name, a cloud environment
// variable or a local export), plus any repository a command names whose
// own instructions name GitHub Issues as its tracker (see repoTracker). A new
// tracker adds an adapter here.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { currentRepo, parseRepo, readRepoFile, repoRoot } from "../forge.ts";
import { GithubTracker } from "./github.ts";
import { LinearTracker, linearTeams, linearToken } from "./linear.ts";
import {
  GITHUB_ISSUE,
  GITHUB_SHORT_ISSUE,
  githubId,
  LINEAR_KEY,
  type Tracker,
  type TrackerName,
} from "./types.ts";

const IS_SHORT = new RegExp(`^${GITHUB_SHORT_ISSUE}$`);
const IS_GITHUB = new RegExp(`^(?:${GITHUB_ISSUE}|${GITHUB_SHORT_ISSUE})$`);
const IS_LINEAR = new RegExp(`^${LINEAR_KEY}$`);

export function trackerOf(id: string): TrackerName | null {
  if (IS_GITHUB.test(id)) return "github";
  if (IS_LINEAR.test(id)) return "linear";
  return null;
}

// "#12" means issue 12 of the repository at hand.
export function normalizeId(id: string, repo: string | null): string {
  if (IS_SHORT.test(id)) {
    if (!repo)
      throw new Error(`${id} needs a repository: pass --repo owner/name or run inside a clone`);
    return githubId(id, repo);
  }
  return trackerOf(id) === "linear" ? id.toUpperCase() : id;
}

// Why an id a pull request's text seems to name is no ticket, or null when it
// may be one. A Linear key counts only while Linear is connected and has its
// team, since branch names such as fix-utf-8 look like keys too.
export async function notATicket(id: string): Promise<string | null> {
  if (trackerOf(id) !== "linear") return null;
  if (!linearToken()) return "Linear is not connected";
  const team = id.slice(0, id.lastIndexOf("-"));
  return (await linearTeams()).has(team) ? null : `Linear has no team ${team}`;
}

export function githubRepos(extra: string[] = []): string[] {
  const env = (process.env.FACTORY_GITHUB_REPOS ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  return [...new Set([...env, ...extra].map((r) => r.toLowerCase()))];
}

export function trackerFor(id: string): Tracker {
  return trackerOf(id) === "github" ? new GithubTracker([]) : new LinearTracker();
}

export function enabledTrackers(extraGithubRepos: string[] = []): Tracker[] {
  const out: Tracker[] = [];
  if (linearToken()) out.push(new LinearTracker());
  const repos = githubRepos(extraGithubRepos);
  if (repos.length) out.push(new GithubTracker(repos));
  return out;
}

// The Tracker line of the "## Agent skills" block that /factory setup writes
// into a repo's CLAUDE.md or AGENTS.md.
export function trackerLine(text: string | null): TrackerName | null {
  const block =
    /^## Agent skills[ \t]*$([\s\S]*?)(?=^#{1,2} |(?![\s\S]))/m.exec(text ?? "")?.[1] ?? "";
  const line = /^[ \t>*_-]*Tracker[*_]*\s*:(.*)$/im.exec(block)?.[1]?.toLowerCase() ?? "";
  return line.includes("github") ? "github" : line.includes("linear") ? "linear" : null;
}

// The tracker a repository names, and the file that names it: CLAUDE.md
// first, then AGENTS.md. In the clone the CLI runs in, it reads the working
// tree, so a branch that adds or changes the Tracker line routes its own runs
// before it merges. Any other repository it reads from its default branch on
// GitHub, the only copy there is. Null when neither file names a tracker.
export function repoTracker(repo: string): { file: string; tracker: TrackerName } | null {
  const r = parseRepo(repo);
  if (!r) return null;
  const root = r === currentRepo() ? repoRoot() : null;
  // In the clone, a file missing from the working tree names no tracker: the
  // default branch's copy doesn't speak for this branch.
  const read = (file: string) => {
    if (!root) return readRepoFile(r, file);
    const path = join(root, file);
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  };
  for (const file of ["CLAUDE.md", "AGENTS.md"]) {
    const tracker = trackerLine(read(file));
    if (tracker) return { file, tracker };
  }
  return null;
}
