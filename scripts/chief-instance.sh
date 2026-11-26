#!/usr/bin/env bash
# scripts/chief-instance.sh — a fully isolated ChoiBot for the chief of
# staff exit tasks (spec §15 "Isolated instance"): its own port (never 3100),
# HOME, data dirs and dtach dir, a fake `claude` and `gh`. It never touches
# the live console (choibot.service on 127.0.0.1:3100) or its data.
#
#   scripts/chief-instance.sh up      <root>   start a new instance, print its port
#   scripts/chief-instance.sh restart <root>   restart its server (agents survive)
#   scripts/chief-instance.sh down    <root>   stop its server and its agents
#   scripts/chief-instance.sh run     <root> [--human] -- '<cmd>'
#
# <root> is /tmp/chief-<name>. Every command against an instance goes through
# `run`: an agent shell carries PORT=3100 and the real HOME. `run` sources
# <root>/cli.env, so $R $PORT $B $H $T expand inside '<cmd>'.
#
# up and restart write instance.env from these in the caller's env (give them
# again on every restart that needs them; an unset one is dropped):
# CHIEF_ENABLED (default 1), CHIEF_USER_AUTH (default log), CHIEF_FAKE_DISTILL,
# CHIEF_FAKE_SELFTEST, CHIEF_AGENT_UID, CHIEF_REAL_CLAUDE (with
# CLAUDE_CONFIG_DIR), and for a test bot CHIEF_TEST_BOT_TOKEN with
# CHIEF_TEST_USER_ID, CHIEF_TEST_MASTER_CHAT_ID, CHIEF_TEST_MASTER_THREAD_ID,
# CHIEF_TEST_CRON_CHAT_ID, CHIEF_TEST_CRON_THREAD_ID (the topic of the recurring results),
# and CHIEF_TEST_QUIET_PRESENT_MS, CHIEF_TEST_QUIET_BLOCKED_MS (shorter
# windows of the quiet master, server/master/quiet.ts; test only), and
# CHIEF_TEST_TELEGRAM_API=http://127.0.0.1:<port> (a fake Bot API for every
# Telegram client of the instance; give it with a made-up CHIEF_TEST_BOT_TOKEN), and
# CHIEF_TEST_ENV_FILE=<root>/<file> (the .env the Settings form writes and the server reads), and
# for the front proxy's route walk (scripts/proxy-walk.mts) CONSOLE_PROXY_FROM, _NETWORK, _PORT,
# _TOKEN_SHA256, _TLS_DIR (inside <root>), CONSOLE_PROXY_TEST_ADDRESS and CONSOLE_ROUTE_DUMP
# (inside <root>), CONSOLE_UPDATE_TEST_DIR (inside <root>: the fake status files of the Update
# ticket, server/update), and GITHUB_APP_LOGIN, GITHUB_APP_CLIENT_ID and GITHUB_APP_URL (the ChoiBot
# GitHub app: public values only).
# Phase 2c: with CHIEF_AGENT_UID the server probes its agent exec helper
# through AGENT_SUDO_BIN at boot. The instance never runs the real sudo
# (ruling P6): AGENT_SUDO_BIN defaults to <root>/bin/sudo, a fake that fails
# like `sudo -n` with no sudoers line, and a given one must not be setuid,
# setgid or the system sudo. AGENT_EXEC_HELPER (absolute) and
# AGENT_HOME_ROOT (inside <root>; up makes <root>/homes) pass as given. So do the second
# account's CHIEF_PERSISTENT_UID, AGENT_CLAUDE_CONFIG_DIR, AGENT_CHIEF_CLAUDE_CONFIG_DIR and
# AGENT_CHIEF_DTACH_DIR (the folders inside <root>).
# They also write <root>/fake-claude.env (CHIEF_FAKE_LOG, CHIEF_FAKE_DISTILL,
# CHIEF_FAKE_SELFTEST, and for the model of the guide CHIEF_FAKE_GUIDE and
# CHIEF_FAKE_GUIDE_FAIL) for the fake's -p mode: the distill child and the guide's
# child get only an env allowlist, so instance.env does not reach them. The fake
# reads the file at each call: a test can also change it by hand.
#
# up and restart refuse unless this checkout is a linked git worktree that is
# not the live console's cwd: `next dev` writes ./.next, and the live checkout
# holds the production build.
#
# Names (server/names.mjs): an instance is a new install, so it uses the new names (unit
# choibot.service, CHOIBOT_* keys, .choibot, choibot-<id>.sock). With CHIEF_INSTANCE_OLD_NAMES=1,
# up also makes the old data dir <root>/home/.local/share/choibot: the instance is then an
# install with the old names, like one made before the rename.
#
# Deploy ticket tests (spec §5.7): with CHIEF_INSTANCE_UNIT=choibot-scratch-<name>.service the
# server runs as a production build inside a transient systemd user unit of that name (never
# choibot.service), with CHIEF_DEPLOY_UNIT set to it and agents in their own scopes. Only
# then is the console "its own unit", so only then can the deploy ticket restart it. The checkout
# must hold a `next build` (.next/BUILD_ID) and should be a scratch clone on branch main with a
# scratch origin: the Deploy button fast-forwards and builds the checkout the server runs from.
# Give the variable again on restart; down reads the unit from instance.env.
#
# The server is stopped only by the pid that owns its listen socket (ss -ltnp)
# and carries this root's AGENT_DATA_DIR in its environment; agents only by
# the dtach sockets of this instance's own dtach dir. Never by a pkill -f
# pattern: the live console is also a `tsx server/index.ts` process.
set -euo pipefail

