#!/usr/bin/env bash
# scripts/release/try.sh — start ONE release (build.sh's output) in a clean folder of this
# machine and run the health check of the format (release-format.md, section 8) against it.
# It never touches the live console: its own folder, HOME, port (never 3100), data and dtach
# folders, a fake claude and a fake gh, no Telegram.
#
#   scripts/release/try.sh <release folder> [--old-names] [--strong] [--trace] [--stay]
#
#   --old-names  an install with the old names: no first-run lock (the Settings page opens on
#                loopback). Without it, the console is a new install with no paired device.
#   --strong     strong protection's access layer on (CHIEF_AGENT_UID and a fake sudo that fails, as
#                scripts/chief-instance.sh does): a caller with no credential gets only what a
#                hosted console gives it. NOT the accounts, the exec helper or the sudo rule (they
#                need root): the agents run as this user. The real server is the proof of those.
#   --trace      strace of every connect() and execve() of the console, from its start to the end
#                of the checks: what it ran and where it connected (no npm, no download).
#   --stay       leave the console running; it prints the port and how to stop it.
#
# Like the updater: the size and the SHA-256 of the tar against index.json, then the tar
# extracted with no owner, then `node/bin/pnpm start` in app/, as the console's unit does.
set -euo pipefail
umask 022
say() { printf '%s\n' "$*"; }
die() { printf '✖ %s\n' "$*" >&2; exit 1; }

REL= OLD=0 STRONG=0 TRACE=0 STAY=0
while [ $# -gt 0 ]; do
  case $1 in
    --old-names) OLD=1 ;;
    --strong) STRONG=1 ;;
    --trace) TRACE=1 ;;
    --stay) STAY=1 ;;
    -*) die "unknown option: $1" ;;
    *) REL=$1 ;;
  esac
  shift
done
[ -n "$REL" ] && [ -f "$REL/index.json" ] || die "give the release folder (with index.json)"
REL=$(cd "$REL" && pwd)
command -v python3 > /dev/null || die "python3 is missing"
DTACH_BIN=$(command -v dtach || true)
[ -n "$DTACH_BIN" ] || [ ! -x "$HOME/.local/bin/dtach" ] || DTACH_BIN=$HOME/.local/bin/dtach
[ -n "$DTACH_BIN" ] || die "dtach is missing"

