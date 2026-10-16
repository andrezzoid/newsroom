#!/bin/sh
# Every gate: the factory runs this before a merge, and .githooks/pre-commit
# before each commit. Needs the claude CLI, Vale 3.24 or later, and jq.
cd "$(dirname "$0")/.." || exit 2
claude plugin validate . &&
  claude plugin test mods/prose-lint &&
  sh mods/prose-lint/vale/test.sh || exit 1

# Every third-party skill's source names its license in skills/NOTICE.
missing=$(jq -r '.skills[].source' skills-lock.json | sort -u |
  while read -r source; do grep -qF "$source" skills/NOTICE || echo "$source"; done)
if [ -n "$missing" ]; then
  printf '%s\n' "$missing"
  echo "gates: add each source above, with its license, to skills/NOTICE."
  exit 1
fi

# Every tracked file against the bundled rules, whoever wrote it, except
# third-party code and the fixtures that hold slop on purpose. Any alert fails,
# warnings too: Vale itself exits 1 only on errors. A line that quotes a rule
# to explain it turns Vale off around itself, as the README does.
# Third-party skills are the ones skills-lock.json lists, edited or not.
# .agents/skills links to skills/, so Vale would lint them again through it.
set -- $(jq -r '.skills | keys[] | ":(exclude)skills/\(.)/**"' skills-lock.json)
alerts=$(git ls-files -z -- ':(exclude,glob)**/vendor/**' \
  ':(exclude,glob)mods/prose-lint/noise/*.md' ':(exclude)mods/prose-lint/vale/levels' \
  ':(exclude).agents/skills' "$@" |
  xargs -0 vale --no-global --config mods/prose-lint/vale/.vale.ini --output line)
status=$?
if [ -n "$alerts" ]; then
  printf '%s\n' "$alerts"
  echo "gates: fix each Vale alert above."
  exit 1
fi
[ "$status" -eq 0 ] || { echo "gates: vale failed (xargs exit $status)"; exit 1; }
