#!/usr/bin/env bash
# Puts this harness into a Claude Code cloud environment, so cloud sessions on
# any repo get its skills, agents and mods. Paste one line into the
# environment's Setup script field (claude.ai/code, environment menu, Edit):
#
#   curl -fsSL https://raw.githubusercontent.com/andrezzoid/newsroom/main/scripts/cloud-setup.sh | bash
#
# It clones this repo to ~/.newsroom and links every skill in skills/, every
# agent in agents/ and every mod in mods/ into ~/.claude. Links, not copies,
# so a pull updates them in place. A re-run pulls, adds new links and prunes
# the ones whose source is gone. The environment runs this once and reuses a
# snapshot of the result for about seven days.
#
# HARNESS_REF picks a branch other than main; HARNESS_REPO another clone source.
set -euo pipefail
REPO="${HARNESS_REPO:-https://github.com/andrezzoid/newsroom}"
REF="${HARNESS_REF:-main}"
DIR="$HOME/.newsroom"
CLAUDE="$HOME/.claude"

if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only -q || echo "cloud-setup: pull failed, keeping $(git -C "$DIR" rev-parse --short HEAD)" >&2
else
  git clone -q --depth 1 --branch "$REF" "$REPO" "$DIR"
fi

# Links $2 to $1. A real file or folder already at $2 is someone's own: it
# stays, with a warning.
linked=0
link() {
  if [ -e "$2" ] && [ ! -L "$2" ]; then
    echo "cloud-setup: $2 is a real file or folder, left alone" >&2
    return
  fi
  ln -sfn "$1" "$2"
  linked=$((linked + 1))
}

mkdir -p "$CLAUDE/skills" "$CLAUDE/agents"
for skill in "$DIR"/skills/*/SKILL.md; do link "$(dirname "$skill")" "$CLAUDE/skills/$(basename "$(dirname "$skill")")"; done
for mod in "$DIR"/mods/*/.claude-plugin; do link "$(dirname "$mod")" "$CLAUDE/skills/$(basename "$(dirname "$mod")")"; done
for agent in "$DIR"/agents/*.md; do link "$agent" "$CLAUDE/agents/$(basename "$agent")"; done

# Prune the links into the clone whose source is gone.
for existing in "$CLAUDE/skills"/* "$CLAUDE/agents"/*; do
  if [ -L "$existing" ] && [[ "$(readlink "$existing")" == "$DIR"/* ]] && [ ! -e "$existing" ]; then
    rm "$existing"
  fi
done

# prose-lint and the gates need Vale.
sh "$DIR/scripts/install-vale.sh" /usr/local/bin || echo "cloud-setup: Vale did not install, so prose-lint can't lint" >&2

if ! node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 18) ? 0 : 1)' 2>/dev/null; then
  echo "cloud-setup: the factory CLI needs Node 22.18 or later on PATH" >&2
fi
echo "cloud-setup: $linked links into ~/.claude from $(git -C "$DIR" rev-parse --short HEAD)"
