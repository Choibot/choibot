#!/usr/bin/env bash
# scripts/chief-fake-claude.sh — the `claude` of the isolated chief instance
# (scripts/chief-instance.sh copies it to <root>/bin/claude; spec §15 "fake
# agent whose TUI is a dtach'd script"). Per launch <n> (1, 2, … per agent):
#   $CHIEF_FAKE_LOG/<who>.argv.<n>  its argv, NUL-separated
#   $CHIEF_FAKE_LOG/<who>.env.<n>   its CHOIBOT_* or CHOIBOT_* env lines (empty with the flag off)
# where <who> is $CHOIBOT_AGENT_ID or $CHOIBOT_AGENT_ID, or pid<pid> when the env has no identity.
# It takes the session id from `--resume <sid>` (else fake-<pid>), writes the
# transcript where canResume looks for it (so the next launch resumes), posts
# SessionStart to the hook URL of its --settings file, turns bracketed paste
# on like the real TUI, then appends each input line to <who>.input.
#
# With -p (the distill child, server/chief/brain/distill.ts) it reads stdin and
# prints one `--output-format json` envelope: for the self-test prompt
# ("List the tools you can call") `result` is $CHIEF_FAKE_SELFTEST (default
# NONE), for any other prompt the content of the file $CHIEF_FAKE_DISTILL as
# a JSON string. The distill child gets only an env allowlist, so these knobs
# and CHIEF_FAKE_LOG come from <this dir>/../fake-claude.env (KEY=VALUE lines,
# written by chief-instance.sh up/restart); env vars are the fallback. With a
# log dir it writes print.argv.<n> and print.env.<n> there.
#
# With -p and --system-prompt it is the model of the guide (server/guide/model.ts): `result`
# is the content of the file $CHIEF_FAKE_GUIDE (default: one fixed line), and with a log dir
# its stdin goes to print.stdin.<n>. $CHIEF_FAKE_GUIDE_FAIL=login|limit|limit:<epoch seconds>|down
# gives the error envelope of that kind and exit 1 (limit:<epoch>: the plan comes back then). Both knobs come from fake-claude.env, read at each call.
set -euo pipefail

# `claude --version`: the console asks for it before its first usage read (server/usage.ts).
case ${1:-} in --version | -v) echo "2.1.203 (Claude Code)"; exit 0 ;; esac
# `claude auth logout` ("Sign out" in Settings, server/agents/claudelogout.ts): as Claude Code, it
# removes the login of its config folder (the credentials file and the account of .claude.json).
# `auth login` (the sign-in of the page, server/agents/claudelogin.ts) prints a made-up link and
# takes any code: it writes a made-up credentials file. `auth status` reads that file.
dir=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
case "${1:-} ${2:-}" in
  "auth logout") rm -f "$dir/.credentials.json"; echo "Successfully logged out from your Anthropic account."; exit 0 ;;
  "auth status")
    if [ -f "$dir/.credentials.json" ]; then echo '{"loggedIn":true,"email":null}'; exit 0; fi
    echo '{"loggedIn":false}'; exit 1 ;;
  "auth login")
    echo "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=fake-instance"
    printf 'Paste code here if prompted > '
    IFS= read -r code || exit 1
    [ -n "$code" ] || exit 1
    mkdir -p "$dir"; printf '{"claudeAiOauth":{"accessToken":"fake-instance-token"}}' > "$dir/.credentials.json"
    echo "Login successful."; exit 0 ;;
esac

print_mode=0 guide_mode=0
for a in "$@"; do
  case $a in
    -p | --print) print_mode=1 ;;
    --system-prompt) guide_mode=1 ;;
  esac
