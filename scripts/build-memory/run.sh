#!/usr/bin/env bash
# scripts/build-memory/run.sh — measures the memory of the build of an install (`pnpm install`,
# then `pnpm build` as bin/lib/steps.ts runs it) on a server with 1914 MB of memory, no swap and
# 1 vCPU (a Hetzner cpx12, the server of the hosted image), and fails when the build comes near
# a limit again. It needs no server: it makes the limit on this machine.
#
#   scripts/build-memory/run.sh [--rev <commit>] [--with-tsc]
#
#   --rev       the commit to measure (default: HEAD of this checkout)
#   --with-tsc  also measure `tsc --noEmit -p .` (the deploy runner's check; not a step of an
#               install, so for information only)
#   PNPM=<path> the pnpm to use (default: pnpm on PATH)
#
# How it makes the server:
#   - each step runs in its own scope of the systemd user manager: MemoryMax=1914M,
#     MemorySwapMax=0. Node 24 takes its heap limit from the cgroup: V8's old space is half of
#     the memory (957 MB), heap_size_limit 1053 MB, as on the server;
#   - 1 CPU (taskset), and os.cpus() gives 1 CPU (preload.cjs): Next sizes its workers from it;
#   - a clean env like the one of the image build (no NODE_OPTIONS of this machine).
# It builds a throwaway worktree that it removes at the end, never this checkout, and only one
# run at a time (a lock).
#
# The two limits (exit 1 when one is over):
#   1. the largest heap of a process of the build > 70 % of V8's old space (957 MB): 669 MB;
#   2. the anon peak of the build + 300 MB for the system of the server > 80 % of 1914 MB: 1531 MB.
# Exit 0: both limits pass. Exit 1: a limit is over, or the build failed. Exit 2: no measure.
set -u

MEM_MB=1914
SYSTEM_MB=300          # used by the server's system during a build (idle samples of 2026-11-25)
HEAP_PCT=70
TOTAL_PCT=80
HEAP_MB=$((MEM_MB / 2))                       # V8: old space = memory / 2 on 64-bit
HEAP_LIMIT=$((HEAP_MB * HEAP_PCT / 100))
TOTAL_LIMIT=$((MEM_MB * TOTAL_PCT / 100))

HERE=$(cd "$(dirname "$0")" && pwd)

# ------------------------------------------------------------------ in the scope
# run.sh --inner <outdir> <cmd...>: samples the scope's memory each 0.5 s while the command runs.
if [ "${1:-}" = --inner ]; then
  out=$2; shift 2
  cg=/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup)
  (
    while :; do
      anon=$(awk '$1 == "anon" {print $2}' "$cg/memory.stat")
      big=0; bign=
      for p in $(cat "$cg/cgroup.procs"); do
        r=$(awk '/^VmRSS:/ {print $2}' "/proc/$p/status" 2>/dev/null)
        [ -n "$r" ] || continue
        if [ "$r" -gt "$big" ]; then big=$r; bign=$(cat "/proc/$p/comm" 2>/dev/null); fi
      done
      echo "$((anon >> 20)) $((big >> 10)) $bign"
      sleep 0.5
    done
  ) >"$out/samples" 2>/dev/null &
  sampler=$!
  start=$(date +%s)
  "$@" >"$out/log" 2>&1
  code=$?
  kill "$sampler" 2>/dev/null
  wait "$sampler" 2>/dev/null
  {
    echo "exit=$code"
    echo "seconds=$(($(date +%s) - start))"
    echo "max=$(cat "$cg/memory.max")"
    echo "peak=$(($(cat "$cg/memory.peak") >> 20))"
    echo "oom_kill=$(awk '$1 == "oom_kill" {print $2}' "$cg/memory.events")"
  } >"$out/result"
  exit "$code"
fi

# ------------------------------------------------------------------ outside
REV=HEAD
WITH_TSC=0
while [ $# -gt 0 ]; do
  case "$1" in
    --rev) REV=${2:?--rev needs a commit}; shift 2 ;;
    --with-tsc) WITH_TSC=1; shift ;;
    *) echo "usage: $0 [--rev <commit>] [--with-tsc]" >&2; exit 2 ;;
  esac
