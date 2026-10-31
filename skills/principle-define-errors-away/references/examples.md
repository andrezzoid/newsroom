# Define Errors Out of Existence: Extended Examples

## Example 1: HTTP Request Handler

### Before (Exception Soup)

```typescript
async function handleUpdateProfile(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = JSON.parse(req.body);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (!body.email) {
    return new Response("Missing email field", { status: 400 });
  }

  let email: string;
  try {
    email = validateEmail(body.email);
  } catch {
    return new Response("Invalid email format", { status: 400 });
  }

  if (!body.name) {
    return new Response("Missing name field", { status: 400 });
  }

  if (body.name.length > 100) {
    return new Response("Name too long", { status: 400 });
  }

  let user: User;
  try {
    user = await db.getUser(req.userId);
  } catch (e) {
    if (e instanceof UserNotFoundError)
      return new Response("User not found", { status: 404 });
    throw e;
  }

  try {
    user.update({ email, name: body.name });
    await db.save(user);
  } catch (e) {
    if (e instanceof DuplicateEmailError)
      return new Response("Email already taken", { status: 409 });
    return new Response("Internal error", { status: 500 });
  }

  return Response.json(user.toJSON(), { status: 200 });
}
```

Seven error handling branches. More error code than business logic. Each branch is a separate path that needs testing.

### After (Errors Defined Away)

```typescript
// A schema that parses and validates in one step — no exceptions for bad input
const ProfileUpdate = z.object({
  email: z.string().email(),
  name: z.string().max(100),
});

async function handleUpdateProfile(req: Request): Promise<Response> {
  // Schema.safeParse returns { success, data, error } — no exceptions
  const parsed = ProfileUpdate.safeParse(JSON.parse(req.body));
  if (!parsed.success) {
    return Response.json(parsed.error.issues, { status: 400 });
  }

  // updateProfile handles "user must exist" internally (this is an
  // authenticated route — missing user is a bug, not a user error).
  // Email uniqueness is enforced at the DB level and surfaced as a
  // validation error, not an exception.
  const result = await users.updateProfile(req.userId, parsed.data);
  if (!result.ok) {
    return Response.json(result.error.detail, { status: result.error.status });
  }

  return Response.json(result.data, { status: 200 });
}
```

The JSON parsing, field validation, and type checking are all defined away by the schema. The database layer handles uniqueness constraints as validation errors rather than exceptions. That leaves the handler two paths, success and validation error.

---

## Example 2: File Processing Pipeline

### Before (Defensive Everywhere)

```typescript
async function processUpload(filePath: string): Promise<Result> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const stats = fs.statSync(filePath);
  if (stats.size === 0) {
    throw new Error("File is empty");
  }
  if (stats.size > MAX_SIZE) {
    throw new Error("File too large");
  }

  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch (e) {
    throw new Error(`Could not read file: ${e.message}`);
  }

  let parsed: Data;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    throw new Error(`Invalid JSON: ${e.message}`);
  }

  if (!Array.isArray(parsed.records)) {
    throw new Error("Expected records array");
  }

  const results: ProcessedRecord[] = [];
  for (const record of parsed.records) {
    try {
      results.push(processRecord(record));
    } catch (e) {
      // Skip bad records? Fail entirely? Nobody knows.
      console.error(`Skipping bad record: ${e.message}`);
    }
  }

  return { processed: results.length, total: parsed.records.length };
}
```

### After (Errors Defined Away or Aggregated)

```typescript
// A loader that handles all the file-level concerns internally
const loader = new JsonFileLoader<{ records: unknown[] }>({
  maxSize: MAX_SIZE,
  schema: z.object({ records: z.array(z.unknown()) }),
});

async function processUpload(filePath: string): Promise<ProcessingResult> {
  // load() returns the data or a structured error — never throws.
  // Handles: not found, empty, too large, not UTF-8, not JSON, wrong shape.
  const file = await loader.load(filePath);
  if (!file.ok) return ProcessingResult.failed(file.error);

  // processAll handles individual record failures internally.
  // Bad records are collected, not thrown.
  return RecordProcessor.processAll(file.data.records);
}

// RecordProcessor defines record errors out of existence:
class RecordProcessor {
  static processAll(records: unknown[]): ProcessingResult {
    const processed: ProcessedRecord[] = [];
    const skipped: SkippedRecord[] = [];

    for (const raw of records) {
      const record = RecordSchema.safeParse(raw);
      if (!record.ok) {
        skipped.push({ raw, reason: record.error });
        continue;
      }
      processed.push(this.process(record.data));
    }

    return new ProcessingResult(processed, skipped);
  }
}
```