field() { python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$REL/index.json" "$1"; }
FILE=$(field file) SIZE=$(field size) SHA=$(field sha256) COMMIT=$(field commit) VERSION=$(field version)
[ -f "$REL/$FILE" ] || die "$FILE is not in $REL"
[ "$(stat -c %s "$REL/$FILE")" = "$SIZE" ] || die "the tar's size is not the index's"
[ "$(sha256sum "$REL/$FILE" | cut -d' ' -f1)" = "$SHA" ] || die "the tar's SHA-256 is not the index's"
say "✔ the tar: $SIZE bytes, the index's SHA-256"

ROOT=$(mktemp -d /tmp/choibot-try-XXXXXXXX)
PID=
stop() {
  if [ -n "$PID" ] && kill -0 "$PID" 2> /dev/null; then kill -TERM -- "-$PID" 2> /dev/null || true; sleep 2; kill -KILL -- "-$PID" 2> /dev/null || true; fi
  rm -rf -- "$ROOT"
}
[ "$STAY" = 1 ] || trap stop EXIT
mkdir -p "$ROOT/rel" "$ROOT/home" "$ROOT/data" "$ROOT/ws" "$ROOT/wt" "$ROOT/dtach" "$ROOT/bin" "$ROOT/log"
chmod 0700 "$ROOT/dtach"
tar -xzf "$REL/$FILE" -C "$ROOT/rel" --no-same-owner --no-same-permissions
APP=$ROOT/rel/app
[ "$(tr -d '\n' < "$APP/.next/BUILD_ID")" = "$COMMIT" ] || die "app/.next/BUILD_ID is not the index's commit"
# The fakes of the instance (scripts/chief-instance.sh): no real Claude, no real GitHub login.
install -m 0755 "$APP/scripts/chief-fake-claude.sh" "$ROOT/bin/claude"
install -m 0755 "$APP/scripts/chief-fake-gh.sh" "$ROOT/bin/gh"
# --strong: the server probes its exec helper through this sudo at boot; it fails like `sudo -n`
# with no sudoers line, so the agents stay this user's (never the system's sudo).
printf '#!/bin/sh\necho "sudo: a password is required" >&2\nexit 1\n' > "$ROOT/bin/sudo"
chmod 0755 "$ROOT/bin/sudo"
if [ "$OLD" = 1 ]; then mkdir -p "$ROOT/data/choibot"; fi

PORT=
for _ in 1 2 3 4 5; do
  PORT=$(python3 -I -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')
  [ "$PORT" != 3100 ] && ! (exec 3<> "/dev/tcp/127.0.0.1/$PORT") 2> /dev/null && break
  PORT=
done
[ -n "$PORT" ] || die "no free port"
SECRET=$(python3 -I -c 'import secrets;print(secrets.token_urlsafe(32))')
ENVF=$ROOT/env
{
  printf '%s\n' "HOME=$ROOT/home" USER=claude LANG=C.UTF-8 "XDG_DATA_HOME=$ROOT/data" "PATH=$ROOT/bin:$ROOT/rel/node/bin:/usr/bin:/bin"
  printf '%s\n' "PORT=$PORT" HOST=127.0.0.1 "WORKSPACE_DIR=$ROOT/ws" "AGENT_WORKTREE_ROOT=$ROOT/wt"
  for k in AGENT MASTER ISSUES CRON CHIEF WIDGETS SERVICES BOT; do printf '%s_DATA_DIR=%s\n' "$k" "$ROOT/$(tr '[:upper:]' '[:lower:]' <<< "$k")"; done
  printf '%s\n' AGENT_SCOPE=0 "AGENT_DTACH_DIR=$ROOT/dtach" "AGENT_DTACH_BIN=$DTACH_BIN" CHIEF_ENABLED=1 CHIEF_TEST=1 CHIEF_USER_AUTH=log
  printf '%s\n' "CHIEF_CONSOLE_URL=http://127.0.0.1:$PORT" BOT_ENABLED=0 "CONSOLE_COOKIE_SECRET=$SECRET"
  printf '%s\n' "CLAUDE_CODE_EXECUTABLE=$ROOT/bin/claude" "CHIEF_FAKE_LOG=$ROOT/log" CODE_SERVER_BIND=127.0.0.1:1
  printf '%s\n' npm_config_offline=true NEXT_TELEMETRY_DISABLED=1
  if [ "$STRONG" = 1 ]; then
    mkdir -p "$ROOT/homes"
    printf '%s\n' "CHIEF_AGENT_UID=$(( $(id -u) + 1 ))" "AGENT_SUDO_BIN=$ROOT/bin/sudo" "AGENT_EXEC_HELPER=$ROOT/bin/no-helper" "AGENT_HOME_ROOT=$ROOT/homes"
  fi
} > "$ENVF"
grep -v '^PATH=\|^HOME=\|^USER=\|^LANG=\|^XDG_DATA_HOME=' "$ENVF" > "$APP/.env"
chmod 0600 "$ENVF" "$APP/.env"
mapfile -t ENVV < "$ENVF"

say "→ start: $ROOT/rel/node/bin/pnpm start (port $PORT$([ "$OLD" = 1 ] && echo ", old names")$([ "$STRONG" = 1 ] && echo ", strong access"))"
RUN=("$ROOT/rel/node/bin/pnpm" start)
[ "$TRACE" = 0 ] || RUN=(strace -f -qq -e trace=connect,execve -e signal=none -o "$ROOT/trace.txt" "${RUN[@]}")
T0=$SECONDS
(cd "$APP" && exec setsid env -i "${ENVV[@]}" "${RUN[@]}") < /dev/null > "$ROOT/server.log" 2>&1 &
PID=$!
code=
for _ in $(seq 1 240); do
  code=$(curl -s -o /dev/null -m 2 -w '%{http_code}' "http://127.0.0.1:$PORT/" || true)
  [ "$code" = 200 ] && break
  kill -0 "$PID" 2> /dev/null || { tail -20 "$ROOT/server.log"; die "the console ended before it answered"; }
  sleep 0.5
done
[ "$code" = 200 ] || { tail -20 "$ROOT/server.log"; die "GET / did not answer 200 in 120 s (last: $code)"; }
say "✔ GET / = 200 after $((SECONDS - T0)) s"

# The health check of the format, section 8.
PAGE=$ROOT/page.html
curl -s -m 10 -o "$PAGE" "http://127.0.0.1:$PORT/"
grep -qF "$COMMIT" "$PAGE" || die "the page does not hold the build id $COMMIT"
say "✔ the page holds the build id (the commit)"
n=0
while IFS= read -r p; do
  c=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "http://127.0.0.1:$PORT$p")
  [ "$c" = 200 ] || die "$p answered $c"
  n=$((n + 1))
done < <(grep -oE '/_next/static/[^"'"'"' <>\\)]+' "$PAGE" | sort -u)
[ "$n" -gt 0 ] || die "the page names no /_next/static file"
say "✔ the $n /_next/static files that the page names answer 200"
V=$(curl -s -m 10 -w '\n%{http_code}' "http://127.0.0.1:$PORT/api/version")
VCODE=${V##*$'\n'} VBODY=${V%$'\n'*}
if [ "$VCODE" = 200 ]; then
  python3 -I -c 'import json,sys; v=json.loads(sys.argv[1]); assert v["version"]==int(sys.argv[2]) and v["commit"]==sys.argv[3] and v["kind"]=="release", v' "$VBODY" "$VERSION" "$COMMIT" \
    || die "GET /api/version is not the index's: $VBODY"
  say "✔ GET /api/version = version $VERSION, commit ${COMMIT:0:12}, kind release"
else
  say "✖ GET /api/version answered $VCODE: $VBODY"
  VFAIL=1
fi
if grep -q '\[deploy\] off: this console runs a release' "$ROOT/server.log"; then say "✔ the log: [deploy] off: this console runs a release"
else say "  (no [deploy] line in the log: $(grep -c '\[deploy\]' "$ROOT/server.log") deploy lines)"; fi

if [ "$TRACE" = 1 ]; then
  say "→ what the console ran (execve, by program):"
  grep -oE 'execve\("[^"]+"' "$ROOT/trace.txt" | sed 's/execve("//; s/"$//' | sed "s#$ROOT#<root>#" | sort | uniq -c | sort -rn | head -15
  say "→ where it connected (connect, by address):"
  grep -oE 'connect\([0-9]+, \{sa_family=AF_[A-Z0-9]+, (sun_path="[^"]*"|sin_port=htons\([0-9]+\), sin_addr=inet_addr\("[^"]+"\)|sin6_port=htons\([0-9]+\)[^}]*inet_pton\(AF_INET6, "[^"]+")' "$ROOT/trace.txt" \
    | sed -E 's/connect\([0-9]+, \{sa_family=//; s/sun_path="[^"]*"/(a unix socket)/' | sed "s#$ROOT#<root>#" | sort | uniq -c | sort -rn | head -15
fi

if [ "$STAY" = 1 ]; then
  say ""
  say "The console stays: http://127.0.0.1:$PORT/ (folder $ROOT)."
  say "Stop it: kill -TERM -- -$PID; rm -rf -- $ROOT"
fi
[ -z "${VFAIL:-}" ] || exit 1
say "✔ The release starts and passes the health check."
