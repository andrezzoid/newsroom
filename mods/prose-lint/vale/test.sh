#!/bin/sh
# The bundled rules' tests: each rule's cases beside it, then the levels.
# vale test's alerts don't show their level, so each levels file runs at the
# lowest level it asserts. Needs Vale 3.24 or later.
cd "$(dirname "$0")" || exit 2
vale --no-global test styles &&
  vale --no-global --minAlertLevel=error test levels/error.test.yml &&
  vale --no-global --minAlertLevel=warning test levels/warning.test.yml
