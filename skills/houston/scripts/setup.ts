// The setup behind a Claude Code session, read from its transcript: the
// harness version, model and effort it ran on, the CLAUDE.md and AGENTS.md it
// loaded and the skills it could call. Houston stamps it on each pull request
// it opens, because a cloud session's transcript goes when its container
// does, and the pull request stays. It records names and hashes only: no file
// content, and nothing from the session_context, which holds the user's email.
//
// The transcript format is internal to Claude Code and can change on any
// release, so every field is optional and an unknown line is skipped.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Setup = {
  session: string | null;
  // Where the session ran, from its entrypoint: Claude Code cloud sessions
  // start from an entrypoint beginning "remote".
  mode: "cloud" | "local";
  entrypoint: string | null;
  // Each distinct value in the order the session first used it, since a
  // session can switch model or effort midway.
  harness: string[];
  models: string[];
  effort: string[];
  // Every instruction file the session loaded, with the hash of the content
  // it loaded last.
  instructions: { path: string; sha256: string }[];
  skills: { name: string; digest: string }[];
};

// The first 12 hex digits, as git shortens a hash: enough to tell versions
// apart, short enough to read. Claude Code drops a file's final newline when
// it loads it, so the text is trimmed, and the hash matches the file's
// trimmed content at any commit.
const sha = (text: string) => createHash("sha256").update(text.trim()).digest("hex").slice(0, 12);

const home = homedir();
const tilde = (path: string) =>
  path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;

function addOnce(list: string[], value: unknown) {
  if (typeof value === "string" && value && !list.includes(value)) list.push(value);
}

type Line = {
  type?: string;
  sessionId?: string;
  entrypoint?: string;
  version?: string;
  effort?: string;
  isSidechain?: boolean;
  message?: { model?: string };
  attachment?: {
    type?: string;
    files?: { path?: string; content?: string }[];
    names?: string[];
    digests?: string[];
  };
};

export function readSetup(transcript: string): Setup {
  let session: string | null = null;
  let entrypoint: string | null = null;
  const harness: string[] = [];
  const models: string[] = [];
  const effort: string[] = [];
  const instructions = new Map<string, string>();
  const skills = new Map<string, string>();
  for (const raw of transcript.split("\n")) {
    let line: Line;
    try {
      line = JSON.parse(raw) as Line;
    } catch {
      continue;
    }
    if (typeof line !== "object" || line === null || line.isSidechain) continue;
    session ??= line.sessionId ?? null;
    entrypoint ??= line.entrypoint ?? null;
    addOnce(harness, line.version);
    if (line.type === "assistant") {
      // "<synthetic>" marks a message the harness wrote, not a model.
      if (line.message?.model !== "<synthetic>") addOnce(models, line.message?.model);
      addOnce(effort, line.effort);
    }
    const a = line.attachment;
    if (line.type !== "attachment" || !a) continue;
    if (a.type === "instructions")
      for (const f of a.files ?? [])
        if (f.path && typeof f.content === "string")
          instructions.set(tilde(f.path), sha(f.content));
    if (a.type === "skill_listing")
      (a.names ?? []).forEach((name, i) => skills.set(name, a.digests?.[i] ?? ""));
  }
  return {
    session,
    mode: entrypoint?.startsWith("remote") ? "cloud" : "local",
    entrypoint,
    harness,
    models,
    effort,
    instructions: [...instructions].map(([path, sha256]) => ({ path, sha256 })),
    skills: [...skills]
      .map(([name, digest]) => ({ name, digest }))
      .sort((x, y) => x.name.localeCompare(y.name)),
  };
}

// Where Claude Code keeps a session's transcript: one folder per project
// under its config folder, which CLAUDE_CONFIG_DIR moves.
export function transcriptOf(session: string): string | null {
  const projects = join(process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), "projects");
  if (!existsSync(projects)) return null;
  for (const project of readdirSync(projects)) {
    const path = join(projects, project, `${session}.jsonl`);
    if (existsSync(path)) return path;
  }
  return null;
}

// The setup of the session running this command, or null outside one.
export function currentSetup(): Setup | null {
  const id = process.env.CLAUDE_CODE_SESSION_ID;
  const path = id ? transcriptOf(id) : null;
  return path ? readSetup(readFileSync(path, "utf8")) : null;
}

const MARKER = "houston-setup";

// A collapsed block for a pull request body. The comment at its end carries
// the setup as JSON, for whatever reads it back from GitHub later.
export function setupBlock(s: Setup): string {
  const summary = [
    s.harness.length ? `Claude Code ${s.harness.join(", ")}` : null,
    s.models.join(", ") || null,
    s.effort.length ? `effort ${s.effort.join(", ")}` : null,
    s.mode,
  ].filter(Boolean);
  const files = s.instructions.map((f) => `- \`${f.path}\` ${f.sha256}`);
  const skills = s.skills.map((k) => `\`${k.name}\` ${k.digest}`).join(", ");
  return [
    `<details><summary>Setup · ${summary.join(" · ")}</summary>`,
    "",
    files.length ? `Instructions:\n${files.join("\n")}` : "Instructions: none loaded",
    "",
    `Skills (${s.skills.length}): ${skills || "none"}`,
    "",
    `<!-- ${MARKER} ${JSON.stringify(s)} -->`,
    "</details>",
  ].join("\n");
}

// The setup a pull request body carries, if Houston stamped one.
export function setupIn(body: string): Setup | null {
  const m = new RegExp(`<!-- ${MARKER} (\\{.*\\}) -->`).exec(body);
  if (!m?.[1]) return null;
  try {
    return JSON.parse(m[1]) as Setup;
  } catch {
    return null;
  }
}

export function describeSetup(s: Setup): string {
  const list = (v: string[]) => v.join(", ") || "unknown";
  return [
    `session       ${s.session ?? "unknown"}`,
    `mode          ${s.mode}${s.entrypoint ? ` (${s.entrypoint})` : ""}`,
    `harness       ${list(s.harness)}`,
    `model         ${list(s.models)}`,
    `effort        ${list(s.effort)}`,
    `instructions  ${s.instructions.map((f) => `${f.path} ${f.sha256}`).join("\n              ") || "none"}`,
    `skills        ${s.skills.length}: ${s.skills.map((k) => k.name).join(", ") || "none"}`,
  ].join("\n");
}