done
if [ $print_mode = 1 ]; then
  conf="$(dirname "${BASH_SOURCE[0]}")/../fake-claude.env"
  if [ -f "$conf" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      case $line in
        CHIEF_FAKE_DISTILL=*) CHIEF_FAKE_DISTILL=${line#*=} ;;
        CHIEF_FAKE_SELFTEST=*) CHIEF_FAKE_SELFTEST=${line#*=} ;;
        CHIEF_FAKE_LOG=*) CHIEF_FAKE_LOG=${line#*=} ;;
        CHIEF_FAKE_GUIDE=*) CHIEF_FAKE_GUIDE=${line#*=} ;;
        CHIEF_FAKE_GUIDE_FAIL=*) CHIEF_FAKE_GUIDE_FAIL=${line#*=} ;;
      esac
    done <"$conf"
  fi
  if [ -n "${CHIEF_FAKE_LOG:-}" ] && [ -d "$CHIEF_FAKE_LOG" ]; then
    n=1
    while ! { set -C; : >"$CHIEF_FAKE_LOG/print.argv.$n"; } 2>/dev/null; do
      n=$((n + 1))
      ((n <= 10000)) || { echo "fake claude: no free print.argv.<n> up to 10000" >&2; exit 1; }
    done
    set +C
    printf '%s\0' "$@" >"$CHIEF_FAKE_LOG/print.argv.$n"
    env >"$CHIEF_FAKE_LOG/print.env.$n"
  fi
  prompt=$(cat)
  if [ $guide_mode = 1 ]; then
    if [ -n "${CHIEF_FAKE_LOG:-}" ] && [ -d "$CHIEF_FAKE_LOG" ]; then printf '%s' "$prompt" >"$CHIEF_FAKE_LOG/print.stdin.$n"; fi
    case ${CHIEF_FAKE_GUIDE_FAIL:-} in
      login) echo '{"type":"result","is_error":true,"result":"Not logged in · Please run /login"}'; exit 1 ;;
      limit) echo '{"type":"result","is_error":true,"result":"You have hit your session limit"}'; exit 1 ;;
      limit:*) printf '{"type":"result","is_error":true,"result":"Claude AI usage limit reached|%s"}\n' "${CHIEF_FAKE_GUIDE_FAIL#limit:}"; exit 1 ;;
      down) echo '{"type":"result","is_error":true,"result":"API Error: 529 overloaded"}'; exit 1 ;;
    esac
    if [ -n "${CHIEF_FAKE_GUIDE:-}" ] && [ -f "$CHIEF_FAKE_GUIDE" ]; then
      exec python3 -c 'import json,sys;print(json.dumps({"type":"result","result":open(sys.argv[1]).read()}))' "$CHIEF_FAKE_GUIDE"
    fi
    echo '{"type":"result","result":"This is the fake guide of the test instance."}'
    exit 0
  fi
  if [[ $prompt == *"List the tools you can call"* ]]; then
    python3 -c 'import json,sys;print(json.dumps({"type":"result","result":sys.argv[1]}))' "${CHIEF_FAKE_SELFTEST:-NONE}"
    exit 0
  fi
  out=${CHIEF_FAKE_DISTILL:-}
  [ -n "$out" ] || { echo "fake claude: CHIEF_FAKE_DISTILL is not set (in $conf or the env)" >&2; exit 1; }
  [ -f "$out" ] || { echo "fake claude: CHIEF_FAKE_DISTILL=$out is not a file" >&2; exit 1; }
  exec python3 -c 'import json,sys;print(json.dumps({"type":"result","result":open(sys.argv[1]).read()}))' "$out"
fi

log=${CHIEF_FAKE_LOG:?CHIEF_FAKE_LOG is not set}
[ -d "$log" ] || { echo "fake claude: CHIEF_FAKE_LOG=$log is not a directory" >&2; exit 1; }
who=${CHOIBOT_AGENT_ID:-${CHOIBOT_AGENT_ID:-pid$$}}

# The first free launch number; noclobber makes the claim atomic.
n=1
while ! { set -C; : >"$log/$who.argv.$n"; } 2>/dev/null; do
  n=$((n + 1))
  ((n <= 10000)) || { echo "fake claude: no free $log/$who.argv.<n> up to 10000" >&2; exit 1; }
done
set +C
printf '%s\0' "$@" >"$log/$who.argv.$n"
env | grep -E '^(CHOIBOT|CHOIBOT)_' >"$log/$who.env.$n" || true

sid= settings=
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  case ${args[i]} in
    --resume) sid=${args[i + 1]:-} ;;
    --settings) settings=${args[i + 1]:-} ;;
  esac
done
sid=${sid:-fake-$$}

# claudeTranscriptPath: ~/.claude/projects/<cwd, every / and . -> ->/<sid>.jsonl
project=$(pwd | tr '/.' '--')
mkdir -p "$HOME/.claude/projects/$project"
printf '{"type":"fake-claude","sessionId":"%s","launch":%d}\n' "$sid" "$n" \
  >>"$HOME/.claude/projects/$project/$sid.jsonl"

# The hook URL buildHookSettings wrote: http://127.0.0.1:<port>/api/agents/<id>/hook?token=…
url=
if [ -n "$settings" ] && [ -f "$settings" ]; then
  url=$(grep -oE 'http://127\.0\.0\.1:[0-9]+/api/agents/[^/"\\]+/hook\?token=[^"\\[:space:]]+' "$settings" | head -n 1 || true)
fi
case $url in http://127.0.0.1:3100/*) url= ;; esac # never the live console
if [ -n "$url" ]; then
  curl -s -m 10 -o /dev/null -X POST "$url" -H 'content-type: application/json' \
    --data-binary "{\"hook_event_name\":\"SessionStart\",\"session_id\":\"$sid\",\"source\":\"startup\"}" || true
fi

# No echo, like the raw-mode TUI: an echoed paste would count as output and
# hold the console's 10 s output guard on relaunch. Off before the paste-ready
# signal, so no paste can arrive while echo is still on.
stty -echo 2>/dev/null || true
printf '\033[?2004h'
while IFS= read -r line || [ -n "$line" ]; do
  printf '%s\n' "$line" >>"$log/$who.input"
done
