## Gates

`.githooks/pre-commit` runs every gate in `scripts/gates.sh` before every commit.
`.github/workflows/gates.yml` runs the same script on every pull request and every push to main. Claude Code turns the hook on when a session starts. Any other agent or person runs `git config core.hooksPath .githooks` once per clone.

## Agent skills

### Issue tracker
GitHub Issues, PRs on GitHub. See `.agents/factory.md`.

### Triage labels
Matt Pocock's triage roles under their own names, plus `autonomy:merge`. See `.agents/factory.md`.

### Domain docs
Multi-context. See `.agents/factory.md`.
