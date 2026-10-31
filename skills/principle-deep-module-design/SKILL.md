---
name: principle-deep-module-design
description: Design modules with simple interfaces and rich implementations. Use when creating, extending, or refactoring any module, class, service or API. Trigger on phrases like "simplify the interface", "reduce API surface", "encapsulate", "clean up boundaries", "split this class", "extract a helper", "wrap this", or before writing the first line of a new abstraction.
---

# Deep Module Design

A **deep** module gives callers a lot of functionality through a small interface. A **shallow** one exposes nearly as much as it implements. A module has more callers than developers, so push complexity into the implementation, where one developer pays for it once.

Skip throwaway scripts, prototypes and leaf helpers with a single caller. To audit code that already exists, use `complexity-red-flags`.

## Steps

Work through all six as the interface takes shape. When a later step finds a problem, go back to the step it names.

### 1. Write the ideal call site

State the capability in one sentence, then write the line of caller code you wish you could write to use it. Together they cap the interface: design backwards from them. When the call site and the sentence disagree, one of them is wrong.

```typescript
// Capability: register a user from an email and password, returning the User.
const user = await users.register(email, password);
```

### 2. Bury implementation decisions; expose outcomes

List what the implementation decides: data formats, retry policy, ordering, defaults, error handling, storage, validation, threading, caching. For each, ask: **would changing this force a caller to change?** If yes, it leaks, so pull it inside.

Hide how the module does the work. Keep visible the outcome a caller needs to decide what to do next. A caller who parses your error messages to find out what happened shows you hid too much.

```typescript
// Leaks the format into every caller:
const dbUrl = JSON.parse(fs.readFileSync("config.json", "utf-8")).database.connections.primary.url;
// Owns it, so JSON can become YAML or env vars with no caller change:
const dbUrl = AppConfig.load().dbUrl;
```

### 3. Make every layer earn its abstraction

Name, in one phrase, what each public method adds: validation, authorization, transformation, caching, retry, a business rule, cascading cleanup. Collapse a layer whose phrase is "calls X", "wraps X" or "forwards to X", or repeats the phrase of the layer beside it. The deeper layer keeps the work.

Neither testability nor a framework convention keeps an empty layer. A layer with no logic has nothing to test on its own, so test the deep module. A framework needs a request handler, and the handler can call the deep module itself.

A helper used in one place is dead weight: inline it, and extract only when reuse is real.

<!-- vale Newsroom.Adverbs = NO -->
### 4. Lean general-purpose; stop at "somewhat"
<!-- vale Newsroom.Adverbs = YES -->

<!-- vale Newsroom.Adverbs = NO -->
Make the module **somewhat general-purpose**: the implementation serves the needs you have today, and the interface is general enough to serve more than one use. A general interface is often simpler than a special-purpose one, because a few flexible methods replace many specific ones.
<!-- vale Newsroom.Adverbs = YES -->

1. List the operations callers need today, each a verb on the data: `deleteWord`, `deleteLine`, `deleteSelection`.
2. Find the smallest set of orthogonal primitives that covers them: `delete(start, end)` covers every `delete*`.
3. Write each common case with only the primitives. When an obvious one takes more than one call, you went too low: move the boundary or add a convenience method.
4. Stop when a new primitive removes no special case from the list.

Generalize for the use cases you have. A seam with one implementation is a guess.

### 5. Combine closely related; resist splitting unrelated

For each piece, write down the knowledge it carries (a format, an invariant, a schema, a workflow, a set of business rules) and who calls it.

- **Combine** two pieces when they share knowledge, when callers always call them together, or when you can't understand one without the other.
- **Separate** them only when they share neither knowledge nor callers.

Names in verb form (`Reader`, `Validator`, `Sender`, `Loader`) signal **temporal decomposition**: modules split by the order things happen, each one repeating the same knowledge. Restructure around what each module owns.

```typescript
// Five shallow collaborators that always travel together:
new UserRegistrationService(new UserValidator(), new PasswordHasher(), new UserRepository(), new WelcomeEmailSender()).register(input);
// One module that owns the domain: it validates, hashes, stores and welcomes.
users.register(email, password);
```

### 6. Verify depth before finalizing

Done when all three hold, each with evidence:

- **Call-site match:** the final interface matches or beats the call site from step 1. Justify or cut each concept it added.
- **Concept ratio:** the interface has far fewer concepts (public methods, required parameters, exposed types, thrown errors) than the implementation (decisions, branches, helpers, state).
- **Swap test:** replacing the implementation with a different database, format or algorithm changes no caller file. Any other number means a decision still leaks: back to step 2.

## Red flags while drafting

Each one sends you back to a step.

- A constructor with more than three required parameters: step 2.
- A method whose name and parameters are nearly as large as its body: step 6.
- Two methods a caller must call in a fixed order: step 5. Merge them into one method that runs the sequence inside.
- A caller making three or more calls to the module for one logical action: step 4.
- A parameter threaded untouched through two or more functions: step 2. Replace it with a context object or module-level access.
- A public method that only delegates: step 3.
- A module named after a phase instead of a concept: step 5.
- A caller who must read the implementation to use the module: step 1, or step 2 when the module hides too much.

## References

[references/examples.md](references/examples.md) has longer before/after examples for general-purpose interfaces, defaults, and over-decomposition.