readonly LIVE_PORT=3100
readonly FALLBACK_DTACH="${HOME:-}/.local/bin/dtach"
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
readonly REPO

say() { printf '[chief-instance] %s\n' "$*" >&2; }
die() { say "$*"; exit 1; }
usage() {
  cat >&2 <<'EOF'
usage: scripts/chief-instance.sh up|restart|down <root>
       scripts/chief-instance.sh run <root> [--human] -- '<cmd>'
       <root> is /tmp/chief-<name>
EOF
  exit 2
}

# ---- checks ---------------------------------------------------------------

ROOT=
NEW_DTACH=
set_root() {
  local r=${1%/}
  [[ $r =~ ^/tmp/chief-[A-Za-z0-9._-]+$ ]] || die "refusing root '$1': it must be /tmp/chief-<name>"
  [ ! -L "$r" ] || die "refusing root '$r': it is a symlink"
  if [ -e "$r" ] && { [ ! -d "$r" ] || [ ! -O "$r" ]; }; then
    die "refusing root '$r': not a directory owned by $(id -un)"
  fi
  ROOT=$r
}

# A port an instance may use: numeric, unprivileged, never the live console.
valid_port() {
  [[ ${1:-} =~ ^[0-9]{1,5}$ ]] && ((10#$1 != LIVE_PORT && 10#$1 >= 1024 && 10#$1 <= 65535))
}

valid_dtach_dir() { [[ ${1:-} =~ ^/tmp/hc-[A-Za-z0-9]{8}$ ]]; }

# A unit an instance may run in: a scratch name only, never the live console's.
valid_unit() { [[ ${1:-} =~ ^choibot-scratch-[a-z0-9][a-z0-9-]{0,40}\.service$ ]]; }

# Unit mode (CHIEF_INSTANCE_UNIT): the checks before anything changes.
check_unit_env() {
  [ -n "${CHIEF_INSTANCE_UNIT:-}" ] || return 0
  valid_unit "$CHIEF_INSTANCE_UNIT" || die "refusing CHIEF_INSTANCE_UNIT '$CHIEF_INSTANCE_UNIT': it must be choibot-scratch-<name>.service"
  [ -n "${XDG_RUNTIME_DIR:-}" ] && [ -S "$XDG_RUNTIME_DIR/bus" ] || die "unit mode needs the systemd user manager (XDG_RUNTIME_DIR with a bus socket)"
  command -v systemd-run >/dev/null && command -v systemctl >/dev/null || die "unit mode needs systemd-run and systemctl"
  [ -f "$REPO/.next/BUILD_ID" ] || die "unit mode runs a production build: run ./node_modules/.bin/next build in $REPO first"
}

# An AGENT_SUDO_BIN the instance may use: an absolute path to an executable
# file that is not setuid or setgid (the tests follow a symlink; the real
# sudo is setuid root) and does not resolve to a system sudo. Nothing here
# runs it.
fake_sudo_ok() {
  local p=${1:-} real s
  [[ $p == /* ]] && [ -f "$p" ] && [ -x "$p" ] && [ ! -u "$p" ] && [ ! -g "$p" ] || return 1
  real=$(readlink -e -- "$p") || return 1
  for s in /usr/bin/sudo /bin/sudo /usr/sbin/sudo /usr/local/bin/sudo; do
    [ ! -e "$s" ] || [ "$real" != "$(readlink -e -- "$s" || true)" ] || return 1
  done
}

# The Phase 2c keys of the caller's env (see the header). up and restart run
# this before they change anything, render_env again. With CHIEF_AGENT_UID,
# the AGENT_SUDO_BIN the server will get (given, else <root>/bin/sudo) must
# pass fake_sudo_ok; "up" skips the default, which up installs itself.
check_agent_env() {
  local sudo_bin
  if [ -n "${CHIEF_AGENT_UID:-}" ] && { [ -n "${AGENT_SUDO_BIN:-}" ] || [ "${1:-}" != up ]; }; then
    sudo_bin=${AGENT_SUDO_BIN:-$ROOT/bin/sudo}
    fake_sudo_ok "$sudo_bin" ||
      die "refusing AGENT_SUDO_BIN '$sudo_bin': it must be an executable fake, not setuid, setgid or the system sudo"
  fi
  if [ -n "${AGENT_EXEC_HELPER:-}" ] && [[ $AGENT_EXEC_HELPER != /* ]]; then
    die "refusing AGENT_EXEC_HELPER '$AGENT_EXEC_HELPER': it must be an absolute path"
  fi
  if [ -n "${AGENT_HOME_ROOT:-}" ] && { [[ $AGENT_HOME_ROOT != "$ROOT"/* ]] || [[ /$AGENT_HOME_ROOT/ == */../* ]]; }; then
    die "refusing AGENT_HOME_ROOT '$AGENT_HOME_ROOT': it must be inside $ROOT"
  fi
  return 0
}

# KEY's value in an env file (last one wins), or nothing.
env_get() { sed -n "s/^$1=//p" "$2" 2>/dev/null | tail -n 1 || true; }

# The pids that own a listening TCP socket on the port, one per line.
listen_pids() {
  local out
  out=$(ss -ltnpH "sport = :$1" 2>/dev/null || true)
  grep -oE 'pid=[0-9]+' <<<"$out" | cut -d= -f2 | sort -u || true
}

port_busy() { [ -n "$(ss -ltnH "sport = :$1" 2>/dev/null || true)" ]; }

# This root's server: the pid owns :port and its environment names this
# root's AGENT_DATA_DIR. Anything else (the live console included) fails.
server_pid_ok() {
  local pid=${1:-} port=${2:-} envs
  [[ $pid =~ ^[0-9]+$ ]] && valid_port "$port" || return 1
  grep -qx "$pid" <<<"$(listen_pids "$port")" || return 1
  envs=$(tr '\0' '\n' 2>/dev/null <"/proc/$pid/environ") || return 1
  grep -qxF "AGENT_DATA_DIR=$ROOT/agents" <<<"$envs"
}

# The server runs `next dev` in REPO and writes REPO/.next. The live console
# runs a production build from its own checkout, so the server starts only
# from a linked git worktree, and never from the cwd of a process that listens
# on :3100 (read from /proc; no request is sent).
repo_guard() {
  local gitdir common pid cwd pids
  gitdir=$(git -C "$REPO" rev-parse --path-format=absolute --git-dir 2>/dev/null || true)
  common=$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
  if [ -z "$gitdir" ] || [ -z "$common" ] || [ "$gitdir" = "$common" ]; then
    die "refusing: $REPO is not a linked git worktree (start instances from an agent worktree, never the live checkout)"
  fi
  pids=$(listen_pids "$LIVE_PORT")
  if [ -z "$pids" ] && port_busy "$LIVE_PORT"; then
    die "refusing: :$LIVE_PORT has a listener whose pid is not visible, so $REPO cannot be checked against its cwd"
  fi
  for pid in $pids; do
    cwd=$(readlink -e "/proc/$pid/cwd" 2>/dev/null || true)
    [ -n "$cwd" ] || die "refusing: cannot read the cwd of pid $pid on :$LIVE_PORT to check it against $REPO"
    [ "$cwd" != "$REPO" ] || die "refusing: $REPO is the live console's checkout (cwd of pid $pid on :$LIVE_PORT)"
  done
}

# Field 22 of /proc/<pid>/stat (start time), to never signal a reused pid.
start_time() {
  local stat rest f
  read -r stat 2>/dev/null <"/proc/$1/stat" || return 1
  rest=${stat##*) }
  read -r -a f <<<"$rest"
  printf '%s' "${f[19]:-}"
}

# ---- env files ------------------------------------------------------------

# One KEY=VALUE line for instance.env (read with mapfile, passed to env -i).
put() {
  [[ $2 != *$'\n'* ]] || die "refusing $1: its value holds a newline"
  printf '%s=%s\n' "$1" "$2"
}

# Writes <root>/instance.env and <root>/cli.env from the caller's env.
render_env() {
  local port=$1 dtach=$2 secret=$3 node node_dir dtach_bin
  valid_port "$port" || die "refusing port '$port'"
  valid_dtach_dir "$dtach" || die "refusing dtach dir '$dtach'"
  node=$(command -v node || true)
  [ -n "$node" ] || die "node is not on PATH"
  node_dir=$(dirname "$node")
  dtach_bin=$(command -v dtach || true)
  if [ -z "$dtach_bin" ] && [ -x "$FALLBACK_DTACH" ]; then dtach_bin=$FALLBACK_DTACH; fi
  [ -n "$dtach_bin" ] || die "dtach is not on PATH and $FALLBACK_DTACH is missing"
  local sudo_bin=""
  check_agent_env
  if [ -n "${CHIEF_AGENT_UID:-}" ]; then sudo_bin=${AGENT_SUDO_BIN:-$ROOT/bin/sudo}; fi
  {
    put HOME "$ROOT/home"
    put USER claude
    put LANG C.UTF-8
    put XDG_DATA_HOME "$ROOT/data"
    put PORT "$port"
    put HOST 127.0.0.1
    put WORKSPACE_DIR "$ROOT/ws"
    put AGENT_DATA_DIR "$ROOT/agents"
    put MASTER_DATA_DIR "$ROOT/master"
    put ISSUES_DATA_DIR "$ROOT/issues"
    put CRON_DATA_DIR "$ROOT/cron"
    put CHIEF_DATA_DIR "$ROOT/chief"
    put WIDGETS_DATA_DIR "$ROOT/widgets"
    put SERVICES_DATA_DIR "$ROOT/services"
    put BOT_DATA_DIR "$ROOT/bot"
    # Unit mode: agents in their own scopes, as on the live console, so a restart of the unit
    # does not kill them.
    if [ -n "${CHIEF_INSTANCE_UNIT:-}" ]; then put AGENT_SCOPE 1; else put AGENT_SCOPE 0; fi
    put AGENT_WORKTREE_ROOT "$ROOT/wt"
    put AGENT_DTACH_DIR "$dtach"
    put AGENT_DTACH_BIN "$dtach_bin"
    put CHIEF_ENABLED "${CHIEF_ENABLED:-1}"
    put CHIEF_TEST 1
    put CHIEF_USER_AUTH "${CHIEF_USER_AUTH:-log}"
    put CHIEF_CONSOLE_URL "http://127.0.0.1:$port"
    put BOT_ENABLED 0
    put CONSOLE_COOKIE_SECRET "$secret"
    put CLAUDE_CODE_EXECUTABLE "${CHIEF_REAL_CLAUDE:-$ROOT/bin/claude}"
    put CHIEF_FAKE_LOG "$ROOT/log"
    # A dead port: /editor never proxies to the live code-server (:8081), and
    # a code-server started by the instance cannot bind.
    put CODE_SERVER_BIND 127.0.0.1:1
    if [ -n "${CHIEF_FAKE_DISTILL:-}" ]; then put CHIEF_FAKE_DISTILL "$CHIEF_FAKE_DISTILL"; fi
    if [ -n "${CHIEF_FAKE_SELFTEST:-}" ]; then put CHIEF_FAKE_SELFTEST "$CHIEF_FAKE_SELFTEST"; fi
    if [ -n "${CHIEF_TEST_QUIET_PRESENT_MS:-}" ]; then put CHIEF_TEST_QUIET_PRESENT_MS "$CHIEF_TEST_QUIET_PRESENT_MS"; fi
    if [ -n "${CHIEF_TEST_QUIET_BLOCKED_MS:-}" ]; then put CHIEF_TEST_QUIET_BLOCKED_MS "$CHIEF_TEST_QUIET_BLOCKED_MS"; fi
    if [ -n "${CHIEF_AGENT_UID:-}" ]; then
      put CHIEF_AGENT_UID "$CHIEF_AGENT_UID"
      put AGENT_SUDO_BIN "$sudo_bin"
    fi
    if [ -n "${AGENT_EXEC_HELPER:-}" ]; then put AGENT_EXEC_HELPER "$AGENT_EXEC_HELPER"; fi
    if [ -n "${AGENT_HOME_ROOT:-}" ]; then put AGENT_HOME_ROOT "$AGENT_HOME_ROOT"; fi
    # The second account of strong protection (server/chief/chiefaccount.ts), for the test of its
    # sign-in: its uid, and the Claude and dtach folders inside <root> only.
    local ck
    for ck in CHIEF_PERSISTENT_UID AGENT_CLAUDE_CONFIG_DIR AGENT_CHIEF_CLAUDE_CONFIG_DIR AGENT_CHIEF_DTACH_DIR; do
      [ -n "${!ck:-}" ] || continue
      if [ "$ck" = CHIEF_PERSISTENT_UID ]; then
        [[ ${!ck} =~ ^[1-9][0-9]{0,9}$ ]] || die "refusing $ck '${!ck}': it must be a uid"
      else
        case "${!ck}" in "$ROOT"/*) ;; *) die "refusing $ck '${!ck}': it must be inside $ROOT" ;; esac
      fi
      put "$ck" "${!ck}"
    done
    if [ -n "${CHIEF_REAL_CLAUDE:-}" ] && [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then
      put CLAUDE_CONFIG_DIR "$CLAUDE_CONFIG_DIR"
    fi
    # Never the caller's TELEGRAM_* (an agent shell carries the live bot and
    # Master topic): only a dedicated test bot and group, when given.
    if [ -n "${CHIEF_TEST_BOT_TOKEN:-}" ]; then
      put TELEGRAM_BOT_TOKEN "$CHIEF_TEST_BOT_TOKEN"
      if [ -n "${CHIEF_TEST_USER_ID:-}" ]; then put TELEGRAM_ISSUES_USER_ID "$CHIEF_TEST_USER_ID"; fi
      if [ -n "${CHIEF_TEST_MASTER_CHAT_ID:-}" ]; then put TELEGRAM_MASTER_CHAT_ID "$CHIEF_TEST_MASTER_CHAT_ID"; fi
      if [ -n "${CHIEF_TEST_MASTER_THREAD_ID:-}" ]; then put TELEGRAM_MASTER_THREAD_ID "$CHIEF_TEST_MASTER_THREAD_ID"; fi
      # The topic of the results of the recurring tasks (the Notifier's cron sender).
      if [ -n "${CHIEF_TEST_CRON_CHAT_ID:-}" ]; then put TELEGRAM_CRON_CHAT_ID "$CHIEF_TEST_CRON_CHAT_ID"; fi
      if [ -n "${CHIEF_TEST_CRON_THREAD_ID:-}" ]; then put TELEGRAM_CRON_THREAD_ID "$CHIEF_TEST_CRON_THREAD_ID"; fi
    fi
    # A fake Bot API (loopback only): with it, every Bot API client of the instance and the
    # Settings page talk to the fake, never to api.telegram.org (honoured only with CHIEF_TEST=1).
    # A fake of the usage read (server/usage.ts usageUrl): what each Claude login has used.
    if [ -n "${CHIEF_TEST_USAGE_API:-}" ]; then
      [[ $CHIEF_TEST_USAGE_API =~ ^http://127\.0\.0\.1:[0-9]+$ ]] || die "refusing CHIEF_TEST_USAGE_API '$CHIEF_TEST_USAGE_API': it must be http://127.0.0.1:<port>"
      put CHIEF_TEST_USAGE_API "$CHIEF_TEST_USAGE_API"
    fi
    if [ -n "${CHIEF_TEST_TELEGRAM_API:-}" ]; then
      [[ $CHIEF_TEST_TELEGRAM_API =~ ^http://127\.0\.0\.1:[0-9]+$ ]] || die "refusing CHIEF_TEST_TELEGRAM_API '$CHIEF_TEST_TELEGRAM_API': it must be http://127.0.0.1:<port>"
      put CHIEF_TEST_TELEGRAM_API "$CHIEF_TEST_TELEGRAM_API"
    fi
    # The Settings page's Telegram form writes this file instead of the console's .env, and the
    # instance reads its Telegram keys at start (server/settings/envfile.ts). Inside <root> only.
    if [ -n "${CHIEF_TEST_ENV_FILE:-}" ]; then
      case "$CHIEF_TEST_ENV_FILE" in "$ROOT"/*) ;; *) die "refusing CHIEF_TEST_ENV_FILE '$CHIEF_TEST_ENV_FILE': it must be inside $ROOT" ;; esac
      put CHIEF_TEST_ENV_FILE "$CHIEF_TEST_ENV_FILE"
    fi
    # The front proxy's private listener (server/frontproxy.ts) and the two settings of its route
    # walk (server/testseams.ts, scripts/proxy-walk.mts). The files inside <root> only; the test
    # address in 127.0.0.0/8 (the server checks it again).
    local k
    for k in CONSOLE_PROXY_FROM CONSOLE_PROXY_NETWORK CONSOLE_PROXY_PORT CONSOLE_PROXY_TOKEN_SHA256 CONSOLE_PROXY_TEST_ADDRESS; do
      if [ -n "${!k:-}" ]; then put "$k" "${!k}"; fi
    done
    for k in CONSOLE_PROXY_TLS_DIR CONSOLE_ROUTE_DUMP CONSOLE_UPDATE_TEST_DIR; do
      if [ -n "${!k:-}" ]; then
        case "${!k}" in "$ROOT"/*) ;; *) die "refusing $k '${!k}': it must be inside $ROOT" ;; esac
        put "$k" "${!k}"
      fi
    done
    # The ChoiBot GitHub app (server/gh/appconfig.ts): its switch, its public client id and its
    # public page, so that a test of the real app needs no patch. None of them is a secret.
    for k in GITHUB_APP_LOGIN GITHUB_APP_CLIENT_ID GITHUB_APP_URL; do
      if [ -n "${!k:-}" ]; then put "$k" "${!k}"; fi
    done
    if [ -n "${CHIEF_INSTANCE_UNIT:-}" ]; then
      put NODE_ENV production
      put CHIEF_DEPLOY_UNIT "$CHIEF_INSTANCE_UNIT"
      put CHIEF_INSTANCE_UNIT "$CHIEF_INSTANCE_UNIT"
      # The server and its deploy runner talk to the user manager (systemctl --user).
      put XDG_RUNTIME_DIR "$XDG_RUNTIME_DIR"
    fi
    put PATH "$ROOT/bin:$node_dir:/usr/bin:/bin"
  } >"$ROOT/instance.env.tmp"
  chmod 600 "$ROOT/instance.env.tmp"
  mv -f "$ROOT/instance.env.tmp" "$ROOT/instance.env"
  # The distill child (claude -p) gets only an env allowlist, so the fake's
  # -p mode reads its knobs from <root>/fake-claude.env (bin/claude/../).
  {
    put CHIEF_FAKE_LOG "$ROOT/log"
    if [ -n "${CHIEF_FAKE_DISTILL:-}" ]; then put CHIEF_FAKE_DISTILL "$CHIEF_FAKE_DISTILL"; fi
    if [ -n "${CHIEF_FAKE_SELFTEST:-}" ]; then put CHIEF_FAKE_SELFTEST "$CHIEF_FAKE_SELFTEST"; fi
    if [ -n "${CHIEF_FAKE_GUIDE:-}" ]; then put CHIEF_FAKE_GUIDE "$CHIEF_FAKE_GUIDE"; fi
    if [ -n "${CHIEF_FAKE_GUIDE_FAIL:-}" ]; then put CHIEF_FAKE_GUIDE_FAIL "$CHIEF_FAKE_GUIDE_FAIL"; fi
  } >"$ROOT/fake-claude.env.tmp"
  chmod 600 "$ROOT/fake-claude.env.tmp"
  mv -f "$ROOT/fake-claude.env.tmp" "$ROOT/fake-claude.env"
  {
    echo "R=$ROOT"
    echo "PORT=$port"
    echo "B=http://127.0.0.1:$port"
    echo 'H="./node_modules/.bin/tsx bin/choibot.ts"'
    echo "CHIEF_TEST=1"
    echo "HOME=$ROOT/home"
    echo "AGENT_DTACH_DIR=$dtach"
    echo "CRON_DATA_DIR=$ROOT/cron"
    echo "XDG_DATA_HOME=$ROOT/data"
  } >"$ROOT/cli.env.tmp"
  mv -f "$ROOT/cli.env.tmp" "$ROOT/cli.env"
}

# ---- server ---------------------------------------------------------------

# Starts the server from instance.env, waits for GET /api/agents = 200 (or the lock of a new
# install: a new instance in log mode is locked until a device is paired, see `pair`) and
# writes the pid that owns the listen socket to server.pid.
start_server() {
  local port=$1 launcher code="" pids envv i
  valid_port "$port" || die "refusing port '$port'"
  ! port_busy "$port" || die "port $port is already in use"
  mapfile -t envv <"$ROOT/instance.env"
  local unit
  unit=$(env_get CHIEF_INSTANCE_UNIT "$ROOT/instance.env")
  if [ -n "$unit" ]; then
    # Unit mode: a transient user unit, the same env (env -i) and the same argv on every
    # `systemctl --user restart` of it. A tail of the unit's log file stands in for the launcher.
    valid_unit "$unit" || die "refusing unit '$unit' in $ROOT/instance.env"
    ! systemctl --user is-active --quiet "$unit" || die "unit $unit is already active"
    systemd-run --user --quiet --collect --unit="$unit" --description="ChoiBot test instance $ROOT" \
      --working-directory="$REPO" -p "StandardOutput=append:$ROOT/log/server.log" -p StandardError=inherit \
      -p TimeoutStopSec=15 \
      -- /usr/bin/env -i "${envv[@]}" "$REPO/node_modules/.bin/tsx" server/index.ts
    # No inherited stdout or stderr: a caller's pipe must not wait for this watcher.
    ( while systemctl --user is-active --quiet "$unit"; do sleep 0.5; done ) </dev/null >/dev/null 2>&1 &
    launcher=$!
  else
  # setsid gives the server its own session and process group, so a signal to
  # the caller's group (a Bash tool timeout, say) cannot reach it. setsid forks
  # only when it is already a group leader; -w then waits for that child. So
  # $! lives exactly as long as the tsx process (with no fork, $! is tsx).
  setsid -w env -i "${envv[@]}" ./node_modules/.bin/tsx server/index.ts \
    </dev/null >"$ROOT/log/server.log" 2>&1 &
  launcher=$!
  fi
  for ((i = 0; i < 360; i++)); do
    code=$(curl -s -o /dev/null -m 2 -w '%{http_code}' "http://127.0.0.1:$port/api/agents" || true)
    [ "$code" = 200 ] && break
    # A new install that pairs from the box and has no paired device answers only its pairing
    # screen (server/chief/firstrun.ts): it runs, and it says that it is locked.
    if [ "$code" = 403 ] && curl -s -m 2 "http://127.0.0.1:$port/api/chief/pair/first" | grep -q '"locked":true'; then
      code=200
      break
    fi
    if ! kill -0 "$launcher" 2>/dev/null; then
      tail -n 30 "$ROOT/log/server.log" >&2 || true
      die "the server exited during boot (log: $ROOT/log/server.log)"
    fi
    sleep 0.5
  done
  if [ "$code" != 200 ]; then
    kill -TERM "$launcher" 2>/dev/null || true
    [ -z "$unit" ] || systemctl --user stop "$unit" 2>/dev/null || true
    die "no 200 from /api/agents on :$port within 180 s (log: $ROOT/log/server.log)"
  fi
  pids=$(listen_pids "$port")
  if [ "$(wc -w <<<"$pids")" -ne 1 ] || ! server_pid_ok "$pids" "$port"; then
    kill -TERM "$launcher" 2>/dev/null || true
    [ -z "$unit" ] || systemctl --user stop "$unit" 2>/dev/null || true
    die "the listener on :$port ($(tr '\n' ' ' <<<"$pids")) is not this instance's server"
  fi
  echo "$pids" >"$ROOT/server.pid"
  # Unit mode: the watcher has done its work (the unit keeps running).
  [ -z "$unit" ] || kill "$launcher" 2>/dev/null || true
  say "$ROOT: server pid $pids on http://127.0.0.1:$port (log: $ROOT/log/server.log)"
}

# SIGTERMs this root's server (pid in server.pid, re-checked with ss) and
# waits until its port is free. Returns 1 when there is no such server.
# With "fallback" (down only), a missing or stale server.pid is replaced by
# the single listener on :port, under the same environment check.
stop_server() {
  local port=$1 fallback=${2:-} pid start i pids unit
  unit=$(env_get CHIEF_INSTANCE_UNIT "$ROOT/instance.env")
  if [ -n "$unit" ]; then
    # Unit mode: the unit is this root's (a scratch name, and its listener carries this root's
    # data dir). A deploy restart changes the pid, so server.pid is not the test here.
    valid_unit "$unit" || die "refusing unit '$unit' in $ROOT/instance.env"
    # A unit that is not running and a free port: nothing to stop (restart then only starts).
    if ! systemctl --user is-active --quiet "$unit"; then
      port_busy "$port" && return 1
      rm -f "$ROOT/server.pid"
      return 0
    fi
    pids=$(listen_pids "$port")
    if [ -n "$pids" ] && { [ "$(wc -w <<<"$pids")" -ne 1 ] || ! server_pid_ok "$pids" "$port"; }; then return 1; fi
    systemctl --user stop "$unit"
    for ((i = 0; i < 60; i++)); do
      port_busy "$port" || break
      sleep 0.5
    done
    ! port_busy "$port" || die "port $port is still in use after stopping $unit"
    rm -f "$ROOT/server.pid"
    say "$ROOT: unit $unit stopped, :$port is free"
    return 0
  fi
  pid=$(cat "$ROOT/server.pid" 2>/dev/null || true)
  if ! server_pid_ok "$pid" "$port"; then
    [ "$fallback" = fallback ] || return 1
    pids=$(listen_pids "$port")
    if [ "$(wc -w <<<"$pids")" -ne 1 ] || ! server_pid_ok "$pids" "$port"; then return 1; fi
    pid=$pids
    say "$ROOT: no valid server.pid; the single listener on :$port is this root's server (pid $pid)"
  fi
  start=$(start_time "$pid" || true)
  kill -TERM "$pid"
  for ((i = 0; i < 60; i++)); do
    port_busy "$port" || break
    sleep 0.5
  done
  if port_busy "$port"; then
    if server_pid_ok "$pid" "$port" && [ "$(start_time "$pid" || true)" = "$start" ]; then
      say "pid $pid ignored SIGTERM for 30 s: SIGKILL"
      kill -KILL "$pid" 2>/dev/null || true
    fi
    for ((i = 0; i < 20; i++)); do
      port_busy "$port" || break
      sleep 0.5
    done
    ! port_busy "$port" || die "port $port is still in use after stopping pid $pid"
  fi
  rm -f "$ROOT/server.pid"
  say "$ROOT: server pid $pid stopped, :$port is free"
}

# ---- agents ---------------------------------------------------------------

# SIGTERMs every dtach process whose argv names a socket in this instance's
# dtach dir, and their child trees; SIGKILLs what is left after 5 s.
stop_dtach_sessions() {
  local dir=$1 p a stat rest ppid pid st alive i
  local -a argv f roots=() queue=() targets=()
  local -A kids=() seen=() keep=() starts=()
  valid_dtach_dir "$dir" || die "refusing dtach dir '$dir'"
  for p in /proc/[0-9]*; do
    pid=${p#/proc/}
    if read -r stat 2>/dev/null <"$p/stat"; then
      rest=${stat##*) }
      read -r -a f <<<"$rest"
      ppid=${f[1]:-0}
      kids[$ppid]+="$pid "
    fi
    mapfile -d '' -t argv 2>/dev/null <"$p/cmdline" || continue
    [ ${#argv[@]} -gt 0 ] && [ "${argv[0]##*/}" = dtach ] || continue
    for a in "${argv[@]:1}"; do
      if [[ $a == "$dir"/*.sock && ${a#"$dir"/} != */* ]]; then roots+=("$pid"); break; fi
    done
  done
  # Never this shell or its callers (e.g. `down` run from inside an agent).
  p=$$
  while [[ $p =~ ^[0-9]+$ ]] && [ "$p" -gt 1 ]; do
    keep[$p]=1
    read -r stat 2>/dev/null <"/proc/$p/stat" || break
    rest=${stat##*) }
    read -r -a f <<<"$rest"
    p=${f[1]:-0}
  done
  queue=("${roots[@]}")
  while [ ${#queue[@]} -gt 0 ]; do
    pid=${queue[-1]}
    unset 'queue[-1]'
    [ -z "${seen[$pid]:-}" ] || continue
    seen[$pid]=1
    for a in ${kids[$pid]:-}; do queue+=("$a"); done
    [ -z "${keep[$pid]:-}" ] || continue
    st=$(start_time "$pid" || true)
    [ -n "$st" ] || continue
    starts[$pid]=$st
    targets+=("$pid")
  done
  if [ ${#targets[@]} -eq 0 ]; then
    say "no dtach session left in $dir"
  else
    say "stopping ${#roots[@]} dtach process(es) in $dir and their children (${#targets[@]} pids)"
    kill -TERM "${targets[@]}" 2>/dev/null || true
    for ((i = 0; i < 10; i++)); do
      alive=0
      for pid in "${targets[@]}"; do
        if [ "$(start_time "$pid" || true)" = "${starts[$pid]}" ]; then alive=1; break; fi
      done
      [ $alive = 1 ] || break
      sleep 0.5
    done
    for pid in "${targets[@]}"; do
      if [ "$(start_time "$pid" || true)" = "${starts[$pid]}" ]; then kill -KILL "$pid" 2>/dev/null || true; fi
    done
  fi
  rm -rf -- "$dir"
}

# ---- commands -------------------------------------------------------------

cmd_up() {
  local port="" pid dtach secret i
  repo_guard
  check_agent_env up
  check_unit_env
  for i in node python3 ss curl git setsid; do
    command -v "$i" >/dev/null || die "$i is not on PATH"
  done
  [ -x ./node_modules/.bin/tsx ] || die "no ./node_modules/.bin/tsx in $REPO (pnpm install first)"
  if [ -e "$ROOT" ]; then
    pid=$(cat "$ROOT/server.pid" 2>/dev/null || true)
    if [[ $pid =~ ^[0-9]+$ ]] && grep -q "pid=$pid," <<<"$(ss -ltnpH 2>/dev/null || true)"; then
      die "refusing up: $ROOT/server.pid ($pid) still owns a port; run down first"
    fi
    [ -z "$(ls -A "$ROOT")" ] || die "refusing up: $ROOT exists and is not empty (down it, then rm -rf it)"
  fi
  mkdir -p "$ROOT"
  # 0700: <root>/log holds the fake's .env files (CHOIBOT_AGENT_PASS), and run
  # sources <root>/cli.env.
  chmod 700 "$ROOT"
  mkdir -p "$ROOT"/{home,data,ws,agents,master,issues,cron,chief,widgets,services,bot,wt,bin,log,homes}
  chmod 700 "$ROOT/chief"
  # The marker of an install with the old names (server/names.mjs).
  if [ "${CHIEF_INSTANCE_OLD_NAMES:-}" = 1 ]; then mkdir -p "$ROOT/home/.local/share/choibot"; fi

  # A repo the console lists: its origin slug parses for server/gh/repos.ts,
  # and spawn's `git fetch --all` fails fast (no ssh). HOME=<root>/home has no
  # global identity, so the repo carries one (worktrees inherit it).
  local demo=$ROOT/ws/demo
  g() { env -u XDG_CONFIG_HOME -u GIT_DIR -u GIT_WORK_TREE HOME="$ROOT/home" git "$@"; }
  g init -q -b master "$demo"
  g -C "$demo" config user.name chief-e2e
  g -C "$demo" config user.email chief-e2e@example.invalid
  printf '# demo\n' >"$demo/README.md"
  g -C "$demo" add README.md
  g -C "$demo" commit -q -m "demo: initial commit"
  g -C "$demo" remote add origin git@github.com:o/demo.git
  g -C "$demo" config core.sshCommand false

  install -m 0755 "$REPO/scripts/chief-fake-claude.sh" "$ROOT/bin/claude"
  install -m 0755 "$REPO/scripts/chief-fake-gh.sh" "$ROOT/bin/gh"
  # The instance's sudo (ruling P6): fails like `sudo -n` with no sudoers
  # line, so a hardened boot logs its probe failure and stays on direct dtach.
  printf '#!/bin/sh\necho "sudo: a password is required" >&2\nexit 1\n' >"$ROOT/bin/sudo"
  chmod 0755 "$ROOT/bin/sudo"

  for ((i = 0; i < 5; i++)); do
    port=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')
    if valid_port "$port" && ! port_busy "$port"; then break; fi
    port=""
  done
  [ -n "$port" ] || die "no free port found"
  secret=$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))')
  [ ${#secret} -eq 43 ] || die "bad cookie secret length"
  dtach=$(mktemp -d /tmp/hc-XXXXXXXX)
  # Until instance.env names it (then `down` removes it), a failed up removes it.
  NEW_DTACH=$dtach
  trap '[ -z "$NEW_DTACH" ] || rmdir -- "$NEW_DTACH" 2>/dev/null || true' EXIT
  render_env "$port" "$dtach" "$secret"
  NEW_DTACH=
  trap - EXIT
  start_server "$port"
  echo "$port"
}

cmd_restart() {
  local port dtach secret
  repo_guard
  [ -f "$ROOT/instance.env" ] || die "no $ROOT/instance.env: run up first"
  port=$(env_get PORT "$ROOT/instance.env")
  valid_port "$port" || die "refusing restart: PORT '$port' in $ROOT/instance.env"
  dtach=$(env_get AGENT_DTACH_DIR "$ROOT/instance.env")
  secret=$(env_get CONSOLE_COOKIE_SECRET "$ROOT/instance.env")
  check_agent_env
  check_unit_env
  stop_server "$port" || die "refusing restart: $ROOT/server.pid does not own :$port"
  render_env "$port" "$dtach" "$secret"
  start_server "$port"
  echo "$port"
}

cmd_down() {
  local port dtach
  if [ ! -e "$ROOT" ]; then say "$ROOT does not exist: nothing to stop"; return 0; fi
  if [ ! -f "$ROOT/instance.env" ]; then say "no $ROOT/instance.env: nothing to stop"; return 0; fi
  port=$(env_get PORT "$ROOT/instance.env")
  if ! valid_port "$port"; then
    say "refusing to stop a server: PORT '$port' in $ROOT/instance.env"
  elif ! stop_server "$port" fallback; then
    say "$ROOT: no running server of this root on :$port"
    rm -f "$ROOT/server.pid"
  fi
  dtach=$(env_get AGENT_DTACH_DIR "$ROOT/instance.env")
  stop_dtach_sessions "$dtach"
}

cmd_run() {
  local human=0 cmd
  if [ "${1:-}" = --human ]; then human=1; shift; fi
  [ "${1:-}" = -- ] && [ $# -eq 2 ] || usage
  cmd=$2
  [ -f "$ROOT/cli.env" ] || die "no $ROOT/cli.env: run up first"
  # The caller is often an agent shell. Drop its identity (every CHOIBOT_* and CHOIBOT_*), its
  # PORT and HOME, and every data path, XDG dir and bus that could lead to
  # live data or the live user manager; cli.env then sets this instance's.
  local v
  for v in "${!CHOIBOT_@}" "${!CHOIBOT_@}"; do unset "$v"; done
  unset PORT HOME XDG_CONFIG_HOME XDG_STATE_HOME XDG_CACHE_HOME XDG_RUNTIME_DIR \
    XDG_DATA_HOME DBUS_SESSION_BUS_ADDRESS CRON_DATA_DIR AGENT_DATA_DIR MASTER_DATA_DIR \
    ISSUES_DATA_DIR CHIEF_DATA_DIR WIDGETS_DATA_DIR SERVICES_DATA_DIR BOT_DATA_DIR \
    AGENT_WORKTREE_ROOT WORKSPACE_DIR
  set -a
  # shellcheck source=/dev/null
  . "$ROOT/cli.env"
  set +a
  T=$(cat "$ROOT/home/.config/choibot/user-token" 2>/dev/null || cat "$ROOT/home/.config/choibot/user-token" 2>/dev/null || true)
  export T
  if ! valid_port "${PORT:-}" || [ "${B:-}" != "http://127.0.0.1:$PORT" ] ||
    [ "${HOME:-}" != "$ROOT/home" ] || [ "${R:-}" != "$ROOT" ]; then
    say "refusing run: $ROOT/cli.env gives PORT='${PORT:-}' B='${B:-}' HOME='${HOME:-}'"
    exit 3
  fi
  if [ $human = 1 ]; then
    unset CLAUDECODE CODEX_HOME
    export _CHIEF_INSTANCE_CMD=$cmd
    # script(1) gives the command a TTY on stdin/stdout/stderr (a human shell).
    exec script -qec 'c=$_CHIEF_INSTANCE_CMD; unset _CHIEF_INSTANCE_CMD; exec bash -c "$c"' /dev/null
  fi
  exec bash -c "$cmd"
}

[ $# -ge 2 ] || usage
sub=$1
set_root "$2"
shift 2
cd "$REPO"
case $sub in
  up) [ $# -eq 0 ] || usage; cmd_up ;;
  restart) [ $# -eq 0 ] || usage; cmd_restart ;;
  down) [ $# -eq 0 ] || usage; cmd_down ;;
  run) cmd_run "$@" ;;
  *) usage ;;
esac
