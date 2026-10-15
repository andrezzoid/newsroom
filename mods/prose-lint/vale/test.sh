#!/bin/sh
# The bundled rules' tests: each rule's cases beside it, then each rule's
# level, which vale test's alerts don't show. The slop fixture and
# levels/sample.md trip every rule once; levels/expected.txt lists the rule and
# level each must report, so only EmDashes and NeverTag are errors. Needs Vale
# 3.24 or later, and jq.
cd "$(dirname "$0")" || exit 2
vale --no-global test styles &&
  vale --no-global --output JSON ../noise/slop.md levels/sample.md |
  jq -r '[.[][] | "\(.Check) \(.Severity)"] | unique[]' |
  diff levels/expected.txt -
