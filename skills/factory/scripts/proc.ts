// The one place the CLI starts processes.

import { spawnSync } from "node:child_process";

export type Ran = { code: number; stdout: string; stderr: string };

export function run(cmd: string, args: string[], input?: string): Ran {
  const p = spawnSync(cmd, args, { input, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (p.error) return { code: 127, stdout: "", stderr: p.error.message };
  return { code: p.status ?? 1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}

export function git(args: string[]): string | null {
  const r = run("git", args);
  return r.code === 0 ? r.stdout.trim() : null;
}
