#!/bin/bash
# The console checkout is the dir of this script, wherever it is cloned.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT" || exit 1

# Heal THROUGH systemd whenever possible. systemd supervises the console as an
# in-cgroup process that owns :3100. Launching our own `pnpm start` here would
# escape systemd's cgroup, grab the port as an orphan, and then fight the
# service for it (EADDRINUSE crash-loop) — the exact failure this avoids.
#
# The watchdog invokes this from cron, which has no D-Bus session env, so point
# `systemctl --user` at the user bus explicitly before using it.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=${XDG_RUNTIME_DIR}/bus}"

# `show-environment` returns 0 iff the user systemd manager is reachable. If it
# is, systemd owns the service — restart through it and never launch our own.
if systemctl --user show-environment >/dev/null 2>&1; then
  # The unit of this install: choibot, or choibot on an install with the old names (its
  # unit file is one of the markers in server/names.mjs).
  UNIT=choibot
  if [ -e "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/choibot.service" ]; then UNIT=choibot; fi
  echo "restarting via systemd ($UNIT.service)"
  systemctl --user restart "$UNIT"
  exit $?
fi

# Fallback: the user systemd bus is genuinely unreachable (e.g. linger off, or
# run outside the user session). Last-resort direct launch — can orphan under
# systemd, so it is used ONLY when systemd cannot be reached at all.
echo "systemd user bus unreachable — direct launch fallback"
# Main server only — the [s]/[p] bracket trick keeps pgrep from matching itself.
# Does NOT match the gate (server/gate/index.ts) or other agents' claude procs.
pids=$(pgrep -f "tsx.*[s]erver/index.ts"; pgrep -f "[p]npm start")
echo "killing: $pids"
kill $pids 2>/dev/null
sleep 2
kill -9 $pids 2>/dev/null
# wait for :3100 to free
for i in $(seq 1 30); do ss -ltn 2>/dev/null | grep -q ":3100 " && sleep 0.5 || break; done
# Load env (CONSOLE_COOKIE_SECRET, etc.) — the server does not read .env itself,
# so without this the server refuses to start on a strong-secret check.
set -a; source "$ROOT/.env"; set +a
# Drop any tmux context — this script may be run from inside a tmux pane, and a
# leaked TMUX/TMUX_PANE would make dtach-hosted agents think they're in tmux.
# (terminal.ts childEnv strips these too; this keeps the server process clean.)
unset TMUX TMUX_PANE
PORT=3100 NODE_ENV=production nohup pnpm start > "$ROOT/restart-server.log" 2>&1 &
echo "relaunched pnpm start, pid $!"
