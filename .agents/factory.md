# Factory profile

How agents work in this repo. The factory skills read it, and the `factory`
CLI reads the fields that route tickets and gate a merge from the base branch,
so a pull request cannot raise its own autonomy. Written by `/setup-factory`.

- **Tracker:** GitHub Issues
- **Max autonomy:** `pr`
- **Merge method:** `squash`
- **Gates:** `claude plugin validate .`, `claude plugin test mods/prose-lint`, `sh mods/prose-lint/vale/test.sh` (Vale 3.24 or later, and jq)

## One-way doors

A revert cannot undo a change here, so it never merges without a human.

- `.claude-plugin/marketplace.json`: renaming or removing a plugin breaks existing installs until users reinstall

## Issue tracker

Issues live in GitHub Issues on this repo. Use `gh issue`. Blockers are issue
dependencies, or a `## Blocked by` section listing `#12`. A ticket an agent
works on carries the `in-progress` label.

`factory ticket show <ID>` gives the branch to work on and the `Closes` line
the PR body ends with, so the tracker links the PR and closes the ticket on
merge.

**PRs as a request surface: yes.** `/triage` also lists open PRs from people
outside the repo (GitHub author association `CONTRIBUTOR`,
`FIRST_TIME_CONTRIBUTOR` or `NONE`) and triages them like issues, with `gh pr
view`, `gh pr diff` and `gh pr edit`. It triages any PR you name, whoever
wrote it.

## Triage labels

Matt Pocock's `triage` roles under their own names, plus the factory's.

| Role | Label |
|---|---|
| Something broke | `bug` |
| New feature or improvement | `enhancement` |
| Maintainer needs to evaluate | `needs-triage` |
| Waiting on reporter for more information | `needs-info` |
| Fully specified, ready for an AFK agent | `ready-for-agent` |
| Needs a human, from triage or handed back by an agent | `ready-for-human` |
| Nobody will act on it | `wontfix` |
| May merge itself once verified | `autonomy:merge` |
| Claimed by an agent session | `in-progress` |

## Domain docs

Multi-context: `CONTEXT-MAP.md` at the root lists each mod's `CONTEXT.md`, with
its decisions in that mod's `docs/adr/`.
