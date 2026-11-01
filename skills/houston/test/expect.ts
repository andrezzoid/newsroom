// The handful of matchers these tests use, over node:assert, so the suite runs
// on `node --test` with nothing installed.

import assert from "node:assert/strict";

function partial(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== "object") return Object.is(actual, expected);
  if (actual === null || typeof actual !== "object") return false;
  if (Array.isArray(expected)) {
    const want = expected as unknown[];
    return (
      Array.isArray(actual) &&
      actual.length === want.length &&
      want.every((e, i) => partial((actual as unknown[])[i], e))
    );
  }
  const has = actual as Record<string, unknown>;
  return Object.entries(expected).every(([k, e]) => partial(has[k], e));
}

// Whether a string holds a substring, or a list an item.
function contains(actual: unknown, item: unknown): boolean {
  if (typeof actual === "string") return typeof item === "string" && actual.includes(item);
  return Array.isArray(actual) && (actual as unknown[]).includes(item);
}

// What the matchers below need actual to be, checked as node:assert would.
const asString = (actual: unknown): string => {
  assert.equal(typeof actual, "string", `expected a string, got ${JSON.stringify(actual)}`);
  return actual as string;
};
const asFunction = (actual: unknown): (() => unknown) => {
  assert.equal(typeof actual, "function", "expected a function");
  return actual as () => unknown;
};

export function expect(actual: unknown) {
  return {
    toBe: (expected: unknown) => assert.equal(actual, expected),
    toEqual: (expected: unknown) => assert.deepEqual(actual, expected),
    toBeNull: () => assert.equal(actual, null),
    toContain: (item: unknown) =>
      assert.ok(
        contains(actual, item),
        `expected ${JSON.stringify(actual)} to contain ${JSON.stringify(item)}`,
      ),
    toMatch: (pattern: RegExp) => assert.match(asString(actual), pattern),
    toHaveLength: (n: number) => assert.equal((actual as { length?: unknown } | null)?.length, n),
    toThrow: (pattern?: RegExp) =>
      pattern ? assert.throws(asFunction(actual), pattern) : assert.throws(asFunction(actual)),
    toMatchObject: (expected: object) =>
      assert.ok(
        partial(actual, expected),
        `expected ${JSON.stringify(actual)} to match ${JSON.stringify(expected)}`,
      ),
    not: {
      toBe: (expected: unknown) => assert.notEqual(actual, expected),
      toContain: (item: unknown) =>
        assert.ok(
          !contains(actual, item),
          `expected ${JSON.stringify(actual)} not to contain ${JSON.stringify(item)}`,
        ),
    },
  };
}
