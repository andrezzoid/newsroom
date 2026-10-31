# Ticket sections

A ticket body and an agent brief use these sections, in this order.

A **parent** is an issue on the tracker. A ticket with a parent inherits its problem statement, decisions and scope, and leaves those sections out. A spec in a local file is not a parent, because an agent working from another clone cannot read it: copy its problem statement and decisions into each ticket.

```markdown
## Parent

<the parent issue; leave the section out when there is none>

## Problem Statement

<the problem the user faces, from the user's perspective>

## What to build

<the end-to-end behaviour this ticket makes work, from the user's perspective, rather than a list of changes layer by layer>

## Implementation Decisions

- **<the decision, one line>**: forced by <the fact in the territory that made it the sensible choice, naming the module or the source>. Not <the rejected alternative>, because <one clause>.

## Testing

<the seam this slice tests at, and the nearest similar test in the codebase, in one line>

## Acceptance criteria

- [ ] Given <state>, when <trigger>, then <single observable outcome>.

## Out of scope

<the adjacent changes this ticket must not make>

## Blocked by

<one line per blocking ticket, by its tracker id; leave the section out when there are none or when the tracker supports native blocked by>
```
