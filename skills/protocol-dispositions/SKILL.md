---
name: protocol-dispositions
description: "Give every finding a disposition: fix now, followup or rejected. Use whenever a finding arrives, from a reviewer, a pull request comment or a failing check."
---

# Dispositions

A finding is any claim that something is wrong. It might come from a reviewer you spawned, a comment on a pull request, or a check that failed. Judge it on what it claims, regardless of its author's tone, authority or confidence. Then give it one disposition, with its reason.

- **Fix now:** repair it before the work moves on. A bug fix starts with a test that fails on the bug.
- **Followup:** real, and outside this work. It becomes a ticket once the user has seen it.
- **Rejected:** wrong, or not worth its cost. Rejecting is a normal outcome.

Done when every finding has a disposition.
