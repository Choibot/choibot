#!/usr/bin/env bash
# scripts/release/build.sh — ONE release of the console, built by us, so the person's 2 GB server
# never builds. The format (v1) is the one that the updater of hosted ChoiBot reads.
#
#   scripts/release/build.sh --ref <commit> --out <new or empty folder>
#                            [--repo <choibot checkout>] [--notes-from <commit>]
#                            [--unmerged] [--keep]
#   scripts/release/build.sh --ref <commit> --print-version [--repo <checkout>] [--unmerged]
#
# It writes two files into --out: choibot-<version>-<commit12>-linux-x64.tar.gz and index.json.
#   --ref         the commit to build. It must be on the first-parent line of origin/main (fetch
#                 first), and hold server/buildid.mjs (the build then records the commit).
#   --repo        the checkout that holds the commit (default: the one of this script).
#   --notes-from  the notes are the first-parent subjects after this commit (default: the last 20).
#   --unmerged    a proof of a commit that is not on main: channel "proof" (the updater installs
#                 only its own channel), and its number may be the number of a later main commit.
#   --keep        keep the work folder (it is printed).
#   --print-version  only the version that the commit gets, and its commit, on one line
#                 ("842 <commit>"); nothing is built (git, and node for a public tree, only).
#
# The version (release-format.md section 2): the first-parent count of the commit, or, in a
# public tree (the public export writes release-source.json at its root), the source commit's
# number from that file. The builder then refuses a commit whose first parent holds the same file
# (not an export) and a number that is not greater than the first parent's.
#
# Where: on Ubuntu 24.04 x86_64 only (the native packages build here for the servers). The steps
# need the network (nodejs.org, github.com, the npm registry); the release then needs none. On a
# machine that runs other work, give it a scope of its own; its memory peak is then the scope's:
#   systemd-run --user --scope -p MemoryMax=6G -p CPUWeight=20 nice -n 10 bash -c \
#     'scripts/release/build.sh --ref <c> --out <d>; cat /sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup)/memory.peak'
#
# The pins (Node, its SHA-256, pnpm, gh, its SHA-256) are the ones of install.sh OF THE COMMIT:
# a release runs the Node that its own install line would get. Downloads are cached in
# ~/.cache/choibot-release and checked against the pin each time.
set -euo pipefail
umask 022

say() { printf '%s\n' "$*"; }
die() { printf '✖ %s\n' "$*" >&2; exit 1; }
START=$SECONDS
step() { printf '\n→ %s (%ss)\n' "$*" "$((SECONDS - START))"; }

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REF= OUT= REPO= NOTES_FROM= UNMERGED=0 KEEP=0 PRINT=0
while [ $# -gt 0 ]; do
  case $1 in
    --ref) REF=${2:?--ref <commit>}; shift 2 ;;
    --out) OUT=${2:?--out <folder>}; shift 2 ;;
    --repo) REPO=${2:?--repo <checkout>}; shift 2 ;;
    --notes-from) NOTES_FROM=${2:?--notes-from <commit>}; shift 2 ;;
    --unmerged) UNMERGED=1; shift ;;
    --keep) KEEP=1; shift ;;
    --print-version) PRINT=1; shift ;;
    *) die "unknown argument: $1 (see the head of $0)" ;;
  esac
done
[ -n "$REF" ] || die "give --ref <commit>"
[ -n "$OUT" ] || [ "$PRINT" = 1 ] || die "give --out <folder>"
REPO=${REPO:-$(git -C "$HERE" rev-parse --show-toplevel)}
# --print-version: its one line goes to the first output; every other line to the second.
exec 3>&1
[ "$PRINT" = 0 ] || exec 1>&2

# ------------------------------------------------------------------ the machine and the commit

step "the commit"
COMMIT=$(git -C "$REPO" rev-parse --verify --quiet "$REF^{commit}") || die "$REF is not a commit in $REPO"
git -C "$REPO" cat-file -e "$COMMIT:server/buildid.mjs" 2> /dev/null \
  || die "commit ${COMMIT:0:12} has no server/buildid.mjs: its build cannot record its commit (it is older than the version PR)"
