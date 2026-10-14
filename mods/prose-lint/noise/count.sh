#!/bin/sh
# The noise test of a change to the bundled rules: counts the alerts a Vale
# config raises over files, per rule and level, most first. Run it with the
# old config and the new one over slop.md, which holds the AI writing habits
# the rules must catch, and over a few thousand words of the user's own
# Markdown, which shows the noise. Then read the matches of every new rule
# that fires more than 10 times.
#
# Usage: count.sh <.vale.ini> <file or folder>…
config=$1
shift
vale --config "$config" --output JSON "$@" |
  jq -r '[.[][] | "\(.Check) \(.Severity)"] | group_by(.) | map("\(length) \(.[0])") | .[]' |
  sort -rn
