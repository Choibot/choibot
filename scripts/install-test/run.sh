#!/usr/bin/env bash
# scripts/install-test/run.sh — run install.sh for real in a throwaway folder, on a machine
# that may run a live console under the same Linux user. Nothing of that console is touched:
#   - the test has its own HOME (<root>/home), its own port and its own temp dir;
#   - it starts with an EMPTY environment (env -i): no key of the caller's shell, no address of
#     the real service manager;
#   - its PATH holds only <root>/fakebin (fake systemctl, loginctl, sudo, tailscale, curl, id,
#     journalctl) and <root>/sysbin (links to the tools of /usr/bin, WITHOUT systemctl,
#     loginctl, sudo, tailscale, crontab and their kind). The real ones cannot be reached.
#   - the fake systemctl runs the console as a plain process of this test, with the same PATH.
#
#   run.sh new <root> [--warm <other root>]   make the root (/tmp/choibot-it-<name>)
#   run.sh install <root> [KEY=value …]       run install.sh in it, in a terminal of its own
#   run.sh cli <root> <command…>              the installed command, e.g. `cli <root> doctor`
#   run.sh sh <root> '<shell text>'           a shell line in the root's environment
#   run.sh set <root> <name> [value]          a mode of a fake (state/<name>); no value = remove
#   run.sh down <root>                        stop every process of the root
#   run.sh snapshot                           the real user's units and data dirs, to compare
#                                             before and after a test (read only)
#
# KEY=value for `install`: CHOIBOT_SOURCE (default: a git copy of this checkout, <root>/src),
# CHOIBOT_PORT (default 4310), CHOIBOT_HOME, TTY=0 (no terminal: a pipe), ENTER=1 (the
# person presses Enter one time), and ANSWER='<text>=><keys>' (the person types <keys> and
# Enter when <text> shows; give it more than one time for more questions: person.py).
set -euo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
FAKES=$REPO/scripts/install-test/fakes
CACHE=/tmp/choibot-it-cache
# The tools of the real system that a test must never reach.
DENY=" systemctl loginctl journalctl systemd-run busctl sudo su pkexec doas tailscale tailscaled crontab at claude codex gh dtach id uname curl node npm npx pnpm corepack docker "

die() { echo "[install-test] $*" >&2; exit 1; }

ROOT=
set_root() {
  local r=${1%/}
  [[ $r =~ ^/tmp/choibot-it-[A-Za-z0-9]+$ ]] || die "refusing root '$1': it must be /tmp/choibot-it-<name>"
  [ "$r" != "$CACHE" ] || die "refusing root '$r': it is the cache"
  [ ! -L "$r" ] || die "refusing root '$r': it is a symlink"
  if [ -e "$r" ] && { [ ! -d "$r" ] || [ ! -O "$r" ]; }; then die "refusing root '$r': not a directory of $(id -un)"; fi
  ROOT=$r
}

# The environment of everything a test runs. Nothing of the caller's shell is in it.
# <root>/state/shell-env: more KEY=value lines for it, for a test that needs one (the path test:
# its guard against a connection outside the test).
in_root() {
  local more=() line
  if [ -f "$ROOT/state/shell-env" ]; then
    while IFS= read -r line || [ -n "$line" ]; do case $line in '' | \#*) ;; *=*) more+=("$line") ;; esac; done <"$ROOT/state/shell-env"
  fi
  env -i HOME="$ROOT/home" USER="$(id -un)" LOGNAME="$(id -un)" SHELL=/bin/sh TERM=xterm LANG=C.UTF-8 \
    TMPDIR="$ROOT/tmp" PATH="$ROOT/fakebin:$ROOT/sysbin" GIT_CONFIG_NOSYSTEM=1 \
    SSH_CONNECTION="198.51.100.7 50022 203.0.113.7 22" ${more[@]+"${more[@]}"} "$@"
}

