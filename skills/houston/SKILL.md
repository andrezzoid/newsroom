---
name: houston
description: "Take work from an idea to a merged pull request. With no request, work the inbox; with setup, make a repo ready; with anything else, find the flow it belongs to and run it. Usage: /houston [setup | <request>]"
argument-hint: "[setup | <request>]"
disable-model-invocation: true
---

# Houston

Houston is the orchestrator: mission control for the agent sessions that build the software. It runs the workflows in order, reads the repo's policy from the `## Agent skills` block in its `CLAUDE.md` or `AGENTS.md`, and owns the `houston` CLI. The CLI holds the facts and the gates: run it as `<this skill's folder>/bin/houston`, which `houston` means below, and `houston --help` lists its commands. Start every run but setup with `houston preflight`, and hand back on a line that reads `fail`.

## /houston: the inbox

This run launches, merges and asks. The sessions it launches write the code.

### 1. Launch

`houston inbox --agent --json` lists what an agent can pick up, claimed work first. Start a session for each of the first three:

- In the cloud, with the `create_session` tool: a session on `https://github.com/<repo>`, from the item's `repo`, titled `<ID> <title>`, with the prompt `/houston <ID>`, or `/houston <ID> --take-over` for a pull request whose session lost signal.
- Locally, `houston mission next --launch --max 3` in the repo's clone starts a background session per ready ticket. Give the user the `/houston <ID> --take-over` line for each pull request that lost signal.

Done when each of the three has a session, or a line saying why not.

### 2. Brief the user

Write one message, then end the turn, so the routine's notification carries it. Its first line says whether anything needs the user. Then, in this order:

1. The pull requests ready to merge, asking which to merge.
2. Everything else in `houston inbox --human`, one line each with its link and the session behind it.
3. The first round of questions on the new tickets, and on `needs-info` tickets whose reporter replied since triage asked: `houston mission show <ID> --json` lists the comments. Read `<this skill's folder>/../triage/SKILL.md` and triage each one from "Triage a specific issue or PR", asking its questions the way the "grilling" skill does.

### 3. Act on the answers

Merge each pull request the user picked with `houston pr merge <PR>`. Apply the triage outcomes, and call the Skill tool with "grilling" until every new ticket has a state. Done when the frontier is empty.

## /houston setup

Make the repo ready: follow [references/setup.md](references/setup.md).

## /houston <request>

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
| a ticket, with `--take-over` or without | its `phase` in `houston mission show <ID> --json`: shape → triage it, from `<this skill's folder>/../triage/SKILL.md`; iterate → Build, at implement; babysit → Build, at babysit-pr; done → retro |
| a pull request | Build, at babysit-pr |
| a look back at the week, or `stats` | Review |

Run each step's skill. Call the Skill tool with it, or, for a skill only the user may invoke (grill-with-docs, to-spec, to-tickets, triage, retro and correct), read `<this skill's folder>/../<skill>/SKILL.md` and follow it as the step. Hand the next step what the last one produced: the spec, the ticket ids, the pull request. Say the next step before you start it, so the user can steer. In a session nobody watches, go on. Done when the flow's last step finishes, or a step hands back. End with one line: the work, its step and what it waits on.

## The CLI at each step

- **Claim:** `houston mission claim <ID>`, with `--take-over` when the request carried it. Exit 3 means it isn't yours to build: say why and stop.
- **Pull request:** open it with `houston pr open --ticket <ticket or issue ID> --title <title> --body-file <file>`, with the body the "pr" skill wrote. It pushes the branch and ends the body with the ticket's closing line, which the merge check and the tracker read. Without a ticket, the same command works without `--ticket`.
- **Hand-back:** "Houston, we have a problem." Post the report with `houston mission problem <ID> --body-file <report>` before the pull request opens, and `houston pr report <PR> --body-file <report>` after. A hand-back on a pull request turns it into a draft: once the user answers and the work goes on, mark it ready again with `gh pr ready <PR>`, or it can't merge.
- **Debrief:** post it on the pull request with `houston pr report <PR> --body-file <report>`.
- **A plan change the user agreed:** `houston mission revise <ID> --body-file <report>`, with a `Revised ·` title.
- **Followups:** file each one beside the ticket, where triage picks it up: `houston mission followup --from <ID> --title <title> --body-file <file>`.
- **Waiting on a pull request, locally:** the Monitor tool on `houston pr watch <PR>`.
- **Merge:** only `houston pr merge <PR>`. It runs the go/no-go poll first: a no-go exits 3 and names each blocker. After a go it merges and clears its ticket's labels.
