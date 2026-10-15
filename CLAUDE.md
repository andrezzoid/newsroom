## Gates

`.githooks/pre-commit` runs `scripts/gates.sh` before every commit: the plugin's checks and tests, and Vale over every tracked file. Claude Code turns the hook on when a session starts. Any other agent or person runs `git config core.hooksPath .githooks` once per clone.

## Agent skills

### Issue tracker
GitHub Issues, PRs on GitHub. See `.agents/factory.md`.

### Triage labels
Matt Pocock's triage roles under their own names, plus `autonomy:merge`. See `.agents/factory.md`.

### Domain docs
Multi-context. See `.agents/factory.md`.
