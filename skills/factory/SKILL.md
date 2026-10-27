---
name: factory
description: "Take work from an idea to a merged pull request. With no request, work the inbox; with setup, make a repo ready; with anything else, find the flow it belongs to and run it. Usage: /factory [setup | <request>]"
argument-hint: "[setup | <request>]"
disable-model-invocation: true
---

# Factory

Factory is the orchestrator. It runs the workflows in order, reads the repo's policy from the `## Agent skills` block in its `CLAUDE.md` or `AGENTS.md`, and owns the `factory` CLI. The CLI holds the facts and the gates: run it as `<this skill's folder>/bin/factory`, which `factory` means below, and `factory --help` lists its commands. Start every run but setup with `factory doctor`, and hand back on a line that reads `fail`.

## /factory: the inbox

This run dispatches, merges and asks. The sessions it starts write the code.

### 1. Dispatch

`factory inbox --agent --json` lists what an agent can pick up, claimed work first. Start a session for each of the first three:

- In the cloud, with the `create_session` tool: a session on `https://github.com/<repo>`, from the item's `repo`, titled `<ID> <title>`, with the prompt `/factory <ID>`, or `/factory <ID> --take-over` for a pull request whose session went quiet.
- Locally, `factory tickets next --dispatch --max 3` in the repo's clone starts a background session per ready ticket. Give the user the `/factory <ID> --take-over` line for each quiet pull request.

Done when each of the three has a session, or a line saying why not.

### 2. Brief the user

Write one message, then end the turn, so the routine's notification carries it. Its first line says whether anything needs the user. Then, in this order:

1. The pull requests ready to merge, asking which to merge.
2. Everything else in `factory inbox --human`, one line each with its link and the session behind it.
3. The first round of questions on the new tickets, and on `needs-info` tickets whose reporter replied since triage asked: `factory tickets show <ID> --json` lists the comments. Read `<this skill's folder>/../triage/SKILL.md` and triage each one from "Triage a specific issue or PR", asking its questions the way the "grilling" skill does.

### 3. Act on the answers

Merge each pull request the user picked with `factory pr merge <PR>`. Apply the triage outcomes, and call the Skill tool with "grilling" until every new ticket has a state. Done when the frontier is empty.

## /factory setup

Make the repo ready: follow [references/setup.md](references/setup.md).

## /factory <request>

Say in one line which flow and step the request belongs to, then run from that step. When it fits no flow, say so and ask.

| Flow | Steps |
|---|---|
| Shape | grill-with-docs → to-spec → Tickets or Build |
| Tickets | to-tickets → retro |
| Build | implement → pr → babysit-pr → retro, once the pull request merges |
| Review | the weekly stats: follow [references/stats.md](references/stats.md) |

| The request is | Start at |
|---|---|
| an idea or a problem to shape | Shape, at grill-with-docs |
| an agreed spec | the end of Shape: Tickets or Build. Recommend Build when the spec fits one ticket |
| a ticket, with `--take-over` or without | its `phase` in `factory tickets show <ID> --json`: shape → triage it, from `<this skill's folder>/../triage/SKILL.md`; iterate → Build, at implement; babysit → Build, at babysit-pr; done → retro |
| a pull request | Build, at babysit-pr |
| a look back at the week | Review |

Run each step's skill. Call the Skill tool with it, or, for a skill only the user may invoke (grill-with-docs, to-spec, to-tickets, triage, retro and correct), read `<this skill's folder>/../<skill>/SKILL.md` and follow it as the step. Hand the next step what the last one produced: the spec, the ticket ids, the pull request. Say the next step before you start it, so the user can steer. In a session nobody watches, go on. Done when the flow's last step finishes, or a step hands back. End with one line: the work, its step and what it waits on.

## The CLI at each step

- **Claim:** `factory tickets claim <ID>`, with `--take-over` when the request carried it. Exit 3 means it isn't yours to build: say why and stop.
- **Hand-back:** post the report with `factory tickets handback <ID> --body-file <report>` before the pull request opens, and `factory pr report <PR> --body-file <report>` after.
- **Debrief:** post it on the pull request with `factory pr report <PR> --body-file <report>`.
- **A plan change the user agreed:** `factory tickets revise <ID> --body-file <report>`, with a `Revised ·` title.
- **Followups:** file each one beside the ticket, where triage picks it up: `factory tickets new --from <ID> --title <title> --body-file <file>`.
- **Waiting on a pull request, locally:** the Monitor tool on `factory pr watch <PR>`.
- **Merge:** only `factory pr merge <PR>`, which checks the pull request first and clears its ticket's labels after.
