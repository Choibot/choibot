#!/bin/sh
# install.sh — the install line of ChoiBot: from a new Linux server to a console that runs.
#
#   CHOIBOT_SOURCE=<git address or archive file> sh install.sh
#   CHOIBOT_RELEASE=<release file> [CHOIBOT_RELEASE_INDEX=<its index.json>] sh install.sh
#
# It checks the server, puts ChoiBot and its OWN Node into one folder, gets Claude Code, runs the
# set-up that asks nothing, and ends with the address and the code for the first device. The
# Claude login is not here: the Set-up page of the console does it, in the browser.
#
# The rules of this script:
#   - It asks no question. One exception, and only when a step fails: the install agent needs a
#     Claude login, so it offers the login in this terminal. "No" (or Enter) goes on with no AI.
#   - Every step can run again. A second run repairs and never makes a second copy.
#   - It never runs sudo. For the few things only root can do, it shows the exact command, says
#     why, and goes on when its check passes.
#   - It never touches the Node of the system. Its Node is a pinned version with a pinned checksum.
#   - It writes only into ChoiBot's own folder, plus what the tools it starts write themselves
#     (the service file and the settings of `setup`, the login of Claude Code).
#
# What a caller can give (each one is optional but the first, for now):
#   CHOIBOT_SOURCE  where the code comes from: a git address that this server can reach, or an
#                   archive file (.tar.gz) on this server. The public address comes with the
#                   public release; until then there is no default.
#   CHOIBOT_RELEASE a release of ChoiBot that we built (scripts/release/build.sh, a .tar.gz with
#                   the code, its packages, its build, its Node and gh): the full path of the file
#                   on this server. Then there is no download of Node, pnpm or gh, no package
#                   install and no build. Not with CHOIBOT_SOURCE. Into a new folder only, on
#                   Ubuntu 24.04 x86-64 only (the system that a release is built for). No root and
#                   no signature here: a hosted server's root checks the signature first.
#                   A fresh release install has the release layout: its settings file is
#                   <folder>/console.env and its data are outside the code folder.
#   CHOIBOT_RELEASE_INDEX  the release's index.json: then the file's name, size and SHA-256 are
#                   checked against it before anything is unpacked.
#   CHOIBOT_HOME    ChoiBot's own folder. Default: ~/choibot.
#   CHOIBOT_PORT    where the search for a free port starts. Default: 3100.
#
# POSIX sh (dash, busybox). The names NAME and CLI are the ones of server/brand.ts
# (bin/lib/install.test.ts holds them equal).
set -eu

NAME=ChoiBot
CLI=choibot
CLI_SHORT=choi

# The Node of ChoiBot: one version, and the SHA-256 of its two archives as nodejs.org
# publishes them (https://nodejs.org/dist/v<version>/SHASUMS256.txt).
NODE_VERSION=24.22.3
NODE_SHA256_x64=061ec3e3062115705b56b51fa9cc330ab50d34b6969387d4e4b1a50c6809acc2
NODE_SHA256_arm64=261af2af250dfd7e9f25cf151d1b2713a0adf8f10a9ad116c4947f68627affe8
PNPM_VERSION=10.34.9
# The GitHub tool (gh), for a server that has none: one version, and the SHA-256 of its two
# archives as its release publishes them (gh_<version>_checksums.txt).
GH_VERSION=2.105.0
GH_SHA256_amd64=79e7ab5db738c48777b696e374f8b428f0647debfb424f44d2f426370407fe2f
GH_SHA256_arm64=b1278c75107423d818f1937fd92cafc9e5e9b606631568f68d7fb816f5885a02

# Below these the build or the console cannot work.
MIN_MEMORY_MB=1800
MIN_DISK_MB=3000
# How long the script waits for a command that only root can run.
ROOT_WAIT_S=900

say() { printf '%s\n' "$*"; }
ok() { say "  ✔ $*"; }
note() { say "  ○ $*"; }

# Stop: the first line says what is wrong, the next lines say what works. On an install that
# has its command, the failure is kept for the install agent, and the agent is named.
stop() {
  say ""
  say "✖ $1"
  if [ -x "${BASE:-}/bin/$CLI" ] && [ -f "$BASE/.installed-by-$CLI" ]; then
    { printf 'Step: %s\n' "${STEP:-the install}"; printf '%s\n' "$@"; tail -n 40 "$LOG" 2>/dev/null; } >"$BASE/failed-step.log"
    stop_agent="The install agent can look at this with you (it needs the Claude login): ${CMD:-$BASE/bin/$CLI} repair"
  fi
  shift
  for stop_line in "$@"; do say "  $stop_line"; done
  if [ -n "${stop_agent:-}" ]; then say "  $stop_agent"; fi
  exit 1
}

AGAIN="Then paste the install line again. It goes on where it stopped."

