# Agent skills

The skills an agent follows to take work from a plan to a merged pull request, and the words they use with each other and with the user.

## Language

### Skills

**Workflow**:
A skill with steps and a definition of done, which the user or another workflow calls.
_Avoid_: Process, review skill

**Protocol**:
A skill that fixes the shape of a handoff, between an agent and the user or between two agents, whatever workflow calls it.
_Avoid_: Reference, template

**Principle**:
A judgment rule an agent applies while it works, which fires from its own description.
_Avoid_: Guideline, best practice

**Orchestrator**:
The skill that sequences workflows and holds the policy one project sets for them.
_Avoid_: Meta skill, router

**Paved path**:
The way a codebase means you to do things, as its docs, lint rules and best-kept code show it.
_Avoid_: Golden path, broken windows

### Factory

**Flow**:
The order the orchestrator runs workflows in, from a request to its outcome: Shape, Tickets, Build or Review.
_Avoid_: Pipeline, process

**Inbox**:
What waits on the user, and what an agent can pick up now.
_Avoid_: Queue, backlog

**Claim**:
The `in-progress` label an agent adds to a ticket before it builds, so no other session takes the ticket.
_Avoid_: Assign, lock

**Phase**:
Where a ticket stands for the factory: shape, iterate, babysit or done.
_Avoid_: Status, state

### Work

**Plan**:
What the work answers: a ticket, an agent brief, a spec, or what a conversation settled. Only the user changes it.
_Avoid_: Contract, agreement, work item, proposal

**Agent brief**:
The plan triage posts as a comment on a ticket, which replaces the ticket's body as what the work answers.
_Avoid_: Brief (alone), triage notes

**Solution**:
What an agent builds from a plan.
_Avoid_: Change, implementation, the work

**Acceptance criterion**:
A condition the plan states that the solution must meet, with an observation that would show it false.
_Avoid_: Acceptance line, acceptance (alone)

**Acceptance test**:
The test that proves one acceptance criterion, at the layer and seam where its falsifying observation shows.
_Avoid_: Acceptance check, e2e test

**Proof**:
A test or script that shows an acceptance criterion holds, with the same result on every run.
_Avoid_: Manual check, screenshot

**Gate**:
A check the repository runs on every commit and pull request.
_Avoid_: Hook, CI step

**Deviation**:
A place where the solution departs from the plan.
_Avoid_: Change of plan

### Review

**Finding**:
A claim that something is wrong, from a reviewer, a pull request comment or a failing check.
_Avoid_: Issue, problem, comment

**Disposition**:
The decision on a finding, with its reason: fix now, followup or rejected.
_Avoid_: Decision, resolution, triage

**Followup**:
A real problem outside the current work, which becomes a ticket once the user has seen it.
_Avoid_: Follow-up, TODO

**Territory**:
What is there, the code, docs, tests and running app, against which a reviewer checks the plan.
_Avoid_: Reality, ground truth

**Lens**:
The one angle a poke-holes reviewer attacks the plan or the solution from.
_Avoid_: Angle, perspective

**Cold**:
The lens that sees only the plan's problem statement.
_Avoid_: Problem-only

### Telling the user

**Human on the loop**:
The stance where an agent works autonomously and the user supervises, hearing from it only at a hand-back or a debrief.
_Avoid_: Human in the loop, check-in

**Report**:
What an agent leaves the user: a hand-back or a debrief.
_Avoid_: Brief, briefing, summary

**Hand back**:
To pause the work for a decision only the user can make, leaving a report that asks for it.
_Avoid_: Escalate, block, ask

**Debrief**:
The report an agent leaves when it finishes the work.
_Avoid_: Summary, wrap-up

**Circuit breaker**:
The rule that turns the same failure, three times running, into a hand-back.
_Avoid_: Retry limit
