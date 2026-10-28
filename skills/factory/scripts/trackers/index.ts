// Which tracker owns a ticket, and which trackers a run polls.
//
// Linear is on when credentials exist. GitHub Issues covers the repositories
// in FACTORY_GITHUB_REPOS (comma-separated owner/name, a cloud environment
// variable or a local export), plus any repository a command names whose
// own instructions name GitHub Issues as its tracker. A new tracker adds an
// adapter here.

import { parseRepo, readRepoFile } from "../forge.ts";
import { GithubTracker } from "./github.ts";
import { LinearTracker, linearToken } from "./linear.ts";
import type { Tracker, TrackerName } from "./types.ts";

export function trackerOf(id: string): TrackerName | null {
  if (/^[\w.-]+\/[\w.-]+#\d+$/.test(id) || /^#\d+$/.test(id)) return "github";
  if (/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(id)) return "linear";
  return null;
}

// "#12" means issue 12 of the repository at hand.
export function normalizeId(id: string, repo: string | null): string {
  if (/^#\d+$/.test(id)) {
    if (!repo)
      throw new Error(`${id} needs a repository: pass --repo owner/name or run inside a clone`);
    return `${repo.toLowerCase()}${id}`;
  }
  return trackerOf(id) === "linear" ? id.toUpperCase() : id;
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

// The tracker a repository names, read from its default branch.
export function repoTracker(repo: string): TrackerName | null {
  const r = parseRepo(repo);
  if (!r) return null;
  for (const file of ["CLAUDE.md", "AGENTS.md"]) {
    const found = trackerLine(readRepoFile(r, file));
    if (found) return found;
  }
  return null;
}
