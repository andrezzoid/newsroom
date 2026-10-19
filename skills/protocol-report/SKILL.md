---
name: protocol-report
description: "Report to the user: a hand-back that asks for their decision, or a debrief when you finish. Use when you hand back or finish a workflow."
---

# Report

A report is the moment the user gets looped into the work. They haven't read the plan, your notes or your work, so act accordingly.

- Lead with the outcome. Blocked, broken or unfinished goes in the first sentence.
- Name things the way the user would, with only the ids they know.
- Say what it means for what they asked before you say how it works.
- Show the evidence: the command and its output, the test, the file and line.
- Name what you couldn't prove, and why.
- Keep it short. A report that needs scrolling buries its question.

Done when the user can act on the report without opening the diff.

## Hand-back

For when you pause for the user's decision:

```markdown
**Handed back · <what blocks the work>**

<the plan said X, you found Y, in one or two sentences>

**Evidence:** <command output, file:line, test>
**Options:** <each: the option and its cost>
**Recommendation:** <an option, and why>
**Question:** <the one thing only the user can answer>
```

## Debrief

For when you finish. Leave out a field with nothing in it.

```markdown
**Done · <what changed>**

<what the user can do now, in one or two sentences>

**Proof:** <each acceptance criterion: its test or script>
**Deviations:** <each: what the plan said, what you did, why, whether its acceptance criterion holds>
**Decisions:** <each: the call, the option not taken>
**Followups:** <each: title, problem (not a fix), reproduction steps, impact>
```
