#!/usr/bin/env bash
# Install the console supervisor. Prefers a cron entry (every minute); if cron is
# unavailable, prints a nohup keep-alive fallback. Installs nothing destructive.
set -euo pipefail
# The console checkout: the parent of this script's dir, wherever it is cloned.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LINE="* * * * * /usr/bin/env bash $ROOT/scripts/console-watchdog.sh >/dev/null 2>&1"
if command -v crontab >/dev/null && { pgrep -x cron >/dev/null || pgrep -x crond >/dev/null; }; then
  ( crontab -l 2>/dev/null | grep -v console-watchdog.sh; echo "$LINE" ) | crontab -
  echo "installed cron entry:"
  crontab -l | grep console-watchdog.sh
else
  echo "cron NOT available — fallback: run the supervised loop under whatever starts the console."
  echo "Fallback one-liner (nohup keep-alive):"
  echo "  nohup bash -c 'while true; do bash $ROOT/scripts/console-watchdog.sh; sleep 60; done' >$ROOT/watchdog-loop.log 2>&1 &"
fi
