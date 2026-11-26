#!/usr/bin/env bash
# scripts/install-test/release-layout.sh — the proof of the release layout (server/layout.ts) on one
# release, in the install harness (run.sh: env -i, its own HOME and port, fakes for the system):
#   1. a fresh install from the release (CHOIBOT_RELEASE, with its index);
#   2. the settings file is <home>/console.env (0600), app/ has no .env, the unit reads console.env;
#   3. app/ holds exactly the release's app/ entries: no file that the install, the set-up or the
#      console wrote;
#   4. app/ made read-only (chmod -R a-w), the console restarted: it answers, a paired device reads
#      and writes (a code of "Add a device"), no write error in its log, and app/ is still exactly
#      the release's.
#
#   scripts/install-test/release-layout.sh <folder with index.json and the release tar> [<name>]
#
# It uses the root /tmp/choibot-it-<name> (default: layout) and removes it at the end.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
RUN=$HERE/run.sh
REL=$(cd "${1:?give the release folder}" && pwd)
ROOT=/tmp/choibot-it-${2:-layout}
PORT=4310
fail() { echo "✖ $*" >&2; exit 1; }
ok() { echo "✔ $*"; }

file=$(sed -n 's/^  "file": "\(.*\)",$/\1/p' "$REL/index.json")
[ -n "$file" ] && [ -f "$REL/$file" ] || fail "no release tar named by $REL/index.json"
[ ! -e "$ROOT" ] || fail "$ROOT exists: remove it first (after: $RUN down $ROOT)"
# The test install's folder: the harness HOME, then the install line's default folder name.
THOME=$ROOT/home
H=$THOME/choibot
WORK=$(mktemp -d)
cleanup() { chmod -R u+w "$H/app" 2>/dev/null || true; "$RUN" down "$ROOT" >/dev/null 2>&1 || true; rm -rf "$ROOT" "$WORK"; }
trap cleanup EXIT

"$RUN" new "$ROOT" >/dev/null
mkdir "$ROOT/rel"
cp -l "$REL/index.json" "$REL/$file" "$ROOT/rel/" 2>/dev/null || cp "$REL/index.json" "$REL/$file" "$ROOT/rel/"

# 1. the install
"$RUN" install "$ROOT" TTY=0 "CHOIBOT_RELEASE=$ROOT/rel/$file" "CHOIBOT_RELEASE_INDEX=$ROOT/rel/index.json" >"$WORK/install.txt" 2>&1 \
  || { tail -20 "$WORK/install.txt"; fail "the install failed"; }
ok "the install from the release ($(grep -c . "$WORK/install.txt") lines)"

# 2. the settings file and the unit
[ -f "$H/console.env" ] || fail "no $H/console.env"
[ "$(stat -c %a "$H/console.env")" = 600 ] || fail "console.env is not 0600"
[ ! -e "$H/app/.env" ] || fail "app/.env exists"
grep -q '^CHIEF_ENABLED=1$' "$H/console.env" || fail "console.env has not the settings of a new install (CHIEF_ENABLED)"
grep -qx "EnvironmentFile=$H/console.env" "$THOME/.config/systemd/user/choibot.service" || fail "the unit does not read console.env"
ok "the settings: $H/console.env (0600), no app/.env, the unit reads it"

# 3. app/ is the release's app/
tar -tzf "$ROOT/rel/$file" | sed 's#/$##' | grep -E '^app(/|$)' | sort >"$WORK/tar-app.txt"
same_app() {
  (cd "$H" && find app | sort) >"$WORK/app.txt"
  local more less
  more=$(comm -13 "$WORK/tar-app.txt" "$WORK/app.txt" | head -5)
  less=$(comm -23 "$WORK/tar-app.txt" "$WORK/app.txt" | head -5)
  [ -z "$more" ] || fail "app/ holds what the release has not ($1): $more"
  [ -z "$less" ] || fail "app/ lacks entries of the release ($1): $less"
}
same_app "after the install"
ok "app/ holds exactly the release's $(grep -c . "$WORK/tar-app.txt") entries"

# A paired device (the first one: the box code)
code=$("$RUN" cli "$ROOT" pair 2>&1 | grep -oE '[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}' | head -1)
[ -n "$code" ] || fail "no pairing code"
token=$(curl -s -m 10 -X POST -H 'content-type: application/json' -d "{\"code\":\"$code\",\"label\":\"proof\"}" "http://127.0.0.1:$PORT/api/chief/pair/first" \
  | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["token"])') || fail "the pairing failed"
ok "a device is paired"
same_app "after the pairing"

# 4. app/ read-only, a restart
chmod -R a-w "$H/app"
log=$ROOT/state/choibot.log
before=$(wc -l <"$log")
"$RUN" sh "$ROOT" 'systemctl --user restart choibot.service' >/dev/null
code=
for _ in $(seq 1 90); do
  code=$(curl -s -o /dev/null -m 2 -w '%{http_code}' "http://127.0.0.1:$PORT/" || true)
  [ "$code" = 200 ] && break
  sleep 1
done
[ "$code" = 200 ] || fail "the console does not answer after the restart with app/ read-only (GET / = $code)"
for u in /api/version /api/agents /api/setup/steps /api/queue; do
  c=$(curl -s -o /dev/null -m 10 -H "x-choibot-user: $token" -w '%{http_code}' "http://127.0.0.1:$PORT$u")
  [ "$c" = 200 ] || fail "GET $u = $c with app/ read-only"
done
c=$(curl -s -o /dev/null -m 10 -X POST -H "x-choibot-user: $token" -H 'content-type: application/json' -d '{}' -w '%{http_code}' "http://127.0.0.1:$PORT/api/chief/devices/add")
[ "$c" = 200 ] || fail "a write (Add a device) = $c with app/ read-only"
if tail -n +"$((before + 1))" "$log" | grep -qiE 'EACCES|EROFS|EPERM|read-only file'; then
  tail -n +"$((before + 1))" "$log" | grep -iE 'EACCES|EROFS|EPERM|read-only file' | head -5 >&2
  fail "write errors in the console's log with app/ read-only"
fi
same_app "after the run with app/ read-only"
ok "app/ read-only: the console restarts, answers, reads and writes; no write error; app/ unchanged"
echo "✔ The release layout holds on $file."
