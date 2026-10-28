// Linear prices every query before it runs it and rejects one over 10,000
// points (https://linear.app/developers/rate-limiting): a property costs 0.1,
// an object 1, and a connection multiplies the cost of its nodes by `first` or
// `last`, or by 50 when neither is given. The mock Linear in cli.spec.ts
// answers any query, so this is the only check that ours would run for real.

import assert from "node:assert/strict";
import { test } from "node:test";
import * as linear from "../scripts/trackers/linear.ts";
import { expect } from "./expect.ts";

const CAP = 10_000;

type Selection = { spread: string } | { name: string; args: string; children: Selection[] | null };

function tokens(src: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/[\s,]/.test(c)) {
      i++;
    } else if (c === "(") {
      let depth = 0;
      let j = i;
      do {
        if (src[j] === "(") depth++;
        if (src[j] === ")") depth--;
        j++;
      } while (depth > 0);
      out.push(src.slice(i, j));
      i = j;
    } else {
      const word = /^(?:\.\.\.)?[$\w]+/.exec(src.slice(i))?.[0] ?? c;
      out.push(word);
      i += word.length;
    }
  }
  return out;
}

function selections(t: string[], at: { i: number }): Selection[] {
  at.i++; // the opening brace
  const out: Selection[] = [];
  while (t[at.i] !== "}") {
    const word = t[at.i++]!;
    if (word.startsWith("...")) {
      out.push({ spread: word.slice(3) });
      continue;
    }
    let name = word;
    if (t[at.i] === ":") name = t[(at.i += 2) - 1]!; // an alias: price the field it names
    const args = t[at.i]?.startsWith("(") ? t[at.i++]! : "";
    out.push({ name, args, children: t[at.i] === "{" ? selections(t, at) : null });
  }
  at.i++;
  return out;
}

function price(sel: Selection[], fragments: Map<string, Selection[]>): number {
  let sum = 0;
  for (const s of sel) {
    if ("spread" in s) sum += price(fragments.get(s.spread) ?? [], fragments);
    else if (!s.children) sum += 0.1;
    else {
      const nodes = s.children.find((c) => "name" in c && c.name === "nodes");
      if (nodes && "name" in nodes) {
        const per = Number(/\b(?:first|last):\s*(\d+)/.exec(s.args)?.[1] ?? 50);
        sum += per * (1 + price(nodes.children ?? [], fragments)) + price(s.children.filter((c) => c !== nodes), fragments);
      } else sum += 1 + price(s.children, fragments);
    }
  }
  return sum;
}

function complexity(doc: string): number {
  const t = tokens(doc);
  const fragments = new Map<string, Selection[]>();
  let operation: Selection[] = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "fragment") {
      const at = { i: t.indexOf("{", i) };
      fragments.set(t[i + 1]!, selections(t, at));
      i = at.i - 1;
    } else if (t[i] === "query") {
      const at = { i: t.indexOf("{", i) };
      operation = selections(t, at);
      i = at.i - 1;
    }
  }
  return Math.ceil(price(operation, fragments) - 1e-9);
}

test("the calculator matches Linear's two published examples", () => {
  expect(complexity(`query { user(id: "me") { createdIssues { nodes { id title createdAt } } } }`)).toBe(66);
  expect(complexity(`query MyCreatedIssues { user(id: "me") { createdIssues(first: 10) { nodes { id title createdAt } } } }`)).toBe(14);
});

test("every Linear query fits Linear's complexity cap", () => {
  const queries = Object.entries(linear).filter(([name]) => name.endsWith("_QUERY"));
  expect(queries.length > 0).toBe(true);
  for (const [name, doc] of queries) {
    const cost = complexity(doc as string);
    assert.ok(cost <= CAP, `${name} costs ${cost} points, over Linear's ${CAP}`);
  }
});
