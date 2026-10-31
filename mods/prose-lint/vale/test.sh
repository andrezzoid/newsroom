#!/bin/sh
# Tests the bundled rules, first with each rule's cases beside it, then each
# rule's level, which vale test's alerts don't show. The slop fixture and
# levels/sample.md trip every rule once; levels/expected.txt lists the rule and
# level each must report, so only EmDashes and NeverTag are errors. Last, a
# commit message with the agent's co-author trailers, piped in as the mod pipes
# a command's prose, must raise no alert. Needs Vale 3.24 or later, and jq.
cd "$(dirname "$0")" || exit 2
vale --no-global test styles &&
  vale --no-global --output JSON ../noise/slop.md levels/sample.md |
  jq -r '[.[][] | "\(.Check) \(.Severity)"] | unique[]' |
  diff levels/expected.txt - &&
  printf 'Add the flag\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nCo-Authored-By: Anthropic:Claude Opus 5.5:low <noreply@anthropic.com>\n' |
  vale --no-global --ext=.md --output line |
  diff /dev/null -
