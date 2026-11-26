#!/usr/bin/env bash
# scripts/chief-fake-gh.sh — the `gh` of the isolated chief instance
# (scripts/chief-instance.sh copies it to <root>/bin/gh). It logs its argv
# (shell-quoted, one call per line) to $CHIEF_FAKE_LOG/gh.log, prints {} and
# exits 0, so an instance never reaches GitHub.
set -eu

if [ -n "${CHIEF_FAKE_LOG:-}" ] && [ -d "$CHIEF_FAKE_LOG" ]; then
  { printf '%q ' gh "$@"; printf '\n'; } >>"$CHIEF_FAKE_LOG/gh.log" 2>/dev/null || true
fi
printf '{}\n'
