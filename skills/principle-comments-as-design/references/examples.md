# Extended Examples: Comments as Design

Real-world before/after examples organized by principle. Each shows the anti-pattern, why it fails, and the corrected version.

## Comments-First Design in Practice

### Example: Designing a Rate Limiter

The comments-first process means writing the interface description before any implementation. Watch how the comment drives design decisions.

**Step 1: write the interface comment.**

```typescript
// rate-limiter.ts
//
// Limits request throughput per client to protect backend services
// from overload. Uses a token bucket algorithm — each client gets a
// bucket that refills at a steady rate. When the bucket is empty,
// requests are rejected until tokens refill.
//
// Distributed: backed by Redis so limits are enforced across all
// server instances, not just per-process.
//
// Usage: call allow() before processing a request. It returns
// immediately (no queuing). Callers handle rejection themselves —
// typically by returning 429.

/**
 * Creates a rate limiter backed by the given Redis client.
 *
 * @param capacity - Max burst size (tokens per bucket). Higher values
 *   tolerate short bursts; lower values enforce stricter smoothing.
 * @param refillRate - Tokens added per second. Determines sustained
 *   throughput. Example: refillRate=10 means 10 req/sec steady state.
 */
export class RateLimiter {
  constructor(redis: RedisClient, capacity: number, refillRate: number) {}

  /**
   * Checks whether a request from the given client should be allowed.
   *
   * Consumes one token from the client's bucket. Returns true if
   * a token was available, false if the bucket is empty (reject).
   * Atomic — safe to call concurrently from multiple processes.
   *
   * Does not throw on Redis errors. Falls back to allowing the
   * request (fail-open) and logs a warning. This prevents a Redis
   * outage from taking down the whole service.
   */
  allow(clientId: string): Promise<boolean> {}
}
```

**Step 2: examine the comment.** Notice what writing it forced us to decide:

- Token bucket, not sliding window (explicit algorithm choice)
- Fail-open on Redis errors (explicit resilience strategy)
- `allow()` returns boolean, doesn't queue (explicit caller contract)
- Two constructor params with clear semantics (explicit knobs)

If any of these had been hard to articulate, that would signal a design problem worth fixing before writing any implementation.

**Step 3: implement.** The comment is the spec. Implementation follows.

---

## Interface vs. Implementation Comments

### TypeScript: API Client

**DON'T: Implementation details in the interface comment**

```typescript
/**
 * Uses fetch() to make a GET request to the /users endpoint,
 * parses the JSON response, maps each object to a User instance
 * using the User.fromJSON() factory method, and returns the array.
 * Sets the Authorization header from the stored JWT token.
 */
async function getUsers(): Promise<User[]>;
```

This describes how: fetch, JSON parsing, header setting. A caller needs none of it. If the implementation switches from fetch to axios, the comment becomes a lie even though the behavior didn't change.

**DO: Abstraction in the interface, reasoning in the implementation**

```typescript
/**
 * Returns all users the current session has permission to see.
 *
 * Requires authentication — throws AuthError if no active session.
 * Results are not paginated; for large orgs (1000+ users), use
 * getUsersPageable() instead to avoid memory pressure.
 */
async function getUsers(): Promise<User[]> {
  // GET rather than POST because user lists are cached by the CDN.
  // POST would bypass the cache and hit the origin on every call.
  const response = await this.http.get("/users");
  ...
}
```

The interface comment describes what callers need: permissions, auth requirement, scaling consideration. The implementation comment explains a non-obvious technical choice (GET for cacheability).

### TypeScript: Database Connection Pool

**DON'T: Explain what the code does line by line**

```typescript
class ConnectionPool {
  getConnection(): Connection {
    // Check if there's a connection in the pool
    if (this.pool.length > 0) {
      // Get a connection from the pool
      const conn = this.pool.pop()!;
      // Return the connection
      return conn;
    }
    // If no connection available, create a new one
    return this.createConnection();
  }
}
```

Every comment restates the line below it. Deleting them all loses no information.

**DO: One higher-level comment for the whole block, interface comment for the method**

```typescript
class ConnectionPool {
  /**
   * Returns a database connection, reusing an idle one if available.
   *
   * Connections returned here must be released back via
   * releaseConnection() — they are not auto-returned. Failing to
   * release will eventually exhaust the pool and block callers.
   *
   * Thread-safe. Blocks for up to POOL_TIMEOUT_MS if all
   * connections are in use, then throws PoolExhaustedError.
   */
  getConnection(): Connection {
    // Prefer idle connections over creating new ones to keep
    // total connection count stable. New connections are expensive:
    // ~3ms for TCP + TLS handshake to the database.
    if (this.pool.length > 0) {
      return this.pool.pop()!;
    }
    return this.createConnection();
  }
}
```

The JSDoc tells callers everything: lifecycle contract, thread safety, timeout behavior. The implementation comment explains _why_ the code reuses connections (connection cost).

### TypeScript: Image Cache

**DON'T: Describe the cache without describing the contract**

```typescript
/** Image cache class. */
class ImageCache {
  /** Gets an image. */
  get(url: string): Blob | undefined { ... }

  /** Sets an image. */
  set(url: string, image: Blob): void { ... }
}
```

**DO: Describe the abstraction (eviction, memory, thread safety)**

