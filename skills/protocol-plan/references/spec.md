# Spec sections

A spec uses these sections, in this order.

```markdown
## Decision

The design question and answer, one sentence each.

## Problem Statement

The problem that the user is facing, from the user's perspective.

## Solution

The solution to the problem, from the user's perspective.

## Implementation Decisions

A list of implementation decisions that were made. This can include:

- The modules that will be built/modified
- The interfaces of those modules that will be modified
- Technical clarifications from the developer
- Architectural decisions
- Schema changes
- API contracts
- Specific interactions
- Races, deadlocks and ordering constraints

Follow the template:

- **<the decision, one line>**: forced by <the fact in the territory that made it the sensible choice, naming the module or the source>. Not <the rejected alternative>, because <one clause>.

Record the rejected alternatives.

## Acceptance Criteria

- [ ] Given <state>, when <trigger>, then <single observable outcome>.

## Testing

The seam each slice tests at, the modules it tests, and the nearest similar test in the codebase.

## Out of Scope

A description of the things that are out of scope for this spec.

## Further Notes

Any further notes about the feature.
```
