---
name: principle-comments-as-design
description: |
  Use comments as a design tool to capture abstractions, intent, and decisions code can't express. Use when designing a module, interface, or data structure whose intent won't be obvious from the code alone, and when the user asks to "add comments", "document this", or "explain this code".
---

# Comments as Design

Comments carry what code can't: the abstraction, the intent, the invariants, the reasoning. Their job is **precision** (units, ranges and nullability the types can't carry) and **intuition** (the mental model behind the code, so readers don't rebuild it). Every comment adds information the code doesn't hold.

Skip getters a precise name explains, throwaway scripts, and generated code: comment the generator. When a better name would say what the comment says, rename instead.

## Steps

### 1. Write the interface comment first

Before the implementation, write what the module does: what it guarantees and returns, its side effects and its edge cases. If a caller must read the code to use it, there is no abstraction. A comment that is hard to write, or full of caveats, says the design needs work: fix the design before writing code.

```typescript
/**
 * Submits an order for fulfillment.
 *
 * Validates line items against current inventory, applies pricing
 * (including promotions), and persists atomically: a partial failure
 * rolls everything back. Returns a failed Result on validation errors,
 * with user-facing messages in Result.errors. Does not throw.
 */
function submitOrder(order: Order): Result {
```

Writing it forced the decisions about atomicity, the failure mode and the caller's surface before any code, and produced a sharper name than `processOrder`.

### 2. Write for the comment's reader

Each kind of comment has its own reader and its own content:

| Type | Describes | Reader | Must contain |
| --- | --- | --- | --- |
| Interface | what, and the contract | caller | behavior, returns, side effects, edge cases |
| Implementation | why | maintainer | reasoning, tradeoffs, non-obvious choices |
| Field or variable | what it represents | reader | units, range, invariants, relationships |
| Cross-module | relationships | whoever changes the system | ordering, protocols, shared assumptions |

"Explain why, not what" fits implementation comments only: an interface comment says what. Comment at every altitude, from single lines to blocks of related lines to whole methods and files.

### 3. Document every field

Give each field its units, valid range, invariants, relationships and nullability. A name carries about five words, and the comment carries the rest. Put units in the name when you can:

```typescript
interface CacheEntry {
  /** Last access time, Unix milliseconds. Drives LRU eviction. */
  lastAccessedMs: number;
  /** Approximate memory cost in bytes. The heaviest entries go first
      when the cache exceeds its byte budget. */
  weightBytes: number;
}
```

### 4. Explain the non-obvious logic

Every magic number, surprising order, deliberate tradeoff or non-obvious algorithm gets a comment that says why. Test it by asking whether a reviewer would ask "why?"

```typescript
// 7 retries: 1s, 2s, 4s ... 64s. About 2 minutes in all, the upstream
// SLA window before they fail the request themselves.
const MAX_RETRIES = 7;
```

### 5. Document cross-module contracts

Write down protocols, ordering requirements, and where the other half of a contract lives. No single file owns these, so they go in the module a reader reaches first.

```typescript
// auth-middleware.ts
//
// Attaches a verified User to req.user from the Authorization header.
// Downstream handlers read it through req.user: see RequestContext in
// types/request.ts.
//
// Must run before any handler that calls requireAuth(). routes/index.ts
// registers routes in that order; a route registered elsewhere needs this
// middleware applied by hand.
```

### 6. Run the different-words test

A comment that uses the same words as the thing it describes adds nothing: rewrite it or delete it. When you can't describe the concept in other words, either the code explains itself and the comment goes, or the design isn't clear yet and the code or the name changes.

```typescript
/** The count of items. */
itemCount: number; // repeats the name: delete or rewrite

/** Items in the cart, including out-of-stock items not yet removed. */
itemCount: number;
```

## Names

Names are the smallest comments. A name that is hard to choose sends the same signal as a comment that is hard to write: the abstraction isn't clear yet.

- **Precision:** `lastAccessedMs` over `timestamp`, `submitOrder` over `processOrder`, `weightBytes` over `weight`.
- **Consistency:** one word per concept, not `userId` in one file and `accountId` in the next.
- **Generic names** (`data`, `info`, `process`, `manager`, `handle`) mean the author hadn't decided what the thing is. When a better name removes a comment, rename.

## Done when

- [ ] Every public interface has a comment a caller can use without reading the implementation.
- [ ] Every field documents the units, range or meaning its type can't carry.
- [ ] No comment fails the different-words test.
- [ ] Every magic number, ordering or tradeoff has a comment that says why.
- [ ] Cross-module assumptions sit in the module a reader reaches first.
- [ ] You updated every comment this change made stale.
- [ ] Every file and module in the change has comments.

## References

[references/examples.md](references/examples.md) has longer TypeScript before/after examples for each step: a rate limiter, an API client, a connection pool, config, an order model, an event pipeline and an auth flow.
