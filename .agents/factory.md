# Factory profile

How agents work in this repo. The factory skills read it, and the `factory`
CLI reads the fields that route tickets and gate a merge from the base branch,
so a pull request cannot raise its own autonomy. Written by `/setup-factory`.

- **Tracker:** GitHub Issues
- **Max autonomy:** `pr`
- **Merge method:** `squash`
- **Gates:** `sh scripts/gates.sh` (its header lists what it needs)

## One-way doors

A revert cannot undo a change here, so it never merges without a human.

- `.claude-plugin/marketplace.json`: renaming or removing a plugin breaks existing installs until users reinstall
- `scripts/gates.sh`: it holds the gates, so a pull request that edits it changes the checks its own merge has to pass
- `mods/prose-lint/vale/.vale.ini`: the gates lint every file with it, so editing it changes what they check
- `mods/prose-lint/vale/test.sh`: a gate, so editing it changes what the gates check
- `.githooks/**`: it decides what runs before each commit

## Issue tracker

Issues live in GitHub Issues on this repo. Use `gh issue`. Blockers are issue
dependencies, or a `## Blocked by` section listing `#12`.

An agent claims a ticket by adding `in-progress` and removing
`ready-for-agent`. A hand-back removes `in-progress` and adds
`ready-for-human`. Change labels one at a time, with `gh issue edit
--add-label` and `--remove-label`: rewriting the whole list drops any label
someone added in between.

End the pull request body with `Closes #<n>`, so the tracker links the pull
request and closes the ticket on merge.

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

Multi-context: `GLOSSARY-MAP.md` at the root lists each context's
`GLOSSARY.md`, with its decisions in that context's `docs/adr/`.
