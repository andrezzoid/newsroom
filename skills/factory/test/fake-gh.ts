#!/usr/bin/env node
// Stand-in for `gh` in tests. Routes live in $FAKE_GH_DIR/routes.json keyed by
// "METHOD path" (with its query, then without, then with a trailing number as
// :id), or "GRAPHQL". Every call is appended to calls.jsonl so
// tests can assert what was sent.
//
// The route value "$append" makes a comment thread live: a POST adds the sent
// body, with a fresh id, to the GET list at the same path.

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.FAKE_GH_DIR;
if (!dir) throw new Error("fake gh: FAKE_GH_DIR is unset");
const args = process.argv.slice(2);
const stdin = args.includes("--input") ? readFileSync(0, "utf8") : null;
appendFileSync(join(dir, "calls.jsonl"), JSON.stringify({ args, stdin }) + "\n");

const file = join(dir, "routes.json");
const routes: Record<string, any> = JSON.parse(readFileSync(file, "utf8"));
const [command, path] = args;
if (command !== "api" || !path) process.exit(2);
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const method = flag("--method") ?? "GET";

const page = /[?&]page=(\d+)/.exec(path)?.[1];
const query = path.replace(/[?&](per_page|page)=\d+/g, "").replace(/^([^?]*)&/, "$1?");
const bare = path.replace(/\?.*$/, "");
const keys =
  path === "graphql"
    ? ["GRAPHQL"]
    : [`${method} ${query}`, `${method} ${bare}`, `${method} ${bare.replace(/\/\d+$/, "/:id")}`];
const key = keys.find((k) => k in routes);

if (page && page !== "1") {
  console.log(JSON.stringify(key?.includes("check-runs") ? { check_runs: [] } : []));
  process.exit(0);
}
if (!key) {
  console.error(`HTTP 404: Not Found (${keys[0]})`);
  process.exit(1);
}

let body = routes[key];
if (body === "$append") {
  const list: any[] = (routes[`GET ${bare}`] ??= []);
  body = {
    id: 9000 + list.length,
    created_at: new Date().toISOString(),
    ...JSON.parse(stdin ?? "{}"),
  };
  list.push(body);
  writeFileSync(file, JSON.stringify(routes));
}
console.log(typeof body === "string" ? body : JSON.stringify(body));