cmd_new() {
  [ ! -e "$ROOT" ] || die "$ROOT exists: use a new name, or remove it after \`down\`"
  mkdir -p "$ROOT"/{home,tmp,state,fakebin,sysbin,fakes} "$CACHE"
  echo "$REPO" >"$ROOT/state/repo"
  echo "$CACHE" >"$ROOT/state/cache-dir"
  : >"$ROOT/state/calls.log"
  : >"$ROOT/state/sudo.log"
  local f name
  for f in "$FAKES"/*; do
    name=$(basename "$f")
    case $name in
      _lib.sh) cp "$f" "$ROOT/fakebin/" ;;
      claude) cp "$f" "$ROOT/fakes/claude" ;;   # on the PATH only after the fake installer ran
      *) cp "$f" "$ROOT/fakebin/$name" ;;
    esac
  done
  for f in /usr/bin/*; do
    name=$(basename "$f")
    [[ $DENY == *" $name "* ]] || ln -s "$f" "$ROOT/sysbin/$name"
  done
  # dtach stands for the system package: the test adds or leaves it out with `set tools`.
  local dtach
  dtach=$(command -v dtach || true)
  [ -n "$dtach" ] && ln -s "$(readlink -f "$dtach")" "$ROOT/sysbin/dtach"
  # The code to install: this checkout as it is now (tracked and new files), as a git repo.
  mkdir "$ROOT/src"
  (cd "$REPO" && git ls-files -co --exclude-standard -z | xargs -0 cp --parents -t "$ROOT/src")
  (cd "$ROOT/src" && in_root git init -q -b main && in_root git add -A \
    && in_root git -c user.name=test -c user.email=test@example.invalid commit -q -m "the code under test")
  if [ "${1:-}" = --warm ] && [ -d "${2:-}/home/.local/share/pnpm" ]; then
    mkdir -p "$ROOT/home/.local/share"
    cp -al "$2/home/.local/share/pnpm" "$ROOT/home/.local/share/pnpm"
  fi
  echo "$ROOT"
}

need_root_dir() { [ -d "$ROOT/state" ] || die "$ROOT is not a test root: run \`new\` first"; }

cmd_install() {
  need_root_dir
  local vars=() tty=1 keys= kv answers=()
  for kv in "$@"; do
    case $kv in
      TTY=0) tty=0 ;;
      ENTER=1) keys='\n' ;;   # the person presses Enter one time (the install agent asks for it)
      ANSWER=*) answers+=(--answer "${kv#ANSWER=}") ;;
      CHOIBOT_*=*) vars+=("$kv") ;;
      *) die "install: unknown argument '$kv'" ;;
    esac
  done
  [[ " ${vars[*]-} " == *" CHOIBOT_SOURCE="* ]] || vars+=("CHOIBOT_SOURCE=$ROOT/src")
  [[ " ${vars[*]-} " == *" CHOIBOT_PORT="* ]] || vars+=("CHOIBOT_PORT=4310")
  cp "$REPO/install.sh" "$ROOT/install.sh"
  if [ ${#answers[@]} -gt 0 ]; then
    # A person who answers the questions of the install by what the terminal shows.
    in_root "${vars[@]}" python3 "$REPO/scripts/install-test/person.py" "${answers[@]}" -- sh "$ROOT/install.sh"
  elif [ "$tty" = 1 ]; then
    # A terminal of its own, as a person has: `script` gives the child a pty.
    # shellcheck disable=SC2059
    printf "$keys" | in_root "${vars[@]}" script -qefc "sh $ROOT/install.sh" /dev/null
  else
    in_root "${vars[@]}" sh "$ROOT/install.sh" </dev/null 2>&1 | cat
  fi
}

cmd_cli() {
  need_root_dir
  local q home=$ROOT/home
  q=$(printf '%q ' "$home/choibot/bin/choibot" "$@")
  in_root script -qefc "$q" /dev/null </dev/null
}

cmd_sh() { need_root_dir; in_root sh -c "$1"; }

cmd_set() {
  need_root_dir
  [[ ${1:-} =~ ^[a-z][a-z-]*$ ]] || die "set: a name like 'linger'"
  case $1 in
    tools)   # tools none | all: the system package dtach is there or not
      if [ "${2:-all}" = none ]; then rm -f "$ROOT/sysbin/dtach"
      else ln -sf "$(readlink -f "$(command -v dtach)")" "$ROOT/sysbin/dtach"; fi ;;
    tailscale)
      if [ "${2:-}" = none ]; then rm -f "$ROOT/fakebin/tailscale" "$ROOT/state/tailscale"
      else cp "$FAKES/tailscale" "$ROOT/fakebin/tailscale"; echo "$2" >"$ROOT/state/tailscale"; fi ;;
    *) if [ $# -ge 2 ]; then echo "$2" >"$ROOT/state/$1"; else rm -f "$ROOT/state/$1"; fi ;;
  esac
}

# Every process of the root: the ones that carry its HOME in their environment. Never by a
# name pattern: a live console on this machine is also a `tsx server/index.ts` process.
cmd_down() {
  need_root_dir
  local p pids=()
  for p in /proc/[0-9]*; do
    # Only this user's own processes can be read; the others give nothing.
    if cat "$p/environ" 2>/dev/null | tr '\0' '\n' | grep -qx "HOME=$ROOT/home"; then pids+=("${p#/proc/}"); fi
  done
  [ ${#pids[@]} -eq 0 ] || kill -TERM "${pids[@]}" 2>/dev/null || true
  sleep 1
  for p in "${pids[@]-}"; do [ -z "$p" ] || kill -KILL "$p" 2>/dev/null || true; done
  rm -f "$ROOT"/state/*.pid
  echo "[install-test] stopped ${#pids[@]} process(es) of $ROOT"
}

# Read only. The lists a test must leave as they were.
cmd_snapshot() {
  echo "== ~/.config/systemd/user"
  find "$HOME/.config/systemd/user" -printf '%y %m %s %TY-%Tm-%Td %TT %P\n' 2>/dev/null | sort -k6
  echo "== systemctl --user list-unit-files"
  systemctl --user list-unit-files --no-pager --no-legend 2>&1 | sort
  echo "== ~/.local/share (top level)"
  find "$HOME/.local/share" -maxdepth 1 -printf '%y %m %u %P\n' | sort -k4
  echo "== crontab -l"
  crontab -l 2>&1 || true
}

case ${1:-} in
  snapshot) cmd_snapshot ;;
  new | install | cli | sh | set | down)
    [ $# -ge 2 ] || die "usage: run.sh $1 <root> …"
    c=$1
    set_root "$2"
    shift 2
    "cmd_$c" "$@" ;;
  *) sed -n '2,24p' "${BASH_SOURCE[0]}" >&2; exit 2 ;;
esac
