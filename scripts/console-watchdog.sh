#!/usr/bin/env bash
# Keep the ChoiBot alive. Cron runs this every minute. Single-instance via flock.
# NEVER deletes anything by default — the disk guard below is warn-only. No commits.
#
# Usage:
#   console-watchdog.sh              check + heal (restart console if :3100 is DOWN)
#   console-watchdog.sh --dry-run    report only; never restarts, never deletes
#   console-watchdog.sh reclaim --confirm   (gated) reclaim path; still a no-op unless
#                                            ALLOW_AUTO_RECLAIM=1 AND the rm body is
#                                            deliberately enabled (it is NOT, by design)
set -uo pipefail
# The console checkout: the parent of this script's dir, wherever it is cloned.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="$ROOT/watchdog.log"

# cron runs with a bare PATH (/usr/bin:/bin) that lacks pnpm + the nvm node bin,
# so `.restart-console.sh`'s `pnpm start` would fail with "pnpm: No such file or
# directory". Re-establish the login toolchain PATH here so the restart works
# regardless of how the watchdog is invoked. Node dir is globbed so an nvm
# version bump doesn't break it.
# All from $HOME (cron sets it), so any user name works.
export PNPM_HOME="${PNPM_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/pnpm}"
NODE_BIN="$(ls -d "${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin 2>/dev/null | sort -V | tail -1)"
export PATH="$PNPM_HOME/bin:${NODE_BIN}:$HOME/.local/bin:/usr/local/bin:$PATH"
# Overridable so the disk report can be exercised against a fixture without touching
# the live .agent-data (adaptation: the plan hardcodes $ROOT/.agent-data).
AGENT_DATA_DIR="${AGENT_DATA_DIR:-$ROOT/.agent-data}"
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
log(){ echo "[$(date -u +%FT%TZ)] $*" >>"$LOG"; }

exec 9>"/tmp/choibot-watchdog.lock"
flock -n 9 || exit 0   # another tick is running

# --- 1) Console backend on :3100 ---------------------------------------------
if ss -ltn 2>/dev/null | grep -q ':3100 '; then
  :
else
  log "console :3100 DOWN"
  if [ "$DRY" = 1 ]; then
    log "[dry-run] would run .restart-console.sh"
  else
    log "restarting console"
    bash "$ROOT/.restart-console.sh" >>"$LOG" 2>&1
  fi
fi

# --- 2) Gate on :3200 (best-effort note only; the gate rarely dies) ----------
ss -ltn 2>/dev/null | grep -q ':3200 ' || log "WARN gate :3200 not listening"

# --- 3) Disk guard (warn-only; deletes nothing without explicit opt-in) -------
FREE_GB=$(df -BG --output=avail / 2>/dev/null | tail -1 | tr -dc '0-9')
THRESH_GB="${DISK_THRESH_GB:-15}"
REPORT="$ROOT/disk-pressure.txt"
if [ "${FREE_GB:-999}" -lt "$THRESH_GB" ]; then
  log "DISK LOW: ${FREE_GB}G free (< ${THRESH_GB}G) — building reclaim candidate report"
  {
    echo "# disk-pressure $(date -u +%FT%TZ) — ${FREE_GB}G free"
    echo "# candidates below belong to DONE agents only; NOTHING deleted automatically."
    for j in "$AGENT_DATA_DIR"/*.json; do
      [ -f "$j" ] || continue
      st=$(grep -o '"status":[^,}]*' "$j")
      id=$(basename "$j" .json)
      case "$st" in
        *done*)
          # Tolerate pretty-printed JSON: optional space after the colon.
          wt=$(grep -o '"worktree": *"[^"]*"' "$j" | cut -d'"' -f4)
          [ -n "$wt" ] || continue
          if [ -d "$wt/target" ]; then
            echo "target        $(du -sh "$wt/target" 2>/dev/null | cut -f1)  $wt/target (agent $id)"
          fi
          if [ -d "$wt/node_modules" ]; then
            echo "node_modules  $(du -sh "$wt/node_modules" 2>/dev/null | cut -f1)  $wt/node_modules (agent $id)"
          fi
          ;;
      esac
    done
  } >"$REPORT"
  log "wrote reclaim candidates to $REPORT (review; nothing deleted)"

  # Gated reclaim path — OFF by default. Requires BOTH `reclaim --confirm` AND
  # ALLOW_AUTO_RECLAIM=1. Even then the actual rm is a deliberate placeholder: no
  # live deletion is implemented here (no-autonomous-delete rule).
  if [ "${1:-}" = "reclaim" ] && [ "${2:-}" = "--confirm" ] && [ "${ALLOW_AUTO_RECLAIM:-0}" = 1 ]; then
    log "AUTO-RECLAIM requested (reclaim --confirm + ALLOW_AUTO_RECLAIM=1) — placeholder only, nothing removed"
    # Intentionally NOT implemented: deletion of regenerable DONE-agent artifacts
    # (target/ + node_modules) would go here, e.g.:
    #   while read -r _ _ path _; do rm -rf "$path"; done < <(grep -E '^(target|node_modules)' "$REPORT")
    # Left commented until the user explicitly opts in per the no-autonomous-delete rule.
    :
  fi
fi