done

no() { echo "build-memory: $*" >&2; exit 2; }

REPO=$(git -C "$HERE" rev-parse --show-toplevel) || no "not in a git checkout"
COMMIT=$(git -C "$REPO" rev-parse --verify "$REV^{commit}") || no "no commit $REV"
PNPM=${PNPM:-$(command -v pnpm)} || true
[ -x "${PNPM:-}" ] || no "no pnpm (give one with PNPM=<path>)"
NODE=$(command -v node) || no "no node on PATH"
for tool in systemd-run taskset flock git; do command -v "$tool" >/dev/null || no "the tool $tool is missing"; done
CPU=${CPU:-$(($(nproc) - 1))}

# One run at a time on this machine: a second run does not wait, it stops.
exec 9>"${XDG_RUNTIME_DIR:-/tmp}/build-memory.lock"
flock -n 9 || no "another measure runs on this machine; run this one after it"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/build-memory.XXXXXX")
APP=$WORK/app
cleanup() {
  git -C "$REPO" worktree remove --force "$APP" >/dev/null 2>&1
  rm -rf "$WORK"
  git -C "$REPO" worktree prune >/dev/null 2>&1
}
trap cleanup EXIT
trap 'exit 2' INT TERM
git -C "$REPO" worktree add --quiet --detach "$APP" "$COMMIT" || no "cannot make the throwaway worktree"

# measure <name> <cmd...>: one step in its own scope. Its files: $WORK/<name>/.
measure() {
  name=$1; shift
  out=$WORK/$name
  mkdir -p "$out/heap"
  (cd "$APP" && systemd-run --user --scope --quiet --unit="build-memory-$name-$$" \
    -p MemoryMax="${MEM_MB}M" -p MemorySwapMax=0 \
    taskset -c "$CPU" \
    env -i HOME="$HOME" USER="${USER:-$(id -un)}" LOGNAME="${USER:-$(id -un)}" LANG=C.UTF-8 \
      XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-}" NEXT_TELEMETRY_DISABLED=1 \
      PATH="$(dirname "$PNPM"):$(dirname "$NODE"):/usr/local/bin:/usr/bin:/bin" \
      NODE_OPTIONS="--require=$HERE/preload.cjs" BUILD_MEMORY_HEAP_DIR="$out/heap" \
      ${STEP_ENV:-} \
    bash "$HERE/run.sh" --inner "$out" "$@")
}

