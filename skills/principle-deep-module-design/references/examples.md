# Deep Module Design: Extended Examples

Before/after examples for the design-time principles in `SKILL.md`. For audit-time examples (pass-through methods, temporal decomposition, information leakage in existing code), see the **complexity-red-flags** skill.

## Example 1: General-Purpose vs. Special-Purpose (Workflow step 4)

A general-purpose interface is often _simpler_ than a special-purpose one because it replaces many specific methods with fewer, more flexible ones.

### Before (Special-Purpose)

```typescript
class TextEditor {
  deleteSelection(): void { ... }
  deleteNextChar(): void { ... }
  deletePrevChar(): void { ... }
  deleteWord(): void { ... }
  deleteLine(): void { ... }
  deleteToEndOfLine(): void { ... }

  insertChar(c: string): void { ... }
  insertString(s: string): void { ... }
  insertNewline(): void { ... }
  insertTab(): void { ... }
}
```

Ten methods, each for a specific editing action. Every new editing operation requires a new method. The interface grows linearly with the feature set.

### After (General-Purpose)

```typescript
class TextEditor {
  insert(position: Position, text: string): void { ... }
  delete(start: Position, end: Position): void { ... }
  selection(): Range { ... }
  moveCursor(position: Position): void { ... }
}
```

Four methods that can express any editing operation. `deleteSelection` becomes `delete(selection.start, selection.end)`. `deleteLine` becomes `delete(lineStart, lineEnd)`. The interface is both smaller and more powerful.

**Stop point:** generality fails in two directions, both worth watching for:

- **Too low-level (under-bundled).** A common operation takes more than one primitive call to express. Add a convenience method or rebalance the boundary.
- **Too general (over-parameterized).** A single primitive grows five arguments and a flags object to cover every case. Split it back into focused primitives.

<!-- vale Newsroom.Adverbs = NO -->
Aim for "somewhat general-purpose": general enough to absorb future variants, specific enough that the common case is one line.
<!-- vale Newsroom.Adverbs = YES -->

---

## Example 2: Pull Complexity Down with Defaults (Workflow step 2)

### Before (Complexity Pushed Up to Caller)

```typescript
const client = new HttpClient({
  timeout: 30,
  retries: 3,
  retryBackoff: new ExponentialBackoff({ base: 1, max: 30 }),
  connectionPoolSize: 10,
  keepAlive: true,
  sslVerify: true,
  sslCaBundle: "/etc/ssl/certs/ca-certificates.crt",
  followRedirects: true,
  maxRedirects: 5,
});
```

The interface exposes every implementation decision. Callers must understand connection pooling, SSL verification and backoff strategies, none of which they need to make a request.

### After (Complexity Pulled Down)

```typescript
// Sensible defaults for everything. Override only what you need.
const client = new HttpClient();

// Or, for the rare case where customization is real:
const client = new HttpClient({ timeout: 60, retries: 5 });
```

The constructor still accepts all those options, but defaults every single one. 95% of callers write one line. The module absorbed the knowledge of what good defaults look like, and that knowledge belongs with the people who maintain the module.

**Counter-rule:** if a caller needs to decide (for example, between strict and lax SSL for one environment), keep that knob exposed. Hide implementation choices, not outcome decisions.

---

## Example 3: Don't Over-Decompose Utilities (Workflow step 5)

### Before (Premature Abstraction)

```typescript
// utils/string.ts — used in exactly one place
export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// utils/array.ts — used in exactly one place
export function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

// utils/date.ts — used in exactly one place
export function formatDate(d: Date): string {
  return d.toISOString().split("T")[0];
}
```

Three files, three functions, each used once. The "utility" abstraction hides no information: it moves code to a different file. Callers must now find and understand the utility instead of seeing the logic inline.

### After (Inline Until Reuse Is Real)

```typescript
// Just write it where you use it
const displayName = name.charAt(0).toUpperCase() + name.slice(1);
const uniqueTags = [...new Set(tags)];
const dateStr = date.toISOString().split("T")[0];
```

Three lines, no indirection. Extract into a shared utility only when you have three or more call sites, _and_ the utility offers a simpler interface than the raw operation.

---

## Example 4: Combining Closely Related Code (Workflow step 5)

The inverse of the previous example: when code shares knowledge, splitting it creates leakage.

### Before (Five Shallow Collaborators)

```typescript
class UserValidator {
  validate(input: UserInput): ValidationResult { ... }
}
class PasswordHasher {
  hash(password: string): string { ... }
}
class UserRepository {
  save(user: User): void { ... }
}
class WelcomeEmailSender {
  send(user: User): void { ... }
}
class UserRegistrationService {
  constructor(
    private validator: UserValidator,
    private hasher: PasswordHasher,
    private repo: UserRepository,
    private emailer: WelcomeEmailSender,
  ) {}

  register(input: UserInput): User {
    const result = this.validator.validate(input);
    if (!result.ok) throw new ValidationError(result.errors);
    const user = new User(input.email, this.hasher.hash(input.password));
    this.repo.save(user);
    this.emailer.send(user);
    return user;
  }
}
```

Five classes, none of which hides any information worth hiding. The `UserRegistrationService` is pure orchestration. Validation rules know the user shape; hashing knows the password format; storage knows the user shape; the email sender knows the user shape. Four places encode the same knowledge.

### After (One Deep Module)

```typescript
class Users {
  register(email: string, password: string): User {
    // Validates, hashes, stores, sends welcome — all internal.
    ...
  }

  authenticate(email: string, password: string): Session { ... }
  deactivate(userId: string): void { ... }
}
```

One class, deep interface. Validation rules, hashing strategy, storage mechanism, and email delivery are all internal. Switch from bcrypt to argon2, and nothing outside this module changes. Switch from SQL to a document store, and nothing outside this module changes.

---

## Quick Reference

| Step | Question | Failure mode if skipped |
| --- | --- | --- |
| 1. Write the ideal call site | What capability does the module deliver, and what's the line of caller code I wish I could write? | Designing inside-out; interface shaped by the implementation |
| 2. Bury implementation decisions | Would changing this decision force callers to change? | Information leakage; every internal change ripples outward |
| 3. Make every layer earn its abstraction | Does this layer add a responsibility, or only delegate? | Pass-through layers; cognitive overhead with no benefit |
<!-- vale Newsroom.Adverbs = NO -->
| 4. Lean general-purpose, stop at "somewhat" | Can one method replace several special-case ones without making the common case awkward? | API bloat (too special) or unusable interfaces (too general) |
<!-- vale Newsroom.Adverbs = YES -->
| 5. Combine closely related, resist splitting unrelated | Does each piece make sense alone? Do callers always use them together? | God-modules (over-combined) or shallow collaborators (over-split) |
| 6. Verify depth | Call-site match? Concept ratio reasonable? Swap test passes? | Shipping a shallow module disguised as a deep one |
