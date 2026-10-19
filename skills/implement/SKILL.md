---
name: implement
description: "Implement a plan: a ticket (ENG-123 in Linear, owner/repo#12 or #12 in GitHub Issues), a spec file, or what this conversation settled. Use when asked to implement, build or pick up any of these."
---

Implement the plan: a ticket, a spec, or what this conversation settled, and commit as you progress. Follow the "principle-human-on-the-loop" skill. The run pauses when you hand back and ends when you're done.

Done means every acceptance criterion has deterministic proof, every gate the repository defines passes, you've committed the solution and you've debriefed the user.

# Ground rules

- Treat the plan as an agreement, and never edit a published ticket's body or an approved spec without explicit consent.
- Keep the solution to what the acceptance criteria need. Anything else you find is a followup.
- Give every finding a disposition (fix now, followup or rejected) with the "protocol-dispositions" skill.
- Circuit breaker: when you've gone back to the same step three times, hand back.

# Process 

1. If you have a ticket reference, fetch it from the issue tracker and state its title before starting. If you have nothing to work from, or the reference is ambiguous, hand back.

2. Check for blockers in the plan. If any is still open, hand back.

3. Claim the ticket when there is one.

4. Quote each acceptance criterion and state the observation that would falsify it. When there are none, or one has no such observation, hand back: vague acceptance criteria are a shaping problem.

5. Create `<id-or-slug>.md` in your scratchpad or temp folder for working notes. Keep it current: what you tried, deviations from the plan, decisions, open loops. It is yours, it is disposable, and it only has to survive the session.

6. Call the Skill tool with "tdd". Each acceptance criterion gets one acceptance test that proves it, at the layer and seam the plan agrees on, or else where its falsifying observation shows. Add other tests only to drive a bug fix. An acceptance test proves its criterion only while it asserts what the criterion says, so weakening it fails the criterion. Done when every acceptance test passes.

    - While you build, follow "principle-paved-path", "comments-as-design", "deep-module-design" and "define-errors-away" wherever their triggers match.

7. Call the Skill tool with "code-review", "security-review" and "complexity-red-flags". Done when every finding has a disposition.

8. Call the Skill tool with "poke-holes" on the final solution. Done when a fresh pass finds no new fix-now finding.

9. Run every gate the repository defines. Done when every gate passes.

10. Debrief the user with the "protocol-report" skill.