# The numbers of a step, as KEY=VALUE lines.
numbers() {
  out=$WORK/$1
  [ -f "$out/result" ] || return 1
  cat "$out/result"
  awk 'BEGIN {a = 0; r = 0} {if ($1 > a) a = $1; if ($2 > r) {r = $2; n = $3}} END {printf "anon=%d\nrss=%d\nrss_of=%s\n", a, r, n}' "$out/samples"
  # The heap of each process: the larger of the sampled peak (its file) and of the heap before
  # each GC (the trace lines "[pid:0x…]  123 ms: Mark-Compact 951.4 (961.2) -> …" in the log).
  {
    for f in "$out/heap"/*; do [ -f "$f" ] && echo "file $(basename "$f") $(cat "$f")"; done
    grep -aoE '\[[0-9]+:0x[0-9a-f]+\] +[0-9]+ ms: [A-Za-z (),-]*[0-9.]+ \([0-9.]+\) ->' "$out/log" |
      sed -E 's/^\[([0-9]+):.* ([0-9.]+) \([0-9.]+\) ->$/gc \1 \2/'
  } | awk '$1 == "file" {p = $2; if ($3 > h[p]) h[p] = $3; l[p] = $4; c[p] = $5}
           $1 == "gc" {p = $2; if ($3 > h[p]) h[p] = $3}
           END {for (p in h) if (h[p] > m) {m = h[p]; mp = p}
                for (p in l) if (l[p] > ml) ml = l[p]
                printf "heap=%.0f\nheap_limit=%s\nheap_of=%s\nlimit_max=%d\n", m, (mp in l) ? l[mp] : "?", (mp in c) ? c[mp] : "?", ml}'
}
get() { printf '%s\n' "$1" | awk -F= -v k="$2" '$1 == k {print $2}'; }

row() {
  n=$(numbers "$1") || { printf '%-8s no result\n' "$1"; return; }
  printf '%-8s %4s %6s s %9s MB %9s MB %9s MB %7s MB (limit %s MB, %s)\n' "$1" "$(get "$n" exit)" "$(get "$n" seconds)" \
    "$(get "$n" peak)" "$(get "$n" anon)" "$(get "$n" rss)" "$(get "$n" heap)" "$(get "$n" heap_limit)" "$(get "$n" heap_of)"
}

echo "build-memory: commit ${COMMIT:0:12}, scope of $MEM_MB MB (no swap), 1 CPU ($CPU)"
echo "  pnpm $("$PNPM" --version 2>/dev/null), node $("$NODE" --version)"

measure install "$PNPM" install --frozen-lockfile
inst=$(numbers install) || no "the install was not measured: $(tail -3 "$WORK/install/log" 2>/dev/null)"
[ "$(get "$inst" max)" = "$((MEM_MB << 20))" ] || no "the scope has no memory limit (memory.max is $(get "$inst" max)): the user manager needs the memory controller"
[ "$(get "$inst" exit)" = 0 ] || { grep -avE '^\[[0-9]+:0x[0-9a-f]+\] ' "$WORK/install/log" | tail -20; no "pnpm install failed"; }

# The build as setup and update run it (bin/lib/steps.ts): with the switch of server/buildcheck.mjs.
STEP_ENV=CHOIBOT_BUILD_NO_CHECK=1 measure build "$PNPM" build
build=$(numbers build) || no "the build was not measured"
if [ "$WITH_TSC" = 1 ]; then measure tsc node_modules/.bin/tsc --noEmit -p .; fi

echo ""
echo "step     exit   time      scope peak    anon peak  largest RSS  largest heap"
row install
row build
[ "$WITH_TSC" = 1 ] && row tsc
echo ""
echo "  scope peak: memory.peak of the step's scope (with page cache). anon peak: the most \"anon\""
echo "  of memory.stat (sampled each 0.5 s). largest RSS: of one process (sampled). largest heap:"
echo "  the most heap of one process (v8 used_heap_size each 0.2 s, and V8's GC trace), with its"
echo "  heap_size_limit. The install uses the pnpm store of this machine; a new server has none."
echo ""

fail=0
heap_mb=$(get "$build" heap); anon_mb=$(get "$build" anon)
if [ "$(get "$build" exit)" != 0 ]; then
  grep -avE '^\[[0-9]+:0x[0-9a-f]+\] ' "$WORK/build/log" | tail -30
  echo "FAIL: the build failed (exit $(get "$build" exit), oom_kill $(get "$build" oom_kill))"
  fail=1
fi
grep -q "type check and lint are off on purpose" "$WORK/build/log" || { echo "FAIL: the build did not say that Next's check is off"; fail=1; }
[ "${heap_mb:-0}" -gt 0 ] || no "no heap was measured (preload.cjs did not load)"
if [ "$(get "$build" limit_max)" -gt $((MEM_MB * 2 / 3)) ]; then
  no "Node's heap limit in the scope is $(get "$build" limit_max) MB, not about $((HEAP_MB + 96)) MB: the scope does not limit Node"
fi
total=$((anon_mb + SYSTEM_MB))
if [ "$heap_mb" -gt "$HEAP_LIMIT" ]; then v=FAIL; fail=1; else v=pass; fi
echo "limit 1: largest heap of the build $heap_mb MB, limit $HEAP_LIMIT MB ($HEAP_PCT % of $HEAP_MB MB) ... $v ($((heap_mb * 100 / HEAP_MB)) %)"
if [ "$total" -gt "$TOTAL_LIMIT" ]; then v=FAIL; fail=1; else v=pass; fi
echo "limit 2: anon peak $anon_mb MB + $SYSTEM_MB MB system = $total MB, limit $TOTAL_LIMIT MB ($TOTAL_PCT % of $MEM_MB MB) ... $v ($((total * 100 / MEM_MB)) %)"
exit "$fail"
