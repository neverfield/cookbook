#!/usr/bin/env bash
# Fails when a node --test TAP log has no summary, or skips or leaves todo any test or suite.
# Suites that need Docker skip themselves without it, so in CI a skip means lost coverage.
# A skipped describe() is counted under "# suites", not "# skipped", so the directives are counted too.
set -euo pipefail
log="$1"
if ! grep -qE '^# skipped [0-9]+$' "$log"; then
  echo "::error::No node --test summary in $log; the run did not finish."
  exit 1
fi
marked=$(grep -E '^ *(not )?ok [0-9]+ - .* # (SKIP|TODO)' "$log" || true)
if [ -n "$marked" ]; then
  echo "$marked"
  echo "::error::$(printf '%s\n' "$marked" | wc -l | tr -d ' ') skipped or todo tests and suites. Every suite must run in CI."
  exit 1
fi
echo "No skipped or todo tests or suites."