# ---------------------------------------------------------------- the server

# The part of an address that can hold a password is never printed.
shown() { printf '%s' "$1" | sed 's#://[^/@]*@#://#'; }

check_source() {
  ARCHIVE=no
  if [ -n "$RELEASE" ]; then check_release; return 0; fi
  if [ -f "$APP/package.json" ]; then return 0; fi
  if [ -z "$SOURCE" ]; then
    stop "This script does not know where to get $NAME from." \
      "The public download address comes with the public release of $NAME." \
      "Until then, give the source yourself: a git address that this server can reach, or an archive file:" \
      "" \
      "  CHOIBOT_SOURCE=<git address or file> sh install.sh"
  fi
  case $SOURCE in
    *.tar.gz | *.tgz | *.tar)
      ARCHIVE=yes
      [ -f "$SOURCE" ] || stop "The archive $(shown "$SOURCE") is not on this server." "Copy it to this server first, and give its full path."
      ;;
  esac
}

# One field of a release's index.json, as the release builder writes it (scripts/release/release.mjs:
# two spaces, the key, its value, a comma). Strings lose their quotes. Nothing when it is not there
# exactly one time. No code of the release runs before this check.
index_field() {
  if_v=$(sed -n "s/^  \"$1\": \(.*\),\$/\1/p" "$RELEASE_INDEX")
  [ "$(printf '%s\n' "$if_v" | grep -c .)" = 1 ] || return 0
  printf '%s' "$if_v" | sed 's/^"\(.*\)"$/\1/'
}

