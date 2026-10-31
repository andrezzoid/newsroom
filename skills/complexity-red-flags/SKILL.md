---
name: complexity-red-flags
description: |
  Detect and fix complexity creep: shallow modules, information leakage,
  pass-through methods/variables, temporal decomposition, conjoined methods,
  overexposure, special-general mixture. Use after implementing any feature
  before declaring it done, when reviewing PRs or diffs, when refactoring,
  or when the user says "review", "audit", "simplify", "clean up", or "is
  this code good?", or code "feels complex".
context: fork
---

# Complexity Red Flags

Complexity creeps in one small decision at a time: a shallow wrapper, a leaked format, a pass-through method. Each looks harmless, and together they make a system hard to understand and change. Audit code for the eight red flags below, from John Ousterhout's _A Philosophy of Software Design_, and report each finding with its file:line and a concrete fix.

Skip one-line fixes, throwaway scripts and generated code: audit the generator instead.

## Input and output

You run in a forked context and see only what the caller passed, so you do not share the author's blind spots. Expect a git ref to diff against, or paths. With neither, review the working tree's changes against the default branch. Return each finding with its concrete fix: the caller applies it.

## Audit

### 1. Read the standards

Read `CODING_STANDARDS.md` at the repo root, and any standards file the repo's `CLAUDE.md` or `AGENTS.md` points to. A standard wins over a red flag when the two disagree, and a change that breaks one is a finding that quotes the rule. Skip rules a linter or type checker already enforces.

### 2. Run strata (TypeScript only)

`strata` is a deterministic pre-scanner that finds candidates for some of the eight flags, so your judgment goes to the candidates instead of to walking the tree. Every finding is `severity: "candidate"`: the flag's test below decides.

```bash
# Candidates introduced since a git ref: the default for a PR review
strata <project-path> --new-since <git-ref> --format json > /tmp/strata.json

# Files touched since a git ref, analysed against the whole project graph
strata <project-path> --touched-since <git-ref> --format json > /tmp/strata.json

# The whole project
strata <project-path> --format json > /tmp/strata.json
```

Without `strata` on `PATH`, run `bunx @andrezzoid/strata` with the same arguments. Start at the files in `summary.topFiles[]`, the densest first. Each entry in `findings[]` has a `flag`, a `file:line` and a `message` that says what it saw.

For other languages, skip this step.

### 3. Check each flag

For each of the eight flags, in order: run its find and read its strata findings, confirm or reject each candidate with its test, and write the fix. strata covers part of the eight, so run every find. The same code often raises more than one flag.

Cite file:line and the concrete edit: "inline `OrderValidator.validate` into `Order.create` (validators/order-validator.ts:18)", not "simplify the validators".

Reject a candidate only when the code fails the flag's test. A framework convention, a plan for later or testability is no evidence: a framework needs a request handler, a seam with one implementation is a guess, and a layer with no logic has nothing to test on its own.

Done when you checked all eight flags and grouped the findings by flag, each with its file:line and a concrete fix.

## The eight flags

### 1. Shallow module

- **Signal:** an interface nearly as complex as the body behind it. Files of boilerplate, many classes with one or two methods.
- **Find:** public classes or modules with two public methods or fewer. Files where imports, types and ceremony fill more than half the lines.
- **Test:** count the concepts in the interface (methods, parameters, types, exceptions) against those in the implementation. Close to equal means shallow.
- **Fix:** inline it, make it a plain function when more than one caller uses it, or fold it into the module that uses it. A `TemperatureConverter` class around one formula becomes a function.

### 2. Information leakage

- **Signal:** one piece of knowledge (a format, a mapping, a constant) encoded in more than one place, so a change to it touches each of them.
- **Find:** grep for duplicated field mappings, format strings and magic constants, and for parallel hierarchies such as a `Reader` and a `Writer` for one format. Look for one shape encoded more than once in a single file, such as a TS type, a JSON schema and a parser. Read the types in public signatures for internal ones, such as a storage row or a wire format, that callers now depend on.
- **Test:** change an internal format (JSON to YAML, MySQL to Postgres, REST to GraphQL) and count the places that change. More than one means leakage.
- **Fix:** give the knowledge one owner. A `{ id, name: first + " " + last, email }` mapping repeated in two routes becomes `User.fromRow(row)`.

### 3. Temporal decomposition

- **Signal:** modules split by the order things happen instead of by what each one hides.
- **Find:** standalone modules with verb-phase names: `Reader`, `Parser`, `Validator`, `Saver`, `Loader`, `Sender`. The same step inside a deeper module is fine.
- **Test:** the phases share knowledge, such as the format each step reads from the one before. A phase name with nothing shared only hints at the flag.
- **Fix:** one module owns the concept and keeps the phases inside. `FileReader → DataParser → DataValidator → DataWriter` becomes `DataStore.load(path)` and `DataStore.save(path, data)`.

### 4. Pass-through method

- **Signal:** a method that only calls another method with the same or similar arguments.
- **Find:** `grep -rE 'return this\.\w+\.\w+\([^)]*\);?\s*}'` and the like: methods whose body is one delegation.
- **Test:** remove the method. If the callers get simpler, the method was overhead.
- **Fix:** give the layer real work (validation, authorization, a business rule, caching), or remove it and let callers use the module beneath. A `UserService.getUser(id)` that returns `this.repo.getUser(id)` goes.

### 5. Pass-through variable

- **Signal:** a parameter threaded through two or more signatures and untouched until deep in the stack.
- **Find:** trace suspect parameters (`logger`, `config`, `metrics`, `ctx`) through their call chains. Flag each function that takes one and forwards it without reading it.
- **Test:** the parameter sits in the signature only because something the function calls needs it.
- **Fix:** a context object, dependency injection or module-level access. `handleRequest(request, config, logger, metrics)` becomes `handleRequest(request)`.

### 6. Conjoined methods

- **Signal:** methods you can't understand apart, because they share assumptions about call order, internal state or data formats.
<!-- vale Newsroom.Passive = NO -->
- **Find:** `init*`, `begin*` or `open*` paired with `finalize*`, `end*` or `close*`. Docs that say "must be called after". Runtime errors of the form "X must be called before Y".
<!-- vale Newsroom.Passive = YES -->
- **Test:** read one method's signature. If using it right takes reading another method, you've found conjoined methods.
- **Fix:** move the sequencing inside. `initBatch()`, `process(items)` and `finalizeBatch()` become `processBatch(items)`.

### 7. Overexposure

- **Signal:** an interface that makes every caller learn options, internal state and intermediate results that few of them need.
- **Find:** constructor and public-method signatures with more than three or four required parameters, or six or more parameters whose optional flags expose implementation choices.
- **Test:** sensible defaults would serve most callers.
- **Fix:** default the rare options inside the module. A `Cache` constructor that takes ten options becomes `new Cache("redis://localhost:6379")`.

### 8. Special-general mixture

- **Signal:** a general mechanism tangled with special-case business logic in one module.
- **Find:** `grep -rE "if \(\w+\.(table|name|type|kind) === ['\"]"` for string-equality branches in generic code, and domain names hardcoded in utility or builder modules.
- **Test:** some code in the module serves one use case and sits beside code that serves them all.
- **Fix:** keep the mechanism general and let callers supply the special case. A `QueryBuilder` that adds `WHERE active = true` when the table is `users` becomes `qb.build("users", [new Filter("active", "=", true)])`.

## References

- [references/examples.md](references/examples.md) has a full audit of a real codebase that fixes every flag it finds, and a quick-reference table of common patterns.
- `principle-deep-module-design` applies the same principles while you design a module. This skill audits code that exists.
