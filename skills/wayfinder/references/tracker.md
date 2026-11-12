# Wayfinding operations

How each tracker that `/houston setup` configures holds a map. The `Tracker:` line of the repo's `## Agent skills` block says which section applies.

## GitHub Issues

Use the `gh` CLI. Infer the repo from `git remote -v`; `gh` does this inside a clone.

- **Labels**: `gh label list` shows which exist. Create a missing one with `gh label create wayfinder:<name>`.
- **Map**: `gh issue create --label wayfinder:map --title "..." --body-file <file>`.
- **Child ticket**: a GitHub sub-issue of the map. `gh issue create --parent <map> ...`, or `gh issue edit <map> --add-sub-issue <child>` (`gh` 2.94 or later). With an older `gh`: `gh api --method POST repos/<owner>/<repo>/issues/<map>/sub_issues -F sub_issue_id=<child-db-id>`, where the database id comes from `gh api repos/<owner>/<repo>/issues/<n> --jq .id`, not the `#number` or `node_id`.
- **Blocking**: GitHub's native issue dependencies. `gh issue edit <child> --add-blocked-by <blocker>` (`gh` 2.94 or later). With an older `gh`: `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`.
- **Open blockers**: `gh api repos/<owner>/<repo>/issues/<n> --jq .issue_dependencies_summary.blocked_by`. 0 means startable.
- **Frontier query**: the map's open sub-issues, `gh api repos/<owner>/<repo>/issues/<map>/sub_issues --jq '.[] | select(.state == "open") | {number, title, labels: [.labels[].name]}'`. Drop each one with an open blocker or the `in-progress` label. The first in map order wins.
- **Claim**: `gh issue edit <n> --add-label in-progress`, the session's first write.
- **Resolve**: `gh issue comment <n> --body-file <answer>`, then `gh issue close <n>` and `gh issue edit <n> --remove-label in-progress`, then append a context pointer (gist and link) to the map's Decisions so far with `gh issue edit <map> --body-file <file>`. On an already-closed issue, `gh issue close --comment` drops the comment and still exits 0, so comment first.

File issues only into the user's own repo.

## Linear

Use the `linear` CLI: call the Skill tool with "linear-cli" before the first command. Every write names the team from the `Tracker:` line.

- **Labels**: `linear label list`. Create a missing one with `linear label create --name wayfinder:<name> --team <team>`.
- **Map**: `linear issue create --team <team> --label wayfinder:map --title "..." --description-file <file>`.
- **Child ticket**: `linear issue create --team <team> --parent <map> --label wayfinder:<type> ...`. Linear sub-issues are native.
- **Blocking**: `linear issue relation add <child> blocked-by <blocker>`.
- **Frontier query**: the map's open sub-issues, each without an open blocker (`linear issue relation list <n>`) and without the `in-progress` label. The first in map order wins.
- **Claim**: `linear issue update <n> --add-label in-progress`, the session's first write. Leave the state and the assignee alone.
- **Resolve**: `linear issue comment add <n> --body-file <answer>`, then `linear issue update <n> --state completed --remove-label in-progress`, then append a context pointer (gist and link) to the map's Decisions so far with `linear issue update <map> --description-file <file>`.
