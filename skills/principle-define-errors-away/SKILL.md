---
name: principle-define-errors-away
description: Remove error conditions by redesigning the API instead of handling them. Use when designing an API's error surface, when error handling in a module is getting dense, or when the user asks to "simplify error handling" or "reduce exceptions".
---

# Define Errors Out of Existence

Exception handling is hard to test and often outgrows the happy path. Before handling an error, ask: **can I redesign this so the error can't happen?** Exceptions are part of a module's interface, so each one you remove makes the module deeper.

The signal is accumulation: try/catch blocks or guard clauses stacking up across call sites, an error type threading through many layers, the same null check in more than one place. One guard clause on its own is fine.

Keep these errors visible: resource exhaustion, invariant violations (crash loudly), external failures a caller must react to, and security violations. An external failure that a retry or a fallback inside the module recovers gets masked (strategy 2).

## Workflow

For each error condition, in this order:

1. Name the condition in one sentence: "substring called with `start` past the end of the string."
2. **Define it out of existence.** Widen the operation's contract so the input is valid. If you can, redesign and stop.
3. **Mask it.** Recover inside the module with a retry, a default or a fallback, so callers never see it. If you can, stop.
4. **Aggregate it.** Let it propagate to one handler higher up that already deals with this class of failure. If one exists, stop.
5. **Crash with context.** For an unrecoverable condition, fail with enough context to debug: an assert, a panic, a throw at the boundary.
6. Only when all four fail, write a local error path, with a comment naming the strategies you tried and why each failed.

Done when every error path you wrote names the strategy that failed, and at least one caller that does something with the error. Each remaining error is a real one: resource exhaustion, an invariant violation, an external failure a caller must react to, or a security violation.

## 1. Define out of existence

Most errors exist because someone defined the operation too narrowly. Widen the definition and the error disappears.

| Operation | Error to remove | Redefinition |
| --- | --- | --- |
| `delete(file)` | FileNotFoundError | "Ensure the file does not exist": already true, so return success |
| `substring(s, start, end)` | IndexOutOfBoundsError | Clamp to the actual bounds and return what is there |
| `getOrDefault(map, key, default)` | KeyNotFoundError | Return the default: no error case exists |
| `mkdir_p(path)` | DirectoryExistsError | "Ensure the directory exists": already true, so return success |
| `addToSet(set, item)` | DuplicateError | Adding to a set is idempotent: return |

```typescript
// Every caller must guard against RangeError, to get back what it wanted:
function substring(s: string, start: number, end: number): string {
  if (start < 0 || end > s.length || start > end) throw new RangeError("Invalid range");
  return s.slice(start, end);
}

// Callers just use it:
function substring(s: string, start: number, end: number): string {
  start = Math.max(0, start);
  end = Math.min(s.length, end);
  return start >= end ? "" : s.slice(start, end);
}
```

Express absence in the type, not with an exception. Give "might not exist" and "must exist" two methods with two contracts:

```typescript
// Returns undefined when there is no such user: absence is an answer.
function findUser(id: string): User | undefined {
  return cache.get(id);
}

// For contexts where the user must exist, such as an authenticated route.
// A missing user here is a bug, so it fails as one.
function getUser(id: string): User {
  const user = cache.get(id);
  if (!user) throw new Error(`invariant: authenticated user must exist: ${id}`);
  return user;
}
```

Validate input with a parser that returns a result, so the schema replaces the try/catch.

## 2. Mask

Handle the exception inside the module when the module can recover, or when the caller could do nothing useful with it. Centralize the defensive check once, where the module owns it, so callers carry none.

## 3. Aggregate

Let exceptions propagate to one top-level handler that treats many of them the same way, when no single caller can recover and a crash, a restart or an error response at the top is the right answer. Fewer places that handle exceptions means less complexity.

## 4. Crash with context

For invariant violations, resource exhaustion and corrupted state, fail with the context needed to debug. This is the design: a clear failure beats surviving in a partial state.

## Red flags

- A catch that returns what the success path returns for empty input.
- Sibling exceptions for "missing X", "missing Y" and "missing Z" on the same object.
- Every caller wrapping the same call in the same try/catch.
- A guard clause that throws for an input the function could handle.
- A Result or Either type whose error variant no caller inspects.

## References

- [references/examples.md](references/examples.md): longer before/after examples for an HTTP handler, a file pipeline, a cache with a fallback, and idempotent state transitions.
- `principle-deep-module-design`: fewer exceptions make a deeper interface.
