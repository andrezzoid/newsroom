#!/bin/sh
# Every gate: the factory runs this before a merge, and .githooks/pre-commit
# before each commit. Needs the claude CLI, Vale 3.24 or later, and jq.
cd "$(dirname "$0")/.." || exit 2
claude plugin validate . &&
  claude plugin test mods/prose-lint &&
  sh mods/prose-lint/vale/test.sh || exit 1

# Every tracked file against the bundled rules, whoever wrote it, except
# third-party code and the fixtures that hold slop on purpose. Any alert fails,
# warnings too: Vale itself exits 1 only on errors. A line that quotes a rule
# to explain it turns that rule off around itself, as the README does.
alerts=$(git ls-files -z -- ':(exclude,glob)**/vendor/**' \
  ':(exclude,glob)mods/prose-lint/noise/*.md' ':(exclude)mods/prose-lint/vale/levels' |
  xargs -0 vale --no-global --config mods/prose-lint/vale/.vale.ini --output line)
status=$?
if [ -n "$alerts" ]; then
  printf '%s\n' "$alerts"
  echo "gates: $(printf '%s\n' "$alerts" | wc -l | tr -d ' ') alerts in the prose above. Fix each one."
  exit 1
fi
[ "$status" -eq 0 ] || { echo "gates: vale failed (xargs exit $status)"; exit 1; }
