---
name: protocol-plan
description: "Write a plan: a spec, a ticket or an agent brief. Use whenever you write or edit one."
---

# Plan

An agent builds from the plan and the user approves it. Both need each decision stated once, with the fact that forced it. Everything downstream tests against the acceptance criteria: the agent that builds turns each one into a test, and a reviewer checks the solution against them. A criterion that cannot fail gives none of them anything to test.

Edit an agreed plan only with the user's consent.

## Style

Write in ASD-STE100 Simplified Technical English, with the ubiquitous language from `GLOSSARY.md`. When the repo has more than one, follow `GLOSSARY-MAP.md` to the right one.

- State each fact once. A fact in the problem statement stays out of the solution and the decisions. Repeated facts drift apart: one spec named the same incident in five places and gave it two different dates.
- Write what is true of this repo. Advice about testing or design that holds for every repo tells the reader nothing about this one.
- Write an ordered algorithm as numbered steps, and conditions with their outcomes as a table.
- Gloss every term, product and service the first time it appears, or link its glossary entry. A reader new to the codebase cannot tell whether a name is a product, a service or a person.
- Name the modules and components the work touches, so the reader can find it. Leave out file paths, line numbers and code snippets, since they go stale. The exception is a snippet from a prototype that encodes a decision better than prose can, such as a state machine, a reducer, a schema or a type shape: inline its decision-rich part, and say it came from a prototype.
- Titles name the change, not the symptom it fixes. Write "Runner: time out unanswered client tool calls", rather than "Runner: stop stalling on client tool calls nobody will answer".

## Acceptance criteria

Write them Given, When, Then, in the domain's language, one assertion each.

```
- [ ] Given <the state>, when <the trigger>, then <the single observable outcome>.
```

**One assertion per criterion.** This bullet holds three criteria, so write three:

> None sent when the window loses focus; none when the transcript has not mounted; none from the local inactivity rejection.

**Name the observation.** "Device check result recorded" gives the reader nothing to look at. Name the call, the value or the row that a person or a test can read.

**Write what the consumer observes.** For a feature the consumer is a user. For an internal change it is a developer or a calling module, who observes the change at the module's interface rather than in the whole app. "Scan core contains no detector ids" describes how someone arranged the code. "Given a new detector registered with its definition, when strata scans, then the text report and the SARIF output cover it with no edit elsewhere" describes what its consumer sees.

**Bound the negative.** A test can't observe the absence of everything, so it can't check "nothing else happens". Name what must not happen, such as a retry, an exception that escapes, or an error that reaches the user.

**Define every noun.** A test can't check "never twice for the same render" until someone defines "render". It can check "at most one call per message id per present transition".

**Leave out how it's tested.** A test location such as "tests at the existing provider seam" holds for any test at all, so it belongs in the Testing section. The same goes for a named test ("a test asserts the registry holds every flag"), the gates and the changelog.

Done when every rule an implementer could get wrong has its own criterion. A rule that appears once in prose and never in a criterion is the rule that gets missed.

## Sections

Each form of plan has its sections, in order. Keep their names: readers find a section by its name, and a reviewer may read the Problem Statement on its own.

- A spec: [references/spec.md](references/spec.md)
- A ticket body or an agent brief: [references/ticket.md](references/ticket.md)