# A release file (CHOIBOT_RELEASE): its place, this server's system, and its index when one is given.
check_release() {
  [ -z "$SOURCE" ] || stop "Give CHOIBOT_RELEASE or CHOIBOT_SOURCE, not both."
  case $RELEASE in /*) ;; *) stop "CHOIBOT_RELEASE must be the full path of the release file (it starts with /)." ;; esac
  [ -f "$RELEASE" ] || stop "The release file $RELEASE is not on this server." "Copy it to this server first, and give its full path."
  # The system a release is built for (release-format.md: arch x86_64, os ubuntu-24.04): its Node
  # packages are built there. Read in a subshell: the file sets NAME and VERSION.
  cr_os=$(. /etc/os-release 2>/dev/null && printf '%s-%s' "${ID:-}" "${VERSION_ID:-}") || true
  if [ "$(uname -m)" != x86_64 ] || [ "$cr_os" != ubuntu-24.04 ]; then
    stop "A release of $NAME is built for Ubuntu 24.04 on x86-64. This server is ${cr_os:-another system} on $(uname -m)." \
      "On this server, install from the code: CHOIBOT_SOURCE=<git address or archive file> sh install.sh"
  fi
  if [ -n "$RELEASE_INDEX" ]; then
    case $RELEASE_INDEX in /*) ;; *) stop "CHOIBOT_RELEASE_INDEX must be the full path of the index (it starts with /)." ;; esac
    [ -f "$RELEASE_INDEX" ] || stop "The index $RELEASE_INDEX is not on this server."
    cr_file=$(index_field file) cr_size=$(index_field size) cr_sha=$(index_field sha256)
    cr_arch=$(index_field arch) cr_ios=$(index_field os)
    if [ -z "$cr_file" ] || [ -z "$cr_size" ] || [ -z "$cr_sha" ]; then stop "The index $RELEASE_INDEX is not the index of a release of $NAME."; fi
    [ "$cr_file" = "$(basename "$RELEASE")" ] || stop "The index is of $cr_file, not of $(basename "$RELEASE")."
    [ "$cr_arch" = x86_64 ] && [ "$cr_ios" = ubuntu-24.04 ] || stop "The index is of a release for $cr_ios on $cr_arch, not for this server."
    [ "$(wc -c <"$RELEASE" | tr -d ' ')" = "$cr_size" ] || stop "The release file is not the size that its index says. It is cut or another file." "Download it again."
    [ "$(sha256sum "$RELEASE" | cut -d' ' -f1)" = "$cr_sha" ] || stop "The release file is not the file of its index: its SHA-256 differs." "Download it again. Nothing of it ran."
    ok "The release file matches its index (name, size and SHA-256)"
  fi
}

check_system() {
  cs_os=$(uname -s)
  if [ "$cs_os" != Linux ]; then
    stop "This computer runs $cs_os. $NAME needs a Linux server." \
      "What works: a Linux server with systemd, for example Ubuntu 24.04 with 4 GB of memory." \
      "Open SSH to that server and paste the install line there."
  fi
  if grep -qi microsoft /proc/version 2>/dev/null; then
    stop "This is Linux inside Windows (WSL). $NAME needs a real Linux server." \
      "What works: a Linux server with systemd, for example Ubuntu 24.04 with 4 GB of memory." \
      "Open SSH to that server and paste the install line there."
  fi
  case $(uname -m) in
    x86_64 | amd64) ARCH=x64; NODE_SHA256=$NODE_SHA256_x64; GH_ARCH=amd64; GH_SHA256=$GH_SHA256_amd64 ;;
    aarch64 | arm64) ARCH=arm64; NODE_SHA256=$NODE_SHA256_arm64; GH_ARCH=arm64; GH_SHA256=$GH_SHA256_arm64 ;;
    *) stop "This server has a $(uname -m) processor. $NAME works on x86-64 and on 64-bit ARM." ;;
  esac
  # The Node of ChoiBot needs glibc 2.28 or newer (Ubuntu 20.04, Debian 10). Alpine has none.
  cs_libc=$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}')
  cs_libc_ok=$(printf '%s' "${cs_libc:-0.0}" | awk -F. '{print ($1 > 2 || ($1 == 2 && $2 >= 28)) ? "yes" : "no"}')
  if [ "$cs_libc_ok" != yes ]; then
    stop "The system of this server is too old or of another kind (it has no glibc 2.28 or newer)." \
      "What works: Ubuntu 22.04 or newer, Debian 12 or newer."
  fi
  if [ "$(id -u)" = 0 ]; then stop_root; fi

  cs_mem=$(awk '/^MemTotal:/ {m = $2} /^SwapTotal:/ {s = $2} END {printf "%d", (m + s) / 1024}' /proc/meminfo)
  cs_mem_gb=$(awk '/^MemTotal:/ {printf "%.0f", $2 / 1048576}' /proc/meminfo)
  if [ "$cs_mem" -lt "$MIN_MEMORY_MB" ]; then
    stop "This server has $cs_mem_gb GB of memory. That is too little to build and run $NAME." \
      "What works: 2 GB or more. 4 GB is good for some agents at the same time."
  fi
  cs_dir=$BASE
  while [ ! -d "$cs_dir" ]; do cs_dir=$(dirname "$cs_dir"); done
  cs_disk=$(df -Pk "$cs_dir" | awk 'NR == 2 {printf "%d", $4 / 1024}')
  if [ "$cs_disk" -lt "$MIN_DISK_MB" ]; then
    stop "This server has $cs_disk MB of free disk. $NAME needs $MIN_DISK_MB MB for itself." \
      "Free some disk, or use a server with more."
  fi
  cs_name=$(. /etc/os-release 2>/dev/null && printf '%s' "${PRETTY_NAME:-}") || true
  ok "${cs_name:-Linux}, $cs_mem_gb GB memory, $((cs_disk / 1024)) GB free"
}

# A root-only login. No user is made here: the commands are shown, and root runs them.
stop_root() {
  sr_tools=$(missing_tools)
  set -- "You are logged in as root. $NAME runs as a normal user, never as root." \
    "Make a user for it. Run these commands now, as root:" \
    "" \
    "  useradd -m -s /bin/bash $CLI" \
    "  loginctl enable-linger $CLI" \
    "  cp -r /root/.ssh /home/$CLI/ && chown -R $CLI: /home/$CLI/.ssh"
  if [ -n "$sr_tools" ]; then set -- "$@" "  $(install_command "$sr_tools" | sed 's/^sudo //')"; fi
  stop "$@" \
    "" \
    "They make the user \"$CLI\", keep its services on, and let you log in to it with the SSH key you use for root." \
    "Then log in as that user (ssh $CLI@<your server>) and paste the install line again."
}

check_network() {
  for cn_host in github.com api.anthropic.com; do
    if ! curl -sS -o /dev/null --max-time 15 "https://$cn_host" 2>/dev/null; then
      case $cn_host in
        github.com) cn_who=GitHub; cn_why="Your agents get the code and open pull requests there." ;;
        *) cn_who=Anthropic; cn_why="Claude, the model of your agents, answers from there." ;;
      esac
      stop "This server cannot reach $cn_who (https://$cn_host). $cn_why" \
        "Check the network and the firewall of the server: it must be able to open HTTPS addresses." \
        "$AGAIN"
    fi
  done
  ok "GitHub and Anthropic answer"
}

# This user's service manager answers. The same test as `doctor` (bin/lib/doctor.ts).
user_bus() {
  ub_out=$(systemctl --user is-system-running 2>&1) || true
  case $ub_out in *"Failed to connect"* | "") return 1 ;; esac
}

linger_on() { loginctl show-user "$USER_NAME" --property=Linger 2>/dev/null | grep -q 'Linger=yes'; }

# You came in with `su`: the shell has no address of the service manager, but the manager
# can be there. Then its address is all that is missing.
find_bus() {
  if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -S "/run/user/$(id -u)/bus" ]; then
    XDG_RUNTIME_DIR=/run/user/$(id -u)
    export XDG_RUNTIME_DIR
  fi
}

services_ready() { find_bus; user_bus && linger_on; }

check_services() {
  if ! command -v systemctl >/dev/null 2>&1 || ! command -v loginctl >/dev/null 2>&1; then
    stop "This server has no systemd. $NAME runs as a systemd service of your user." \
      "What works: Ubuntu 22.04 or newer, Debian 12 or newer."
  fi
  # Often allowed with no root. When it is not, the command below is the same with sudo.
  loginctl enable-linger "$USER_NAME" >/dev/null 2>&1 || true
  if ! services_ready; then
    need_root "User \"$USER_NAME\" cannot keep a service on yet." \
      "It lets the services of \"$USER_NAME\" start with the server and stay on after you log out." \
      "sudo loginctl enable-linger $USER_NAME" services_ready
  fi
  ok "User \"$USER_NAME\" can run services. They stay on after you log out."
}

# The tools that this script and ChoiBot need and that are not on the server.
missing_tools() {
  mt_out=
  for mt_tool in curl git tar gzip sha256sum bash dtach $BUILD_TOOLS; do
    command -v "$mt_tool" >/dev/null 2>&1 || mt_out="$mt_out $mt_tool"
  done
  printf '%s' "${mt_out# }"
}

# The command that installs them: the packages of Debian and Ubuntu.
install_command() {
  ic_pkgs=
  for ic_tool in $1; do
    case $ic_tool in
      make | g++) ic_pkg=build-essential ;;
      sha256sum) ic_pkg=coreutils ;;
      *) ic_pkg=$ic_tool ;;
    esac
    case " $ic_pkgs " in *" $ic_pkg "*) ;; *) ic_pkgs="$ic_pkgs $ic_pkg" ;; esac
  done
  printf 'sudo apt-get install -y%s' "$ic_pkgs"
}

tools_ready() { [ -z "$(missing_tools)" ]; }

check_tools() {
  ct_missing=$(missing_tools)
  if [ -n "$ct_missing" ]; then
    if ! command -v apt-get >/dev/null 2>&1; then
      stop "These tools are not on your server: $ct_missing." \
        "Install them with the package manager of your server." "$AGAIN"
    fi
    need_root "These tools are not on your server: $ct_missing." \
      "$NAME keeps your agents alive with dtach, and it builds one part of itself with the build tools." \
      "$(install_command "$ct_missing")" tools_ready
  fi
  ok "The tools are on your server"
}

# Something only root can do. Never run here: the command is shown with its reason, and the
# script goes on when the check passes. $1 what is missing, $2 why, $3 the command, $4 the check.
need_root() {
  note "$1"
  say "    Only root can change that, so this script does not do it. Run this command:"
  say ""
  say "      $3"
  say ""
  say "    Why: $2"
  if [ ! -t 1 ]; then
    stop "The set-up waits for that command." "$AGAIN"
  fi
  say "    Run it in a second terminal on your server. This one waits and goes on by itself."
  say "    (With one terminal: stop here with Ctrl-C, run the command, and paste the install line again.)"
  nr_end=$(($(date +%s) + ROOT_WAIT_S))
  while ! "$4"; do
    if [ "$(date +%s)" -ge "$nr_end" ]; then stop "The command did not run in $((ROOT_WAIT_S / 60)) minutes." "Run it. $AGAIN"; fi
    sleep 3
  done
}

# ------------------------------------------------------------------ download

# The last lines of the log of a step that failed.
log_tail() { tail -n 15 "$LOG" 2>/dev/null | sed 's/^/    /'; }

# ChoiBot's own folder: a new one, or one that this script made before. Never another folder:
# this script replaces what is in it.
own_folder() {
  if [ -e "$BASE" ] && [ ! -f "$BASE/.installed-by-$CLI" ] && [ -n "$(ls -A "$BASE" 2>/dev/null)" ]; then
    stop "The folder $BASE is not empty, and this installer did not make it." \
      "Give an empty folder or a new name:  CHOIBOT_HOME=<folder> sh install.sh"
  fi
  mkdir -p "$BASE" "$TMP"
  : >"$BASE/.installed-by-$CLI"
  : >"$LOG"
}

# Download $1 to $TMP/$2 and hold it against the SHA-256 $3. A file with another checksum is
# deleted before anything of it is used. 1: the download failed.
fetch_checked() {
  curl -fsSL --retry 2 -o "$TMP/$2" "$1" 2>>"$LOG" || return 1
  if [ "$(sha256sum "$TMP/$2" | cut -d' ' -f1)" != "$3" ]; then
    rm -f "$TMP/$2"
    stop "The download of $2 is not the file that this script expects: its checksum is wrong." \
      "The file is deleted and nothing of it ran. $AGAIN"
  fi
}

node_ready() { [ -x "$NODE_DIR/bin/node" ] && [ "$("$NODE_DIR/bin/node" -v 2>/dev/null)" = "v$NODE_VERSION" ]; }

get_node() {
  if node_ready; then
    ok "Node $NODE_VERSION is in $NAME's own folder. No new download."
  else
    gn_file=node-v$NODE_VERSION-linux-$ARCH.tar.gz
    if ! fetch_checked "https://nodejs.org/dist/v$NODE_VERSION/$gn_file" "$gn_file" "$NODE_SHA256"; then
      stop "The download of Node failed (from nodejs.org)." "Check the network of the server. $AGAIN"
    fi
    rm -rf "$TMP/node"
    mkdir "$TMP/node"
    tar -xzf "$TMP/$gn_file" -C "$TMP/node" --strip-components=1
    rm -rf "$NODE_DIR"
    mv "$TMP/node" "$NODE_DIR"
    node_ready || stop "The Node that was downloaded does not start on this server." "$AGAIN"
    ok "Node $NODE_VERSION, in $NAME's own folder (checksum checked). The Node of the system is not touched."
  fi
  PATH="$NODE_DIR/bin:$PATH"
  if [ "$(pnpm --version 2>/dev/null)" != "$PNPM_VERSION" ] || [ "$(command -v pnpm)" != "$NODE_DIR/bin/pnpm" ]; then
    if ! npm install --global --prefix "$NODE_DIR" "pnpm@$PNPM_VERSION" >>"$LOG" 2>&1; then
      log_tail
      stop "The package tool (pnpm) could not be installed into $NAME's own Node." "The lines above say why. $AGAIN"
    fi
  fi
}

get_code() {
  if [ -f "$APP/package.json" ]; then
    ok "The code of $NAME is on your server. No new download."
  else
    rm -rf "$TMP/app"
    if [ "$ARCHIVE" = yes ]; then
      mkdir "$TMP/app"
      tar -xf "$SOURCE" -C "$TMP/app" 2>>"$LOG" || stop "The archive $(shown "$SOURCE") could not be read." "It must be a tar archive of the folder of $NAME."
      # An archive with one top folder: the code is in that folder.
      if [ ! -f "$TMP/app/package.json" ]; then
        set -- "$TMP/app"/*
        if [ $# -eq 1 ] && [ -f "$1/package.json" ]; then
          mv "$1" "$TMP/app-top"
          rmdir "$TMP/app"
          mv "$TMP/app-top" "$TMP/app"
        fi
      fi
    elif ! GIT_TERMINAL_PROMPT=0 git clone --quiet "$SOURCE" "$TMP/app" >>"$LOG" 2>&1; then
      log_tail
      stop "The code could not be fetched from $(shown "$SOURCE")." \
        "This server must be able to read that address with git (for a private repo: with a key of its own)." "$AGAIN"
    fi
    if [ ! -f "$TMP/app/package.json" ] || [ ! -f "$TMP/app/bin/$CLI.ts" ]; then
      stop "$(shown "$SOURCE") does not hold the code of $NAME."
    fi
    mv "$TMP/app" "$APP"
    ok "The code of $NAME"
  fi
  # The parts the command needs to start. `setup` installs again and builds.
  if [ ! -x "$APP/node_modules/.bin/tsx" ]; then
    say "    Getting the parts of $NAME. This takes a minute."
    if ! (cd "$APP" && pnpm install --frozen-lockfile) >>"$LOG" 2>&1; then
      log_tail
      stop "The parts of $NAME could not be installed." "The lines above say why. The full log: $LOG" "$AGAIN"
    fi
  fi
}

# The Node, pnpm and gh of a release in folder $1 run here, and are the versions of the pins.
release_parts_run() {
  [ "$("$1/node/bin/node" -v 2>/dev/null)" = "v$NODE_VERSION" ] || { rm -rf "$BASE/.release-new"; stop "The Node of the release is not Node $NODE_VERSION."; }
  [ "$(PATH="$1/node/bin:$PATH" "$1/node/bin/pnpm" --version 2>/dev/null)" = "$PNPM_VERSION" ] || { rm -rf "$BASE/.release-new"; stop "The pnpm of the release is not pnpm $PNPM_VERSION."; }
  "$1/gh/bin/gh" --version >/dev/null 2>&1 || { rm -rf "$BASE/.release-new"; stop "The GitHub tool of the release does not run on this server."; }
}

# A release (CHOIBOT_RELEASE): unpacked into a new folder of the install, checked by the same code
# as the release builder's (release.mjs `installable`: the entry rules, release.json, the build of
# its commit, the parts, this script's own pins), then put in place. No download, no build.
get_release() {
  gr_new=$BASE/.release-new
  if [ -f "$APP/release.json" ]; then
    # A second run: the same release is there (every step can run again), else a stop.
    gr_want=$(tar -xzOf "$RELEASE" app/release.json 2>>"$LOG") || stop "The release file cannot be read." "It must be a release of $NAME (a .tar.gz)."
    if [ "$gr_want" != "$(cat "$APP/release.json")" ]; then
      stop "$BASE holds another version of $NAME. A release goes into a new folder." \
        "Give a new folder:  CHOIBOT_HOME=<new folder> CHOIBOT_RELEASE=$RELEASE sh install.sh"
    fi
    # The same release. A run that was cut between its renames (or a part removed later) is
    # finished: the part comes from the unpacked folder when it is still there, else from the same
    # release file. app/ is never touched again: after the set-up it holds the settings and data.
    gr_done=
    for gr_part in node gh; do
      if [ "$gr_part" = node ]; then gr_to=$NODE_DIR; else gr_to=$BASE/gh; fi
      [ ! -e "$gr_to" ] || continue
      if [ ! -d "$gr_new/$gr_part" ]; then
        rm -rf "$gr_new"
        mkdir "$gr_new"
        if ! (umask 022 && tar -xzf "$RELEASE" -C "$gr_new" --no-same-owner --no-same-permissions "$gr_part") 2>>"$LOG"; then
          rm -rf "$gr_new"
          stop "$gr_to is missing, and the release file could not give it back." "Give the same release file again. The log: $LOG"
        fi
      fi
      mv "$gr_new/$gr_part" "$gr_to"
      gr_done="$gr_done $gr_part/"
    done
    rm -rf "$gr_new"
    if [ -n "$gr_done" ]; then release_parts_run "$BASE"; fi
    if ! node_ready; then stop "The Node of this install ($NODE_DIR) is not Node $NODE_VERSION." "Remove $NODE_DIR and paste the install line again: it comes back from the release file."; fi
    if [ -n "$gr_done" ]; then ok "The install of this release was not finished: it is now (${gr_done# } from the release)."
    else ok "This release of $NAME is on your server. Nothing to unpack."; fi
    return 0
  fi
  for gr_part in "$APP" "$NODE_DIR" "$BASE/gh"; do
    if [ -e "$gr_part" ]; then
      stop "$gr_part is there already. A release goes into a new folder." \
        "Give a new folder:  CHOIBOT_HOME=<new folder> CHOIBOT_RELEASE=$RELEASE sh install.sh"
    fi
  done
  rm -rf "$gr_new"
  mkdir "$gr_new"
  say "    Unpacking the release. This takes a minute."
  if ! (umask 022 && tar -xzf "$RELEASE" -C "$gr_new" --no-same-owner --no-same-permissions) 2>>"$LOG"; then
    rm -rf "$gr_new"
    stop "The release file could not be unpacked." "It must be a release of $NAME (a .tar.gz). The log: $LOG"
  fi
  if [ ! -x "$gr_new/node/bin/node" ] || [ ! -f "$gr_new/app/scripts/release/release.mjs" ]; then
    rm -rf "$gr_new"
    stop "This file is not a release of $NAME (it has no node/bin/node or app/scripts/release/release.mjs)."
  fi
  if ! gr_out=$("$gr_new/node/bin/node" "$gr_new/app/scripts/release/release.mjs" installable "$gr_new" "$NODE_VERSION" "$PNPM_VERSION" "$GH_VERSION" 2>>"$LOG"); then
    log_tail
    rm -rf "$gr_new"
    stop "This release cannot be installed: the line above says why."
  fi
  gr_version=${gr_out%% *}
  gr_commit=${gr_out#* }
  gr_commit=${gr_commit%% *}
  release_parts_run "$gr_new"
  mv "$gr_new/app" "$APP"
  mv "$gr_new/node" "$NODE_DIR"
  mv "$gr_new/gh" "$BASE/gh"
  rmdir "$gr_new"
  ok "$NAME $gr_version ($(printf '%.7s' "$gr_commit")), from the release file. No download and no build."
}

# A fresh install from a release has the release layout (server/layout.ts): the code folder holds
# code only, so a release can replace it whole. The settings file is outside it, $BASE/console.env
# (0600), and its being there is the mark of the layout: the set-up writes into it, the units read
# it, and the data folders follow (the records in the data folder, the widgets in $BASE/widgets).
# An install of the folder layout (a release from before, with its app/.env) stays as it is.
release_layout() {
  if [ -e "$BASE/console.env" ]; then return 0; fi
  if [ -e "$APP/.env" ]; then
    note "This install keeps its settings in $APP/.env (an install from before the release layout)."
    return 0
  fi
  (umask 077 && : >"$BASE/console.env")
  ok "The settings file: $BASE/console.env (the code folder holds code only)"
}

# The command of ChoiBot for this install: its own Node first, and from its own folder. The
# file is written new at each run, so it is always the one of this script.
write_command() {
  mkdir -p "$BASE/bin"
  cat >"$BASE/bin/$CLI" <<EOF
#!/bin/sh
# Written by the installer of $NAME. A new run of the installer writes it again.
# How a person types this command: the short name when their shell finds it, else this path.
if [ -z "\${CHOIBOT_CLI:-}" ]; then
  CHOIBOT_CLI=$BASE/bin/$CLI
  if [ -L "\$HOME/.local/bin/$CLI" ] && [ "\$(command -v $CLI 2>/dev/null)" = "\$HOME/.local/bin/$CLI" ]; then CHOIBOT_CLI=$CLI; fi
fi
export CHOIBOT_CLI
PATH="$NODE_DIR/bin:\$HOME/.local/bin:\$PATH"
export PATH
if [ -z "\${XDG_RUNTIME_DIR:-}" ] && [ -S "/run/user/\$(id -u)/bus" ]; then
  XDG_RUNTIME_DIR=/run/user/\$(id -u)
  export XDG_RUNTIME_DIR
fi
cd "$APP" && exec node_modules/.bin/tsx bin/$CLI.ts "\$@"
EOF
  chmod 755 "$BASE/bin/$CLI"
  # A short name on the PATH of the user: only where no other file has that name.
  mkdir -p "$HOME/.local/bin"
  for wc_name in "$CLI" "$CLI_SHORT"; do
    wc_link="$HOME/.local/bin/$wc_name"
    if [ "$(readlink "$wc_link" 2>/dev/null)" = "$BASE/bin/$CLI" ] || { [ ! -e "$wc_link" ] && [ ! -L "$wc_link" ]; }; then
      ln -sf "$BASE/bin/$CLI" "$wc_link"
    fi
  done
  # How a person types the command now: the short name when the shell finds it, else the full path.
  CMD="$BASE/bin/$CLI"
  case ":$START_PATH:" in
    *":$HOME/.local/bin:"*) if [ "$(readlink "$HOME/.local/bin/$CLI" 2>/dev/null)" = "$CMD" ]; then CMD=$CLI; fi ;;
  esac
}

# The command, with the way a person types it in the shell that started this script.
cb() { CHOIBOT_CLI=$CMD "$BASE/bin/$CLI" "$@"; }

# With the keyboard of the person, also when the script itself came through a pipe (curl | sh).
cb_tty() {
  if [ -t 0 ]; then cb "$@"
  elif (exec </dev/tty) 2>/dev/null; then cb "$@" </dev/tty
  else cb "$@" </dev/null
  fi
}

claude_there() { command -v claude >/dev/null 2>&1 || [ -x "$HOME/.local/bin/claude" ]; }

# Claude Code, with its official installer (https://code.claude.com/docs/en/setup). It installs
# for this user only and needs no root. Not there = no AI; the install goes on.
get_claude() {
  if claude_there; then
    ok "Claude Code is on your server"
  elif curl -fsSL -o "$TMP/claude-install.sh" https://claude.ai/install.sh 2>>"$LOG" && bash "$TMP/claude-install.sh" >>"$LOG" 2>&1 && claude_there; then
    ok "Claude Code"
  else
    note "Claude Code could not be installed now. $NAME goes on with no AI: each step stays a plain step."
    say "    To try again later, paste the install line again."
  fi
}

# The GitHub tool: your agents open pull requests with it, and the step "Connect GitHub" logs
# in with it. A gh that is on the server is used as it is when it knows what the console asks
# of it. Else ChoiBot gets its own copy, in its own folder, with no root. Not there = that one
# step stays open; the install goes on.

# The gh on the PATH knows the words the console uses. The copy of a repo in "Pick a repo" runs
# `gh repo clone … --no-upstream` (server/setup/repopick.ts), and an old gh (the 2.45 of the
# Ubuntu 24.04 package) stops on that word. gh itself is asked, not a version number.
gh_ready() { command -v gh >/dev/null 2>&1 && gh repo clone --help 2>/dev/null | grep -q -e '--no-upstream'; }

get_gh() {
  if gh_ready; then
    ok "The GitHub tool (gh) is on your server"
    return 0
  fi
  # A release brings its own gh (in $BASE/gh): only the name on the PATH is made.
  if [ -n "$RELEASE" ] && [ -x "$BASE/gh/bin/gh" ]; then
    gg_link="$HOME/.local/bin/gh"
    if [ -e "$gg_link" ] && [ ! -L "$gg_link" ]; then
      note "The GitHub tool at $gg_link is too old for $NAME, and it is a file of yours, so it is not replaced."
      return 0
    fi
    ln -sf "$BASE/gh/bin/gh" "$gg_link"
    hash -r 2>/dev/null || true
    ok "The GitHub tool (gh $GH_VERSION), from the release"
    return 0
  fi
  gg_old=no
  if command -v gh >/dev/null 2>&1; then gg_old=yes; fi
  # The name on the PATH of the user: never over a file of the person.
  gg_link="$HOME/.local/bin/gh"
  if [ -e "$gg_link" ] && [ ! -L "$gg_link" ]; then
    note "The GitHub tool at $gg_link is too old for $NAME, and it is a file of yours, so it is not replaced."
    say "    \"Pick a repo\" cannot copy a repo with it. Update it to gh $GH_VERSION or newer, then paste the install line again."
    return 0
  fi
  gg_file=gh_${GH_VERSION}_linux_$GH_ARCH.tar.gz
  if ! fetch_checked "https://github.com/cli/cli/releases/download/v$GH_VERSION/$gg_file" "$gg_file" "$GH_SHA256"; then
    note "The GitHub tool (gh) could not be downloaded now. To try again later, paste the install line again."
    if [ "$gg_old" = yes ]; then say "    The gh of your server is too old for $NAME: \"Pick a repo\" cannot copy a repo with it."; fi
    return 0
  fi
  rm -rf "$BASE/gh"
  mkdir "$BASE/gh"
  tar -xzf "$TMP/$gg_file" -C "$BASE/gh" --strip-components=1
  ln -sf "$BASE/gh/bin/gh" "$gg_link"
  # The shell remembers where the old gh is: forget it, so the next `gh` of this run is the new one.
  hash -r 2>/dev/null || true
  if [ "$gg_old" = yes ]; then
    ok "The GitHub tool (gh $GH_VERSION), in $NAME's own folder (checksum checked). The gh of your server is too old for $NAME; it is not touched, and its login is kept."
  else
    ok "The GitHub tool (gh $GH_VERSION), in $NAME's own folder (checksum checked)"
  fi
}

# The set-up, with its output kept: when it fails, the install agent reads it.
set_up() {
  printf 'Step: %s\n' "Set up your server" >"$BASE/failed-step.log"
  { cb setup --auto --brief "$@" 2>&1; echo "$?" >"$TMP/rc"; } | tee -a "$BASE/failed-step.log"
  [ "$(cat "$TMP/rc" 2>/dev/null)" = 0 ] && rm -f "$BASE/failed-step.log"
}

# ---------------------------------------------------------------------- main

main() {
  START=$(date +%s)
  SOURCE=${CHOIBOT_SOURCE:-}
  RELEASE=${CHOIBOT_RELEASE:-}
  RELEASE_INDEX=${CHOIBOT_RELEASE_INDEX:-}
  # A release is built: its server needs no build tools.
  if [ -n "$RELEASE" ]; then BUILD_TOOLS=; else BUILD_TOOLS="make g++ python3"; fi
  BASE=${CHOIBOT_HOME:-$HOME/$CLI}
  APP=$BASE/app
  NODE_DIR=$BASE/node
  TMP=$BASE/.tmp
  LOG=$BASE/install.log
  START_PATH=$PATH
  PATH="$HOME/.local/bin:$PATH"
  export PATH
  USER_NAME=$(id -un)

  say "$NAME installer"
  say ""
  say "Your server"
  STEP="Your server"
  check_system
  check_source
  check_network
  check_services
  check_tools

  say ""
  say "Download"
  STEP=Download
  own_folder
  trap 'rm -rf "$TMP"' EXIT
  if [ -n "$RELEASE" ]; then get_release; release_layout; else get_node; get_code; fi
  write_command
  get_gh
  get_claude

  say ""
  say "Step 1 of 2 · Set up your server"
  if [ -n "${CHOIBOT_PORT:-}" ]; then set -- --port "$CHOIBOT_PORT"; else set --; fi
  if ! set_up "$@"; then
    # The step printed its own fix. The install agent can repair it with the person: it needs a
    # Claude login, and offers the login here when there is none (`repair`). Then the set-up runs
    # one more time. With no agent, the next run goes on where this one stopped.
    cb_tty repair || exit 1
    say ""
    say "Step 1 of 2 · Set up your server, again"
    set_up "$@" || exit 1
  fi

  say ""
  say "Step 2 of 2 · Open it"
  cb access || true

  m_took=$(($(date +%s) - START))
  say ""
  say "Done in $((m_took / 60)) min $((m_took % 60)) s. $NAME runs on your server."
  say ""
  # The code goes to a person at a terminal only.
  if [ ! -t 2 ] || ! cb_tty pair; then say "For the code of your first device, run: $CMD pair"; fi
  say ""
  say "After the pairing, the page of $NAME shows the next step: log in to Claude. You do it in the browser."
  say ""
  say "Check your server: $CMD doctor"
  if [ "$CMD" != "$CLI" ]; then
    say "The short command \`$CLI\` works in a new SSH session. In this one, use the full path above."
  fi
}

# The last line: a download that was cut runs nothing.
main "$@"
