# scripts/install-test/fakes/_lib.sh — shared by the fakes of the install test (../run.sh).
# A fake finds its test root from its own place (<root>/fakebin/<name>), logs each call, and
# reads its mode from a file in <root>/state. It never runs the real tool.
SELF=$(readlink -f "$0")
ROOT=$(cd "$(dirname "$SELF")/.." && pwd -P)
STATE=$ROOT/state
case $ROOT in /tmp/choibot-it-*) ;; *) echo "fake $(basename "$0"): not inside a test root ($ROOT)" >&2; exit 97 ;; esac
printf '%s %s\n' "$(basename "$0")" "$*" >>"$STATE/calls.log"
# The mode of a fake: the content of <root>/state/<name>, or the default.
mode() { if [ -f "$STATE/$1" ]; then cat "$STATE/$1"; else printf '%s' "$2"; fi; }
