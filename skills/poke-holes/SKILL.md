---
name: poke-holes
description: "Poke holes in a plan or a solution before anyone builds on it. Spawns fresh reviewers to check each claim through several lenses. Use before creating a ticket, starting implementation or opening a pull request."
---

An author can't see their own gap-filling. Fresh reviewers catch it by checking the map (the **plan**) against the **territory** (the code, docs, tests and running app). A plan can be a ticket, a spec, a conversation or an instruction.

Each reviewer runs one **lens**:

| Target | Lenses |
|---|---|
| A plan, before the user agrees to it | Territory, Simplicity, Failure, Cold |
| A solution, before it merges | Territory, Failure, Scope |

Scale the lenses to the stakes, never to zero. A small solution might get one reviewer running Territory and Scope.

# Run a review

1. Commit first: reviewers see commits, not your working tree. Spawn one `poke-holes-reviewer` per lens, all in one message, each with this prompt and nothing else. Spawn fresh agents rather than forks, since a fork inherits your conversation and its guesses.

       You are the <lens> reviewer. Run the <lens> lens for a <plan or solution>.
       Repo: <its path> at <commit>, base <commit>
       The plan, verbatim:
       <the spec, the ticket or the instruction, exactly as written>

    Cold's prompt carries the plan's problem statement instead of the plan. Keep your summary, suspicions and reading of the plan out of every prompt: they carry the guesses this review exists to catch. On a run after fixes, scope the prompt to the repaired area plus the acceptance tests, and leave the previous table out: confirming a list is how the list gets gamed. Done when every reviewer has replied. Wait for any still running: one that hasn't replied when the session ends loses its findings but looks like a finished check.

2. Merge their rows into one table. Above it, name the target, the commit the reviewers checked and the lenses that ran. Every assumption or acceptance criterion gets a row, and holds only when no reviewer broke it. Every other finding gets a row after them, and on a plan so does every place where Cold's picture and the plan disagree. Done when every assumption or criterion has a row.

       | # | Item | Result | Evidence | Disposition |
       |---|---|---|---|---|
       | 1 | "<the assumption or criterion>" | holds | <file:line, or a command and its output> | |
       | 2 | "<…>" | fails | <…> | fix now |
       | F1 | <the finding> (<lens>) | finding | <…> | followup |

3. Call the Skill tool with "protocol-dispositions" and give every failing row and every finding a disposition. Done when every row that needs a disposition has one.

If you can't spawn reviewers, hand back with "protocol-report": no review ran. A review you narrate yourself looks like one and isn't.
