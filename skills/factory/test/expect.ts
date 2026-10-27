// The handful of matchers these tests use, over node:assert, so the suite runs
// on `node --test` with nothing installed.

import assert from "node:assert/strict";

function partial(actual: any, expected: any): boolean {
  if (expected === null || typeof expected !== "object") return Object.is(actual, expected);
  if (actual === null || typeof actual !== "object") return false;
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((e, i) => partial(actual[i], e));
  }
  return Object.keys(expected).every((k) => partial(actual[k], expected[k]));
}

export function expect(actual: any) {
  return {
    toBe: (expected: unknown) => assert.equal(actual, expected),
    toEqual: (expected: unknown) => assert.deepEqual(actual, expected),
    toBeNull: () => assert.equal(actual, null),
    toContain: (item: unknown) => assert.ok(actual.includes(item), `expected ${JSON.stringify(actual)} to contain ${JSON.stringify(item)}`),
    toMatch: (pattern: RegExp) => assert.match(actual, pattern),
    toHaveLength: (n: number) => assert.equal(actual.length, n),
    toThrow: (pattern?: RegExp) => (pattern ? assert.throws(actual, pattern) : assert.throws(actual)),
    toMatchObject: (expected: object) => assert.ok(partial(actual, expected), `expected ${JSON.stringify(actual)} to match ${JSON.stringify(expected)}`),
    not: {
      toBe: (expected: unknown) => assert.notEqual(actual, expected),
      toContain: (item: unknown) => assert.ok(!actual.includes(item), `expected ${JSON.stringify(actual)} not to contain ${JSON.stringify(item)}`),
    },
  };
}