```typescript
/**
 * In-memory cache for decoded images, keyed by source URL.
 *
 * Eviction: LRU with a configurable byte budget (default 50MB).
 * Images are evicted largest-first when the budget is exceeded.
 * The cache also monitors memory pressure and evicts aggressively
 * when the process approaches its heap limit.
 *
 * Safe for concurrent access — reads are lock-free, writes are
 * serialized internally.
 */
class ImageCache {
  /**
   * Returns the cached image for the URL, or undefined if not cached.
   * An undefined return means either the image was never cached or it
   * was evicted — callers should fetch from network in either case.
   */
  get(url: string): Blob | undefined { ... }

  /**
   * Caches an image for the given URL. If storing this image
   * would exceed the byte budget, older/larger entries are evicted
   * first. The image Blob is retained by reference — pass compressed
   * images to keep memory usage predictable.
   */
  set(url: string, image: Blob): void { ... }
}
```

---

## The Different Words Test

### Example: Config Fields

**DON'T:**

```typescript
interface AppConfig {
  /** The database URL. */
  databaseUrl: string;
  /** The port number. */
  port: number;
  /** Whether debug mode is enabled. */
  debug: boolean;
  /** The maximum number of retries. */
  maxRetries: number;
}
```

Every comment is `name → English`. Pure noise.

**DO:**

```typescript
interface AppConfig {
  /** Postgres connection string including credentials.
      Example: "postgres://user:pass@host:5432/mydb" */
  databaseUrl: string;
  /** Port the HTTP server binds to. Falls back to 3000 if
      PORT env var is unset. Must be >1024 in non-root mode. */
  port: number;
  /** Enables verbose logging, stack traces in error responses,
      and the /debug endpoints. Never enable in production. */
  debug: boolean;
  /** Times a failed external API call is retried before giving up.
      Uses exponential backoff with jitter between attempts. */
  maxRetries: number;
}
```

Each comment uses different vocabulary and adds real information: format, defaults, constraints, consequences.

### Example: Function Names

**DON'T:**

```typescript
/** Validates an email address. */
function validateEmail(email: string): boolean;
```

**DO:**

```typescript
/**
 * Checks format and domain deliverability.
 *
 * Returns true only if the address matches RFC 5322 format AND
 * the domain has valid MX records. Does a live DNS lookup — not
 * suitable for hot paths. For format-only validation without
 * network calls, use isEmailShaped().
 */
function validateEmail(email: string): boolean;
```

---

## Field Comments

### Example: Order Model

**DON'T:**

```typescript
interface Order {
  id: string;
  status: string;
  total: number;
  items: unknown[];
  createdAt: Date;
  updatedAt: Date;
}
```

Six fields, zero information. What statuses are valid? What currency is total? Is items an array of what?

**DO:**

```typescript
/** A placed order, immutable after fulfillment. */
interface Order {
  /** UUID v4, generated at creation. Used as idempotency key for
      payment processing — safe to retry with the same order ID. */
  id: string;

  /** One of: "pending", "paid", "shipped", "delivered", "cancelled".
      State machine transitions enforced by OrderStateMachine —
      direct assignment throws InvalidTransitionError. */
  status: "pending" | "paid" | "shipped" | "delivered" | "cancelled";

  /** Final price in USD cents (integer to avoid floating-point
      rounding issues). Includes tax and shipping. Discounts are
      already applied — this is what the customer actually pays. */
  totalCents: number; // NOTE: changed from `total: number` — name clarifies unit

  /** Line items in display order. Never empty — orders with zero
      items are rejected at validation. Each item is an OrderItem
      with its own quantity and unit price. */
  items: OrderItem[];

  /** When the customer placed the order (UTC). Used for SLA
      calculations — "shipped within 2 business days" is measured
      from this timestamp. */
  createdAt: Date;

  /** Last status change (UTC). Updated by OrderStateMachine on
      every transition. Always >= createdAt. */
  updatedAt: Date;
}
```

Notice how the comments revealed a design issue: `total` was a bare `number` with no unit indication, representing money in an ambiguous way. The comment-writing process caught the bug, and renaming to `totalCents` and adding a union type for `status` followed from it.

---

## Cross-Module Comments

### Example: Event Processing Pipeline

```typescript
// events/consumer.ts
//
// Consumes events from the Kafka topic and dispatches them to handlers.
//
// Ordering guarantee: events for the same entity (keyed by entityId)
// are always processed in order. Events for different entities may be
// processed concurrently — handlers must be safe for this.
//
// Retry policy: failed events are retried 3 times with exponential
// backoff (1s, 5s, 25s). After 3 failures, the event is sent to the
// dead letter topic (see events/dead-letter.ts) for manual inspection.
//
// To add a new event type:
// 1. Define the schema in events/schemas/<type>.ts
// 2. Register the handler in events/registry.ts
// 3. The consumer picks it up automatically — no changes needed here.
```

This comment serves three audiences:

- **Callers** learn the ordering and concurrency guarantees
- **Maintainers** learn the retry/DLQ behavior
- **Contributors** learn how to extend the system

Without it, each of these would require reading multiple files and reverse-engineering the conventions.

### Example: Auth Flow

```typescript
// auth/session.ts
//
// Creates and validates session tokens. Tokens are JWTs signed with
// the secret in AUTH_SECRET env var. They contain the user ID and
// a list of permission scopes — no database lookup needed to check
// permissions (see auth/permissions.ts for scope definitions).
//
// Token lifetime: 1 hour. Refresh tokens (stored in auth/refresh.ts)
// last 30 days. The frontend handles refresh transparently via the
// interceptor in lib/api-client.ts — backend routes never see
// expired-token errors for active users.
//
// SECURITY NOTE: Revoking a user's access requires waiting for token
// expiry (up to 1 hour) unless you also clear the token cache in
// auth/cache.ts. For immediate revocation (e.g., account compromise),
// use auth/revoke.ts which handles both.
```

Four files participate in the auth design. This comment, placed in the most central one, maps the whole system so a developer doesn't have to piece it together from four separate implementations.
