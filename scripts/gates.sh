#!/bin/sh
# Every gate: Houston runs this before a merge, and .githooks/pre-commit
# before each commit. Needs the claude CLI, Vale 3.24 or later, jq, and Node
# 22.18 or later.
cd "$(dirname "$0")/.." || exit 2
claude plugin validate . &&
  claude plugin test mods/prose-lint &&
  sh mods/prose-lint/vale/test.sh &&
  node --test --test-reporter=dot 'skills/houston/test/*.spec.ts' || exit 1

# The houston CLI typechecks, lints clean, and keeps oxfmt's format. npm ci
# installs the tools whenever node_modules was not installed from this exact
# lockfile, as in a fresh clone or worktree, or after a version bump.
cmp -s package-lock.json node_modules/.gates-lock ||
  { npm ci && cp package-lock.json node_modules/.gates-lock; } || exit 1
node_modules/.bin/tsc -p skills/houston &&
  node_modules/.bin/oxlint skills/houston &&
  node_modules/.bin/oxfmt --check 'skills/houston/**/*.ts' || exit 1

# Every third-party skill's source names its license in skills/NOTICE.
missing=$(jq -r '.skills[].source' skills-lock.json | sort -u |
  while read -r source; do grep -qF "$source" skills/NOTICE || echo "$source"; done)
if [ -n "$missing" ]; then
  printf '%s\n' "$missing"
  echo "gates: add each source above, with its license, to skills/NOTICE."
  exit 1
fi

# Every skill a skill or agent tells Claude to call exists in .claude/skills,
# or ships with Claude Code, and the model may invoke it. A skill that only
# exists on one machine is missing from every cloud session, and the Skill tool
# refuses a skill only the user may invoke: read that one by its path instead.
# A name is any quoted or backticked word in the rest of a sentence that
# mentions the Skill tool, or the argument of Skill("name"). The sed drops the
# dots of e.g. and i.e. so a sentence runs on past them.
builtin="code-review security-review run"
missing=$(grep -rhiE 'Skill tool|Skill\(' skills agents | sed 's/e\.g\./eg/g; s/i\.e\./ie/g' |
  grep -oiE 'Skill tool[^.]*|Skill\([^)]*\)' |
  grep -oE '["`][a-z0-9-]+["`]' | tr -d '"`' | sort -u | while read -r name; do
    case " $builtin " in (*" $name "*) continue ;; esac
    if [ ! -f ".claude/skills/$name/SKILL.md" ]; then echo "$name: missing from .claude/skills"
    elif grep -q '^disable-model-invocation: true' ".claude/skills/$name/SKILL.md"; then echo "$name: only the user may invoke it"
    fi
  done
  grep -rhoE '\.\./[a-z0-9-]+/SKILL\.md' skills agents | cut -d/ -f2 | sort -u | while read -r name; do
    [ -f ".claude/skills/$name/SKILL.md" ] || echo "$name: read by its path but missing from .claude/skills"
  done)
if [ -n "$missing" ]; then
  printf '%s\n' "$missing"
  echo "gates: link each missing skill into .claude/skills, and read a skill only the user may invoke by its path."
  exit 1
fi

# Every tracked file against the bundled rules, whoever wrote it, except
# third-party code and the fixtures that hold slop on purpose. Any alert fails,
# warnings too: Vale itself exits 1 only on errors. A line that quotes a rule
# to explain it turns Vale off around itself, as the README does.
# Third-party skills are the ones skills-lock.json lists, edited or not.
# A symlink gets linted at its target, so the gates skip every link.
set -- $(jq -r '.skills | keys[] | ":(exclude)skills/\(.)/**"' skills-lock.json)
set -- "$@" $(git ls-files -s | awk '$1 == "120000" { print ":(exclude)" $4 }')
alerts=$(git ls-files -z -- ':(exclude,glob)**/vendor/**' \
  ':(exclude,glob)mods/prose-lint/noise/*.md' ':(exclude)mods/prose-lint/vale/levels' \
  "$@" |
  xargs -0 vale --no-global --config mods/prose-lint/vale/.vale.ini --output line)
status=$?
if [ -n "$alerts" ]; then
  printf '%s\n' "$alerts"
  echo "gates: fix each Vale alert above."
  exit 1
fi
[ "$status" -eq 0 ] || { echo "gates: vale failed (xargs exit $status)"; exit 1; }