MAIN=$(git -C "$REPO" rev-parse --verify --quiet refs/remotes/origin/main) || die "$REPO has no origin/main: fetch it first"
CHANNEL=test
git -C "$REPO" rev-list --first-parent "$MAIN" > "${TMPDIR:-/tmp}/choibot-release-main.$$"
if grep -qx "$COMMIT" "${TMPDIR:-/tmp}/choibot-release-main.$$"; then ON_MAIN=1; else ON_MAIN=0; fi
rm -f "${TMPDIR:-/tmp}/choibot-release-main.$$"
if [ "$ON_MAIN" = 1 ]; then
  say "  ${COMMIT:0:12} is on the first-parent line of origin/main (${MAIN:0:12})"
elif [ "$UNMERGED" = 1 ]; then
  CHANNEL=proof
  say "  ${COMMIT:0:12} is NOT on origin/main: a proof build, channel \"proof\" (never installed by the updater)"
else
  die "commit ${COMMIT:0:12} is not on the first-parent line of origin/main (${MAIN:0:12}): its number would not only go up. Merge it, fetch, or give --unmerged for a proof"
fi
if git -C "$REPO" cat-file -e "$COMMIT:release-source.json" 2> /dev/null; then
  # A public tree: the number of its source commit (release.mjs checks the form and the order).
  command -v node > /dev/null || die "node is needed to read release-source.json"
  SRC=$(mktemp -d "${TMPDIR:-/tmp}/choibot-release-source-XXXXXXXX")
  git -C "$REPO" show "$COMMIT:release-source.json" > "$SRC/source.json"
  SRC_ARGS=("$SRC/source.json")
  if PARENT=$(git -C "$REPO" rev-parse --verify --quiet "$COMMIT^1") && git -C "$REPO" cat-file -e "$PARENT:release-source.json" 2> /dev/null; then
    git -C "$REPO" show "$PARENT:release-source.json" > "$SRC/parent.json"
    SRC_ARGS+=("$SRC/parent.json")
  fi
  if ! out=$(node "$HERE/release.mjs" source "${SRC_ARGS[@]}"); then rm -rf -- "$SRC"; die "release-source.json of ${COMMIT:0:12} is refused (the line above says why)"; fi
  rm -rf -- "$SRC"
  VERSION=${out%% *}
  say "  a public tree: version $VERSION from release-source.json (source commit ${out#* })"
else
  VERSION=$(git -C "$REPO" rev-list --count --first-parent "$COMMIT")
fi
COMMIT_TIME=$(git -C "$REPO" log -1 --format=%ct "$COMMIT")
NAME=choibot-$VERSION-${COMMIT:0:12}-linux-x64.tar.gz
say "  version $VERSION, commit $COMMIT"
if [ "$PRINT" = 1 ]; then printf '%s %s\n' "$VERSION" "$COMMIT" >&3; exit 0; fi

step "the machine"
[ "$(uname -m)" = x86_64 ] || die "a release is built on x86_64 (this machine: $(uname -m))"
# /etc/os-release is read in a subshell: it sets NAME and VERSION, which are the tar's name and the
# release's number here (in the script's own shell it replaced both: "24.04.4 LTS …", "Ubuntu").
OS=$(. /etc/os-release && printf '%s %s' "${ID:-}" "${VERSION_ID:-}")
OS_NAME=$(. /etc/os-release && printf '%s' "${PRETTY_NAME:-unknown}")
[ "$OS" = "ubuntu 24.04" ] || die "a release is built on Ubuntu 24.04, the system of the servers (this one: $OS_NAME)"
for t in git curl tar gzip sha256sum find g++ make python3; do command -v "$t" > /dev/null || die "$t is missing"; done
# No pipe into a reader that stops early (grep -q, head): under pipefail the writer's SIGPIPE
# fails the whole pipe, also on a match. Each output goes into a variable or a file first.
[[ $(tar --version) == *"GNU tar"* ]] || die "GNU tar is needed (--sort, --hard-dereference)"

