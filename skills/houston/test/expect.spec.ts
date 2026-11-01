// The matchers fail on a value they cannot check, as node:assert does, so a
// missing value never passes an assertion by accident.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { expect } from "./expect.ts";

describe("expect", () => {
  test("not.toContain fails on a value that is neither a string nor a list", () => {
    assert.throws(() => expect(undefined).not.toContain("x"));
    assert.throws(() => expect(null).not.toContain("x"));
  });

  test("toContain fails on a value that is neither a string nor a list", () => {
    assert.throws(() => expect(undefined).toContain("x"));
  });

  test("toContain finds an item in a string as its text", () => {
    expect("PR 7 merged").toContain(7);
  });
});