The file loader defines away all file-related errors by handling them internally and returning a result type. The record processor defines away individual record failures by treating them as skipped records instead of exceptions. The caller has two clear paths: file failed to load, or here are your results (with skip details included).

---

## Example 3: Cache with Transparent Fallback

### Before (Callers Handle Cache Misses)

```typescript
async function getUserProfile(userId: string): Promise<UserProfile> {
  try {
    const cached = await cache.get(`profile:${userId}`);
    if (cached != null) {
      try {
        return UserProfile.fromJSON(cached);
      } catch {
        await cache.delete(`profile:${userId}`); // Stale/corrupt entry
      }
    }
  } catch {
    // Cache is down, fall through
  }

  let profile: UserProfile;
  try {
    profile = await db.queryUserProfile(userId);
  } catch (e) {
    throw new ServiceError(`Could not fetch profile: ${e}`);
  }

  try {
    await cache.set(`profile:${userId}`, profile.toJSON(), { ttl: 300 });
  } catch {
    // Best effort caching
  }

  return profile;
}
```

The caller is managing cache hits, cache misses, cache corruption, cache connection failures, serialization errors, and database errors. Caching should be an optimization, but it's tripled the code complexity.

### After (Cache Masks Its Own Errors)

```typescript
/** Cache with transparent fallback. Never throws — worst case, it's a no-op. */
class ProfileCache {
  async getOrLoad(
    userId: string,
    loader: () => Promise<UserProfile>,
  ): Promise<UserProfile> {
    const cached = await this.tryGet(`profile:${userId}`);
    if (cached != null) return cached;

    const profile = await loader();
    await this.trySet(`profile:${userId}`, profile, 300);
    return profile;
  }

  /** Returns deserialized value or undefined. Never throws. */
  private async tryGet(key: string): Promise<UserProfile | undefined> {
    try {
      const raw = await this.client.get(key);
      return raw ? UserProfile.fromJSON(raw) : undefined;
    } catch {
      return undefined; // Cache miss, corruption, connection error — all the same
    }
  }

  /** Best-effort write. Never throws. */
  private async trySet(
    key: string,
    value: UserProfile,
    ttl: number,
  ): Promise<void> {
    try {
      await this.client.set(key, value.toJSON(), { ttl });
    } catch {
      // Cache is an optimization, not a requirement
    }
  }
}

// Caller code:
async function getUserProfile(userId: string): Promise<UserProfile> {
  return profileCache.getOrLoad(userId, () => db.queryUserProfile(userId));
}
```

The cache masks all of its own errors: it handles connection failures, corruption and serialization bugs inside. The caller's code went from 15 lines with 5 exception handlers to 1 line with zero.

---

## Example 4: Idempotent State Transitions

### Before (Guard Against "Invalid" Transitions)

```typescript
class Order {
  ship(): void {
    if (this.status === "shipped") throw new AlreadyShippedError();
    if (this.status === "cancelled") throw new OrderCancelledError();
    if (this.status !== "paid")
      throw new InvalidStateError(`Cannot ship from ${this.status}`);
    this.status = "shipped";
    this.shippedAt = new Date();
  }

  cancel(): void {
    if (this.status === "cancelled") throw new AlreadyCancelledError();
    if (this.status === "shipped") throw new CannotCancelShippedError();
    this.status = "cancelled";
  }
}
```

Every state transition throws for "invalid" previous states, forcing every caller to handle multiple error cases.

### After (Idempotent Transitions)

```typescript
class Order {
  /** Mark as shipped. Returns true if state changed, false if already shipped
      or not in a shippable state. Never throws for state reasons. */
  ship(): boolean {
    if (this.status !== "paid") return false;
    this.status = "shipped";
    this.shippedAt = new Date();
    return true;
  }

  /** Cancel the order if possible. Returns true if state changed. */
  cancel(): boolean {
    if (this.status === "cancelled" || this.status === "shipped") return false;
    this.status = "cancelled";
    return true;
  }
}
```

"Ship an already-shipped order" is a no-op. "Cancel a shipped order" is a request the order can't fulfil. Neither is an error: the caller gets a boolean and decides what to do with it, with no exception handling.
