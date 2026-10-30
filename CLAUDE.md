## Gates

`.githooks/pre-commit` runs every gate in `scripts/gates.sh` before every commit.
`.github/workflows/gates.yml` runs the same script on every pull request and every push to main. Claude Code turns the hook on when a session starts. Any other agent or person runs `git config core.hooksPath .githooks` once per clone.

## Agent skills

Tracker: GitHub Issues
Labels: bug, enhancement, needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix, in-progress
Each mod in mods/ also has a label named after its folder.
Domain docs: GLOSSARY-MAP.md, which lists each context's GLOSSARY.md and docs/adr/