INSTALL=$(git -C "$REPO" show "$COMMIT:install.sh")
pin() { sed -n "/^$1=/{s/^$1=//p;q}" <<< "$INSTALL"; }
NODE_VERSION=$(pin NODE_VERSION) NODE_SHA=$(pin NODE_SHA256_x64) PNPM_VERSION=$(pin PNPM_VERSION) GH_VERSION=$(pin GH_VERSION) GH_SHA=$(pin GH_SHA256_amd64)
for v in "$NODE_VERSION" "$PNPM_VERSION" "$GH_VERSION"; do [[ $v =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "a version pin of install.sh is not a plain version: '$v'"; done
for h in "$NODE_SHA" "$GH_SHA"; do [[ $h =~ ^[0-9a-f]{64}$ ]] || die "a SHA-256 pin of install.sh is not 64 hex characters"; done
say "  pins of its install.sh: Node $NODE_VERSION, pnpm $PNPM_VERSION, gh $GH_VERSION"

if [ -e "$OUT" ] && [ -n "$(ls -A "$OUT")" ]; then die "$OUT is not empty"; fi
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)

# The work folder: outside any git work tree (a build there must not see another repo's HEAD).
WORK=$(mktemp -d "${TMPDIR:-/tmp}/choibot-release-XXXXXXXX")
if [ "$KEEP" = 1 ]; then say "  work folder (kept): $WORK"; else trap 'rm -rf -- "$WORK"' EXIT; fi
! git -C "$WORK" rev-parse --is-inside-work-tree > /dev/null 2>&1 || die "the work folder $WORK is inside a git work tree"
STAGE=$WORK/stage
mkdir -p "$STAGE/app" "$STAGE/node" "$STAGE/gh" "$WORK/home" "$WORK/tmp"
CACHE=${XDG_CACHE_HOME:-$HOME/.cache}/choibot-release
mkdir -p "$CACHE"

# fetch <url> <file in the cache> <sha256>: a cached file is checked again; a wrong one goes.
fetch() {
  local f=$CACHE/$2
  if [ ! -f "$f" ] || [ "$(sha256sum "$f" | cut -d' ' -f1)" != "$3" ]; then
    rm -f "$f"
    curl -fsSL --retry 2 --proto '=https' -o "$f.part" "$1" || die "the download of $1 failed"
    mv "$f.part" "$f"
  fi
  [ "$(sha256sum "$f" | cut -d' ' -f1)" = "$3" ] || { rm -f "$f"; die "$2 is not the file of the pin: its SHA-256 is wrong (deleted)"; }
}

# The build's own env: no caller's setting, the release's Node first, every cache in WORK. pnpm
# reads its store and its import method from the build's own .npmrc (pnpm prune takes no such
# option): files are copies, so the tar holds no link into a store.
printf 'store-dir=%s\npackage-import-method=copy\n' "$WORK/pnpm-store" > "$WORK/home/.npmrc"
B=(env -i "HOME=$WORK/home" "PATH=$STAGE/node/bin:/usr/bin:/bin" LANG=C.UTF-8 "TMPDIR=$WORK/tmp" CI=1
  NEXT_TELEMETRY_DISABLED=1 "npm_config_cache=$WORK/npm-cache" npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false)

# ------------------------------------------------------------------ the parts

step "Node $NODE_VERSION and pnpm $PNPM_VERSION"
fetch "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.gz" "node-v$NODE_VERSION-linux-x64.tar.gz" "$NODE_SHA"
tar -xzf "$CACHE/node-v$NODE_VERSION-linux-x64.tar.gz" -C "$STAGE/node" --strip-components=1 --no-same-owner
[ "$("$STAGE/node/bin/node" -v)" = "v$NODE_VERSION" ] || die "node/bin/node is not Node $NODE_VERSION"
"${B[@]}" npm install --global --prefix "$STAGE/node" "pnpm@$PNPM_VERSION" > "$WORK/pnpm-install.log" 2>&1 \
  || { tail -20 "$WORK/pnpm-install.log"; die "pnpm $PNPM_VERSION could not be put into node/"; }
[ "$("${B[@]}" pnpm --version)" = "$PNPM_VERSION" ] || die "node/bin/pnpm is not pnpm $PNPM_VERSION"

step "gh $GH_VERSION"
fetch "https://github.com/cli/cli/releases/download/v$GH_VERSION/gh_${GH_VERSION}_linux_amd64.tar.gz" "gh_${GH_VERSION}_linux_amd64.tar.gz" "$GH_SHA"
tar -xzf "$CACHE/gh_${GH_VERSION}_linux_amd64.tar.gz" -C "$STAGE/gh" --strip-components=1 --no-same-owner
[[ $("$STAGE/gh/bin/gh" --version) == "gh version $GH_VERSION "* ]] || die "gh/bin/gh is not gh $GH_VERSION"

step "the console at ${COMMIT:0:12} (git archive)"
git -C "$REPO" archive --format=tar "$COMMIT" | tar -x -C "$STAGE/app"
[ "$(tr -d '\n' < "$STAGE/app/server/release-commit.txt")" = "$COMMIT" ] || die "git archive did not write the commit into server/release-commit.txt"

step "its packages (pnpm install --frozen-lockfile)"
(cd "$STAGE/app" && "${B[@]}" pnpm install --frozen-lockfile > "$WORK/install.log" 2>&1) \
  || { tail -30 "$WORK/install.log"; die "pnpm install failed (the whole log: $WORK/install.log, with --keep)"; }

step "the build (next build, CHOIBOT_BUILD_COMMIT=${COMMIT:0:12})"
# Next's own type check is off, as in the build of an install (server/buildcheck.mjs): the type
# check of a commit is the pull request's.
(cd "$STAGE/app" && "${B[@]}" "CHOIBOT_BUILD_COMMIT=$COMMIT" CHOIBOT_BUILD_NO_CHECK=1 pnpm build > "$WORK/build.log" 2>&1) \
  || { tail -30 "$WORK/build.log"; die "the build failed"; }
[ "$(cat "$STAGE/app/.next/BUILD_ID")" = "$COMMIT" ] || die ".next/BUILD_ID is not the commit"
rm -rf "$STAGE/app/.next/cache"
# `next build` can rewrite these two files of the checkout: the release ships the commit's own.
git -C "$REPO" archive --format=tar "$COMMIT" next-env.d.ts tsconfig.json | tar -x -C "$STAGE/app"

step "only the production packages (pnpm prune --prod)"
(cd "$STAGE/app" && "${B[@]}" pnpm prune --prod > "$WORK/prune.log" 2>&1) \
  || { tail -30 "$WORK/prune.log"; die "pnpm prune --prod failed"; }
[ -x "$STAGE/app/node_modules/.bin/tsx" ] || die "tsx is not in the production packages: the console cannot start"

# ------------------------------------------------------------------ release.json, the tree, the tar

step "release.json and the entry rules"
SUDOERS=$WORK/sudoers.txt
(cd "$STAGE/app" && "${B[@]}" node_modules/.bin/tsx -e \
  'import { STRONG_DEFAULTS, sudoersText } from "./bin/lib/strong.ts"; process.stdout.write(sudoersText("choibot", STRONG_DEFAULTS));' > "$SUDOERS") \
  || die "the sudoers text of strong-setup could not be rendered"
if [ -n "$NOTES_FROM" ]; then
  FROM=$(git -C "$REPO" rev-parse --verify --quiet "$NOTES_FROM^{commit}") || die "--notes-from $NOTES_FROM is not a commit"
  git -C "$REPO" log --first-parent --format=%s "$FROM..$COMMIT" > "$WORK/notes.txt"
else
  git -C "$REPO" log --first-parent --format=%s -n 20 "$COMMIT" > "$WORK/notes.txt"
fi
BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
FACTS=$WORK/facts.json
"$STAGE/node/bin/node" -e '
  const [facts, notes, sudoers, ...v] = process.argv.slice(1);
  const fs = require("node:fs");
  const [version, commit, channel, builtAt, node, pnpm, gh, file] = v;
  fs.writeFileSync(facts, JSON.stringify({ version: Number(version), commit, channel, builtAt, node, pnpm, gh, file,
    notes: fs.readFileSync(notes, "utf8").split("\n").filter((l) => l.trim() !== ""), sudoers: fs.readFileSync(sudoers, "utf8") }));
' "$FACTS" "$WORK/notes.txt" "$SUDOERS" "$VERSION" "$COMMIT" "$CHANNEL" "$BUILT_AT" "$NODE_VERSION" "$PNPM_VERSION" "$GH_VERSION" "$NAME"
"$STAGE/node/bin/node" "$HERE/release.mjs" release-json "$STAGE" "$FACTS"
# Modes: folders 0755, files 0644 or 0755, no setuid, setgid or sticky bit.
chmod -R u+rwX,go+rX,go-w,ug-s,-t "$STAGE"
"$STAGE/node/bin/node" "$HERE/release.mjs" check "$STAGE"

step "the tar ($NAME)"
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime="@$COMMIT_TIME" --hard-dereference --format=gnu \
  -C "$STAGE" -cf - app node gh | gzip -n -6 > "$OUT/$NAME.part"
mv "$OUT/$NAME.part" "$OUT/$NAME"
# The tar itself, read back (a broken gzip or tar stops here): only app/, node/ and gh/, no "..",
# no hard link, no other type than a file, a folder or a link.
tar -tvzf "$OUT/$NAME" > "$WORK/list.txt" || die "the tar cannot be read back"
tar -tzf "$OUT/$NAME" > "$WORK/names.txt" || die "the tar cannot be read back"
bad=$(awk '{ t = substr($1, 1, 1); if (t != "-" && t != "d" && t != "l" && n++ < 3) print "type " t ": " $0 }' "$WORK/list.txt")
[ -z "$bad" ] || die "the tar has an entry of another type: $bad"
bad=$(awk '!/^(app|node|gh)(\/|$)/ && n++ < 3' "$WORK/names.txt")
[ -z "$bad" ] || die "the tar has a name out of app/, node/, gh/: $bad"
bad=$(awk '/(^|\/)\.\.(\/|$)/ && n++ < 3' "$WORK/names.txt")
[ -z "$bad" ] || die "the tar has a name with \"..\": $bad"
bad=$(sort "$WORK/names.txt" | uniq -d | awk 'n++ < 3')
[ -z "$bad" ] || die "the tar has two entries with one name: $bad"
# The caps of the updater (release-format.md section 3): 400000 entries, 4 GiB extracted.
ENTRIES=$(wc -l < "$WORK/names.txt")
EXTRACTED=$(awk '{ s += $3 } END { printf "%d", s }' "$WORK/list.txt")
[ "$ENTRIES" -le 400000 ] || die "the tar has $ENTRIES entries (the cap: 400000)"
[ "$EXTRACTED" -le 4294967296 ] || die "the tar holds $EXTRACTED bytes (the cap: 4 GiB)"
for f in app/server/release-commit.txt node/bin/node gh/bin/gh; do grep -qx "$f" "$WORK/names.txt" || die "the tar has no $f"; done

step "index.json"
"$STAGE/node/bin/node" "$HERE/release.mjs" index "$OUT" "$FACTS" "$STAGE"

SIZE=$(stat -c %s "$OUT/$NAME")
say ""
say "✔ The release is ready: $OUT"
say "  $NAME: $SIZE bytes ($((SIZE / 1048576)) MiB), sha256 $(sha256sum "$OUT/$NAME" | cut -d' ' -f1)"
say "  $ENTRIES entries, $EXTRACTED bytes ($((EXTRACTED / 1048576)) MiB) extracted"
say "  version $VERSION, commit $COMMIT, channel $CHANNEL; $((SECONDS - START)) s"
