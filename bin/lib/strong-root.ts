// bin/lib/strong-root.ts — root's part of `strong-setup` (bin/lib/strong.ts): the check of the
// facts, the plan and its run. ONE file that imports Node's own modules only (no other file of the
// repo, no package, no loader), so that root can run it with plain Node from a root copy of a
// release (Node runs TypeScript that has types only: the release's Node is 24):
//
//   cd <copy> && env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin <copy>/node/bin/node \
//     <copy>/app/bin/lib/strong-root.ts --user <console user> --app <its running code folder> [--dry-run]
//
// This is the update of the root parts (H4). Root's updater has verified the release, extracted it
// a second time into a folder of its own (<copy>), and stopped the console. Then this file:
//   - refuses to run unless it is root, the environment is exactly PATH=<that path> (so no
//     NODE_OPTIONS), Node has no option, Node is <copy>/node/bin/node and the working folder is in
//     <copy> (processRefusal);
//   - refuses a copy unless every folder from <copy> up to / is a real folder of root that no other
//     account can write, and the files it takes from it are root's (copyRefusal);
//   - reads the facts as the console user, from the RUNNING code (--print-facts), through a pipe
//     with a size cap and a time limit (readFacts). They are data: the strict shape of checkFacts,
//     and a fact that points into the copy, /etc, /usr, root's state folder or another folder of
//     the system is refused (factRefusal);
//   - runs the plan of a root copy (strongPlan with `copy`): the console must not run; it installs
//     no package and changes no account and no group; Node, gh and the exec helper come from the
//     copy (root reads root's files); no restart: the updater starts the console after.
// Root's process reads no file outside the copy (the module loader stops at <copy>/app/package.json)
// but the folders of root that the plan looks at (the homes' folder), and it makes no network
// call: it imports no network module, and the plan of a root copy runs no apt-get.
//
// bin/lib/strong.ts holds the console user's half (the facts) and the command of a checkout or of
// an archive install (strong-setup --user …, through tsx); it imports this file. The names below are
// copies of the product's (server/brand.ts, server/names.mjs, server/agents/terminal.ts,
// server/chief/chiefids.ts): strong-root.test.ts fails when one of them differs.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, constants, fchmodSync, fchownSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ------------------------------------------------------------------ the names

// The names of a new install (server/brand.ts DISPLAY_NAME, server/names.mjs NEW_NAMES): this
// set-up is for a new install only.
export const PRODUCT = "ChoiBot";
export const NAMES = { dataDir: "choibot", dtachDir: "choibot-dtach", cliEntry: "bin/choibot.ts", unit: "choibot.service" } as const;
// The env keys that reach the helper: SUDO_ENV_KEEP of server/agents/terminal.ts on a new install,
// then its product keys with the old prefix (server/names.mjs OLD_NAMES.envPrefix: an agent of an
// old install). The sudoers line, in this order.
const KEEP_NEW = [
  "CHOIBOT_AGENT_ID", "CHOIBOT_AGENT_PASS", "PORT", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "TERM", "LANG",
  "CHOIBOT_WIDGET_DIR", "CHOIBOT_CRON_SPOOL", "CRON_DATA_DIR", "TZ",
];
const NEW_PREFIX = "CHOIBOT_";
const OLD_PREFIX = "CHOIBOT_";
// A Set: in the public tree both prefixes are the new one, and no key may come twice.
export const SUDO_KEEP: readonly string[] = [...new Set([
  ...KEEP_NEW, ...KEEP_NEW.filter((k) => k.startsWith(NEW_PREFIX)).map((k) => `${OLD_PREFIX}${k.slice(NEW_PREFIX.length)}`),
])];
// The fixed ids of the persistent agents (server/chief/chiefids.ts isChiefId): the fleet master,
// the Coordinator and a lead run as the second account.
export const chiefId = (id: string): boolean => id === "fleet-master" || id === "coordinator" || /^lead-[a-z0-9][a-z0-9-]{0,31}$/.test(id);

// The PATH of root's run and of each command it starts.
export const FIXED_PATH = "/usr/sbin:/usr/bin:/sbin:/bin";
const ROOT_ENV = { PATH: FIXED_PATH, LANG: "C.UTF-8", DEBIAN_FRONTEND: "noninteractive" };

// ------------------------------------------------------------------ the facts

export type StrongFacts = {
  user: string; uid: number; home: string;
  // An install with the old names (server/names.mjs): refused.
  legacy: boolean;
  // The checkout (the app folder of the install line) and its settings file.
  app: string; envFile: string;
  // The console's private folders: each one 0700, the console user's own.
  privateDirs: string[];
  // Files of the install folder that hold the output of the install: 0600.
  privateFiles: string[];
  widgetsDir: string; workspace: string;
  // AGENT_WORKTREE_ROOT when it is a full path; else the worktrees are inside each repo.
  worktreeRoot: string | null;
  // Where the console keeps its agent records, and the Claude folder of the console user: a
  // file in either one means that agents ran on this server.
  agentDataDir: string; claudeDir: string;
  // The real files of the tools (symbolic links followed); null: not found.
  nodeDir: string; claude: string | null; gh: string | null; dtach: string | null;
  // The console's systemd user unit (server/names.mjs): the check finds its process.
  unit: string;
  // The records of the persistent agents (the fleet master, the Coordinator, the leads): id and
  // cwd. One whose cwd is in AGENT_HOME_ROOT but not in its second account's folder ran as the
  // workers' account (the old layout): the set-up stops.
  persistent: { id: string; cwd: string }[];
};

export const RECORDS_MAX = 64;

// A user name as useradd makes it, and a path that root may write into a config or an argv:
// absolute, normal (no "." or ".." part, no double or end slash), plain characters only.
export const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const UNIT_RE = /^[A-Za-z0-9_.@-]{1,64}\.service$/;
const PATH_RE = /^\/[A-Za-z0-9._/-]+$/;
export const okPath = (p: unknown): p is string =>
  typeof p === "string" && PATH_RE.test(p) && posix.normalize(p) === p && !p.endsWith("/") && !p.split("/").some((part) => part === "." || part === "..");

export type Who = { user: string; uid: number; home: string };

// The facts as root may use them, or why not: a refusal names the field, never a value. The
// user, its uid and its home are root's own (`who`); the facts must name the same user.
export function checkFacts(raw: unknown, who: Who): StrongFacts | { refused: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { refused: "the facts are not an object" };
  const f = raw as Record<string, unknown>;
  if (typeof f.user !== "string" || !USER_RE.test(f.user)) return { refused: "user" };
  if (f.user !== who.user) return { refused: `user: the facts are of another user than ${who.user}` };
  if (typeof f.legacy !== "boolean") return { refused: "legacy" };
  for (const k of ["app", "envFile", "widgetsDir", "workspace", "agentDataDir", "claudeDir", "nodeDir"] as const) if (!okPath(f[k])) return { refused: k };
  for (const k of ["worktreeRoot", "claude", "gh", "dtach"] as const) if (f[k] !== null && !okPath(f[k])) return { refused: k };
  for (const k of ["privateDirs", "privateFiles"] as const) {
    const v = f[k];
    if (!Array.isArray(v) || v.length > 32 || !v.every(okPath)) return { refused: k };
  }
  if ((f.privateDirs as string[]).length === 0) return { refused: "privateDirs" };
  if (typeof f.unit !== "string" || !UNIT_RE.test(f.unit)) return { refused: "unit" };
  const pr = f.persistent;
  if (!Array.isArray(pr) || pr.length > RECORDS_MAX || !pr.every((r) => r && typeof r === "object" && typeof r.id === "string" && chiefId(r.id) && okPath(r.cwd))) return { refused: "persistent" };
  const s = (k: string) => f[k] as string;
  const n = (k: string) => f[k] as string | null;
  return {
    user: who.user, uid: who.uid, home: who.home, legacy: f.legacy as boolean,
    app: s("app"), envFile: s("envFile"), privateDirs: [...(f.privateDirs as string[])], privateFiles: [...(f.privateFiles as string[])],
    widgetsDir: s("widgetsDir"), workspace: s("workspace"), worktreeRoot: n("worktreeRoot"), agentDataDir: s("agentDataDir"), claudeDir: s("claudeDir"),
    nodeDir: s("nodeDir"), claude: n("claude"), gh: n("gh"), dtach: n("dtach"),
    unit: s("unit"), persistent: (pr as { id: string; cwd: string }[]).map((r) => ({ id: r.id, cwd: r.cwd })),
  };
}


// ------------------------------------------------------------------- the plan

// What root sets up, beside the facts. Each one has a fixed default.
export type StrongOpts = {
  agentUser: string; group: string;
  // AGENT_HOME_ROOT: root's, the group's, 3770, under a root folder the agent cannot write.
  homesRoot: string;
  // AGENT_DTACH_DIR, kept across a reboot by a tmpfiles.d line.
  dtachDir: string;
  // A root-owned copy of the tools both accounts run (Node, claude, gh, dtach).
  toolsDir: string;
  helper: string; helperConf: string; sudoers: string; tmpfiles: string;
  // The second account (its own user group of the same name), its socket folder
  // (AGENT_CHIEF_DTACH_DIR) and the tmpfiles.d file that makes that folder at each boot.
  chiefUser: string; chiefDtachDir: string; chiefTmpfiles: string;
  // The person accepts a server where agents already ran (no "fresh" step).
  acceptUsed?: boolean;
};

// The set-up is for a new install only, so its names are the new names (server/names.mjs).
export const STRONG_DEFAULTS: StrongOpts = {
  agentUser: `${NAMES.dataDir}-agent`, group: `${NAMES.dataDir}-shared`,
  homesRoot: `/srv/${NAMES.dataDir}/agent-homes`, dtachDir: `/run/${NAMES.dtachDir}`,
  toolsDir: `/usr/local/lib/${NAMES.dataDir}`,
  helper: "/usr/local/bin/choibot-agent-exec", helperConf: "/etc/choibot-agent-exec.conf",
  sudoers: "/etc/sudoers.d/choibot-agent-exec", tmpfiles: `/etc/tmpfiles.d/${NAMES.dtachDir}.conf`,
  chiefUser: `${NAMES.dataDir}-chief`, chiefDtachDir: `/run/${NAMES.dtachDir}-chief`,
  chiefTmpfiles: `/etc/tmpfiles.d/${NAMES.dtachDir}-chief.conf`,
};

// The folder of the second account's homes in AGENT_HOME_ROOT (server/chief/chiefaccount.ts).
export const chiefHomes = (o: StrongOpts): string => `${o.homesRoot}/chief`;

// One thing root does. run: a command (argv, no shell), as root or as `as`; `unless`: a command
// whose success means the state is there already; `fail`: the plain words when it fails. write:
// a file of root with its owner and mode. dir: a folder in a folder that the agents can write
// (ensureSharedDir). env: keys of the console's settings file (read and written as `as`).
export type DirAction = { dir: string; owner: string; group: string; mode: number };
// changes: when it runs (not skipped by `unless`), the console's process must start again (a new
// group of the console user). say: its output is printed.
export type Action =
  | { run: string[]; as?: string; unless?: string[]; fail?: string; say?: true; changes?: true }
  | { write: string; text: string; mode: number; owner: string; group: string; check?: string[] }
  | DirAction
  | { env: Record<string, string>; as: string }
  // A check that these keys can be written into the console's settings so that systemd reads them
  // (settingsText), before any change. Nothing is written.
  | { settingsCheck: Record<string, string>; as: string };
export type Step = { id: string; why: string; actions: Action[] };

// The settings keys the plan writes. The agent uid is known only after the account exists: the
// plan gives this mark, and `apply` puts the number in.
export const AGENT_UID_MARK = "<uid of the agent account>";
// The same for the second account: in the settings and in the helper's config.
export const CHIEF_UID_MARK = "<uid of the second account>";
// In an argv: "1" when this run changed the console's settings or added a group to the console
// user, else "0" (the restart step needs no restart then, unless the user manager lacks the group).
export const CHANGED_MARK = "<changed in this run>";

const SHARED_TOOLS_PATH = (o: StrongOpts) => [`${o.toolsDir}/bin`, `${o.toolsDir}/node/bin`, "/usr/local/bin", "/usr/bin", "/bin"].join(":");

// The helper's sudoers lines: the console user runs the helper as the agent user, and only the
// env keys of SUDO_KEEP reach it (both spellings, as deploy/choibot-agent-exec.sudoers.example).
export function sudoersText(user: string, o: StrongOpts): string {
  const keep = SUDO_KEEP;
  return [
    `# ${o.sudoers} — written by \`strong-setup\` of ${PRODUCT}. The console runs its agents through`,
    "# the exec helper as the agent account; only these env keys reach the helper.",
    `${user} ALL=(${o.agentUser}) NOPASSWD: ${o.helper}`,
    "# The second account: the fleet master, the leads and the Coordinator.",
    `${user} ALL=(${o.chiefUser}) NOPASSWD: ${o.helper}`,
    `Defaults!${o.helper} env_keep += "${keep.join(" ")}"`,
    "",
  ].join("\n");
}

export function helperConfText(f: StrongFacts, o: StrongOpts): string {
  return [
    `# ${o.helperConf} — written by \`strong-setup\` of ${PRODUCT} (see deploy/choibot-agent-exec.conf.example).`,
    `DTACH_DIR=${o.dtachDir}`,
    `DTACH_BIN=${o.toolsDir}/bin/dtach`,
    `WORKTREE_ROOT=${f.worktreeRoot ?? f.workspace}`,
    `WORKSPACE_DIR=${f.workspace}`,
    `AGENT_HOME_ROOT=${o.homesRoot}`,
    `AGENT_PATH=${SHARED_TOOLS_PATH(o)}`,
    `AGENT_UID=${AGENT_UID_MARK}`,
    `CHIEF_UID=${CHIEF_UID_MARK}`,
    `CHIEF_DTACH_DIR=${o.chiefDtachDir}`,
    "",
  ].join("\n");
}

// What only root sees of the old layout: the homes of the persistent agents directly in
// AGENT_HOME_ROOT (not in its chief folder) that are real folders of the console user (the
// console made them: prepareHome). An entry of another owner there is not a home of the
// console, and an agent can make one: it never stops the set-up.
export type RootFacts = { oldHomes: string[] };
export function findOldHomes(o: StrongOpts, consoleUid: number, lstat: (p: string) => Stats = lstatSync): string[] {
  return ["fleet-master", "coordinator", "leads"].map((n) => `${o.homesRoot}/${n}`).filter((p) => {
    try { const st = lstat(p); return st.isDirectory() && !st.isSymbolicLink() && st.uid === consoleUid; } catch { return false; }
  });
}

// The stop of the old layout (the lead's condition 7): persistent agents that ran as the
// workers' account. Their move to the second account is not built yet; the set-up never leaves
// them where they are while the second account is on. Null: none.
export function oldLayoutRefusal(f: StrongFacts, o: StrongOpts, r: RootFacts): string | null {
  const inDir = (p: string, d: string) => p === d || p.startsWith(`${d}/`);
  const recs = f.persistent.filter((x) => inDir(x.cwd, o.homesRoot) && !inDir(x.cwd, chiefHomes(o))).map((x) => `${x.id} in ${x.cwd}`);
  const found = [...recs, ...r.oldHomes.map((h) => `the folder ${h}`)];
  if (found.length === 0) return null;
  return `The fleet master, a lead or the Coordinator ran on this server as the workers' account (${found.join("; ")}). ` +
    "The move of these agents to their own account is not built yet, so this set-up stops here. Nothing was changed.";
}

// Why the plan cannot be made for these facts, in plain words; null when it can.
// From a root copy (`fromCopy`), the tools of the facts are not used (strongPlan).
export function strongRefusal(f: StrongFacts, fromCopy = false): string | null {
  if (f.legacy) return `This ${PRODUCT} keeps the names of an old install. Strong protection by this set-up is for a new server only.`;
  if (f.uid === 0 || f.user === "root") return `The console must run as its own user, not as root.`;
  const inHome = (p: string) => { const r = relative(f.home, p); return r === "" || (!r.startsWith("..") && !isAbsolute(r)); };
  for (const [what, p] of [["code", f.app], ["workspace", f.workspace], ["widget folder", f.widgetsDir]] as const) {
    if (inHome(p)) return `The ${what} of ${PRODUCT} (${p}) is inside the home of ${f.user}. The agents must reach it, and never the home: install with CHOIBOT_HOME and --workspace outside the home (for example /opt and /srv).`;
  }
  for (const [what, p] of [["Claude Code", f.claude], ["dtach", f.dtach]] as const) {
    if (p === null && !fromCopy) return `${what} is not on this server. Run the install line first.`;
  }
  return null;
}

// Root copies one file that the console user names: the user reads it (so a link there gives
// nothing more than the user's own rights), root writes it into a root folder.
function copyAsUser(user: string, src: string, dest: string, mode = "0755"): Action[] {
  return [
    { run: ["sh", "-c", 'runuser -u "$1" -- cat -- "$2" > "$3"', "sh", user, src, `${dest}.new`], fail: `${user} cannot read ${src}.` },
    { run: ["chown", "root:root", `${dest}.new`] },
    { run: ["chmod", mode, `${dest}.new`] },
    { run: ["mv", "-f", `${dest}.new`, dest] },
  ];
}

// Whether the user `user` is in the group `group` (root's check, from the group database).
const inGroup = (user: string, group: string): string[] => ["sh", "-c", 'id -nG -- "$1" | tr " " "\\n" | grep -qx -- "$2"', "sh", user, group];

// The restart (the lead's review of B3: a second run stops no agent). Its arguments: the console's
// uid, its user, CHANGED_MARK, the second account's group, the /proc root, the settings file, the
// console's unit, the cgroup root. A restart only when one of these holds, else none:
//   - this run changed the settings or the console user's groups;
//   - the user manager's own Groups line lacks the group (the console's process gets its groups
//     from the manager, which got them at its own start);
//   - the console does not run (the restart starts it);
//   - the settings file is newer than the console's process (an earlier run changed it and then
//     failed before its restart: the console still runs with the old settings).
export const RESTART_STEP = [
  'if ! systemctl is-active --quiet "user@$1.service"; then echo "The user manager of $2 does not run: its first start gives the console its group and its settings."; exit 0; fi',
  'why=""',
  '[ "$3" = 1 ] && why="this run changed the settings or the groups of $2"',
  'if [ -z "$why" ]; then',
  '  gid=$(getent group "$4" | cut -d: -f3)',
  '  mpid=$(systemctl show -p MainPID --value "user@$1.service")',
  '  if ! { [ -n "$gid" ] && [ -n "$mpid" ] && [ "$mpid" != 0 ] && grep "^Groups:" "$5/$mpid/status" | tr -s " \\t" "\\n" | grep -qx -- "$gid"; }; then why="the user manager of $2 lacks the group $4"; fi',
  'fi',
  'if [ -z "$why" ]; then',
  '  cg=$(systemctl show -p ControlGroup --value "user@$1.service")',
  '  d=$(find "$8$cg" -mindepth 1 -maxdepth 3 -type d -name "$7" 2>/dev/null | head -n 1)',
  '  pid=""; [ -n "$d" ] && pid=$(head -n 1 "$d/cgroup.procs" 2>/dev/null)',
  '  if [ -z "$pid" ]; then why="the console does not run"',
  '  else',
  '    age=$(ps -o etimes= -p "$pid" | tr -d " ")',
  '    m=$(runuser -u "$2" -- stat -c %Y -- "$6")',
  '    if [ -z "$age" ] || [ -z "$m" ] || [ "$m" -gt $(( $(date +%s) - age )) ]; then why="the settings file is newer than the console\'s process"; fi',
  '  fi',
  'fi',
  'if [ -z "$why" ]; then echo "The console already runs with these settings and this group: no restart."; exit 0; fi',
  'echo "A restart: $why. Every agent that runs stops now, and the console starts it again."',
  'systemctl restart "user@$1.service" && echo "The console of $2 started again."',
].join("\n");

// The second account's safe.directory entries: only the agent folder of one of its homes may stay
// ($1: the homes folder; a lead's area of AREA_RE). Any other entry is removed, by its exact value.
export const CHIEF_SAFE_PRUNE = [
  'git config --global --get-all safe.directory 2>/dev/null | while IFS= read -r v; do',
  '  case $v in',
  '    "$1"/fleet-master/agent | "$1"/coordinator/agent) continue ;;',
  '    "$1"/leads/*/agent)',
  '      a=${v#"$1"/leads/}; a=${a%/agent}',
  '      case $a in "" | -* | *[!a-z0-9-]*) ;; *) [ ${#a} -le 32 ] && continue ;; esac ;;',
  '  esac',
  '  git config --global --fixed-value --unset-all safe.directory "$v" || exit 1',
  '  echo "removed the safe.directory entry $v"',
  'done',
].join("\n");

// A file of the console user in the second account's homes: readable by that account, not by the
// workers' account. Its arguments: the homes folder, the console user, the second account, the
// workers' account. The file is made by mktemp (O_EXCL, a random name), so no entry that the
// second account can make in that folder (it is 3770 with its group) is written through; the
// folder is sticky, so that account cannot replace the file after; it goes by its name.
export const HOMES_FILE_CHECK = [
  'f=$(runuser -u "$2" -- mktemp -- "$1/.strong-check.XXXXXX") || { echo "$2 cannot make a file in $1: its group $3 is missing"; exit 1; }',
  'r=0',
  'runuser -u "$2" -- sh -c \'printf "strong-check\\n" >> "$1" && chmod 0640 -- "$1"\' sh "$f" || { echo "$2 cannot write its file $f"; r=1; }',
  'if [ $r = 0 ] && ! runuser -u "$3" -- cat -- "$f" > /dev/null 2>&1; then echo "$3 cannot read a file of $2 in its homes"; r=1; fi',
  'if runuser -u "$4" -- cat -- "$f" > /dev/null 2>&1; then echo "$4 can read a file of $2 in the homes of $3"; r=1; fi',
  'runuser -u "$2" -- rm -f -- "$f"',
  '[ $r = 0 ] && echo "A file of $2 in its homes: $3 reads it, $4 does not."',
  'exit $r',
].join("\n");

// The console's process after the restart: the first process of its unit in the cgroup of the
// user manager (root reads /sys and /proc), and its Groups line must hold the second account's
// group. With no user manager (an image build) there is no process to read: it says so.
// Its arguments: the console's uid, its unit, the group, the cgroup root, the /proc root.
export const CONSOLE_GROUP_CHECK = [
  'systemctl is-active --quiet "user@$1.service" || { echo "The console does not run: its first start gets the group."; exit 0; }',
  'cg=$(systemctl show -p ControlGroup --value "user@$1.service")',
  'gid=$(getent group "$3" | cut -d: -f3)',
  '[ -n "$cg" ] && [ -n "$gid" ] || { echo "no cgroup or no group $3"; exit 1; }',
  'i=0; pid=""',
  'while [ $i -lt 60 ]; do',
  '  d=$(find "$4$cg" -mindepth 1 -maxdepth 3 -type d -name "$2" 2>/dev/null | head -n 1)',
  '  [ -n "$d" ] && pid=$(head -n 1 "$d/cgroup.procs" 2>/dev/null)',
  '  [ -n "$pid" ] && break',
  '  i=$((i + 1)); sleep 1',
  'done',
  '[ -n "$pid" ] || { echo "The console ($2) did not start within 60 seconds."; exit 1; }',
  'grep "^Groups:" "$5/$pid/status" | tr -s " \\t" "\\n" | grep -qx -- "$gid" || { echo "The console (pid $pid) does not have the group $3 (gid $gid)."; exit 1; }',
  'echo "The console (pid $pid) has the group $3."',
].join("\n");

// The plan. With `from` (a root copy of a release, H4): the plan of an update of the root parts,
// while the console is stopped. It installs no package and changes no account and no group (a new
// group reaches the console only at a restart of its user manager, which stops every agent); Node,
// gh and the helper come from the copy; Claude Code and dtach stay; no restart and no check of the
// console's process (the updater starts the console after this run, and checks it).
export function strongPlan(f: StrongFacts, o: StrongOpts = STRONG_DEFAULTS, r: RootFacts = { oldHomes: [] }, from?: RootCopy): Step[] {
  const copy = from?.copy;
  const factsWhy = copy === undefined ? null : factRefusal(f, copy, o);
  if (factsWhy) throw new Error(`The facts are refused: ${factsWhy}.`);
  const why = strongRefusal(f, copy !== undefined) ?? oldLayoutRefusal(f, o, r);
  if (why) throw new Error(why);
  const u = f.user;
  const asU = (run: string[], fail?: string): Action => ({ run, as: u, ...(fail ? { fail } : {}) });
  const agentHome = `/home/${o.agentUser}`;
  const agentClaude = `${agentHome}/.claude`;
  const chiefHome = `/home/${o.chiefUser}`;
  const chiefClaude = `${chiefHome}/.claude`;
  const homes = chiefHomes(o);
  const bin = `${o.toolsDir}/bin`;
  const node = `${o.toolsDir}/node`;
  // The two accounts stay apart: checked by both plans.
  const apart: Action[] = [
    {
      run: ["sh", "-c", '! id -nG -- "$1" | tr " " "\\n" | grep -qx -- "$2"', "sh", o.agentUser, o.chiefUser],
      fail: `${o.agentUser} is in the group ${o.chiefUser}: a worker could read the tokens of the fleet master, the leads and the Coordinator. Remove it (gpasswd -d ${o.agentUser} ${o.chiefUser}), then run the set-up again.`,
    },
    {
      run: ["sh", "-c", 'g=$(id -gn -- "$2") && ! id -nG -- "$1" | tr " " "\\n" | grep -qx -- "$g"', "sh", o.chiefUser, u],
      fail: `${o.chiefUser} is in the group of ${u}: it could read the console's own files. Remove it from that group (gpasswd -d), then run the set-up again.`,
    },
  ];
  // From a root copy: the accounts and groups of the first set-up, checked only.
  const notMade = (what: string) => `${what} is not as the first set-up made it. An update changes no account and no group.`;
  const accountChecks: Action[] = [
    { run: ["getent", "group", o.group], fail: notMade(`The group ${o.group}`) },
    { run: ["id", "-u", "--", o.agentUser], fail: notMade(`The account ${o.agentUser}`) },
    { run: ["id", "-u", "--", o.chiefUser], fail: notMade(`The account ${o.chiefUser}`) },
    ...([[o.agentUser, o.group], [u, o.group], [o.chiefUser, o.group], [u, o.chiefUser]] as const).map(([who, g]): Action => ({ run: inGroup(who, g), fail: notMade(`The group ${g} of ${who}`) })),
    ...apart,
  ];
  const settingsEnv: Record<string, string> = {
    CHIEF_AGENT_UID: AGENT_UID_MARK, AGENT_HOME_ROOT: o.homesRoot, AGENT_CLAUDE_CONFIG_DIR: agentClaude,
    AGENT_DTACH_DIR: o.dtachDir, AGENT_DTACH_BIN: `${bin}/dtach`, CLAUDE_CODE_EXECUTABLE: `${bin}/claude`,
    AGENT_EXEC_HELPER: o.helper,
    CHIEF_PERSISTENT_UID: CHIEF_UID_MARK, AGENT_CHIEF_CLAUDE_CONFIG_DIR: chiefClaude, AGENT_CHIEF_DTACH_DIR: o.chiefDtachDir,
  };
  const steps: Step[] = [];
  if (copy) {
    steps.push({
      id: "stopped",
      why: `The console does not run: the update stopped it, and starts it after this set-up. An agent that runs keeps its session.`,
      actions: [{
        // Root's own name of the unit, never the fact (factRefusal refuses another one).
        run: ["bash", "-c", CONSOLE_STOPPED_CHECK, "bash", String(f.uid), NAMES.unit, "/sys/fs/cgroup"],
        fail: `The console (${NAMES.unit}) runs. The update stops it before this set-up.`, say: true,
      }],
    }, {
      id: "settings-check",
      why: `The console's settings file: the keys of this set-up can be written into it so that systemd reads them. Checked before any change.`,
      actions: [{ settingsCheck: settingsEnv, as: u }],
    });
  } else if (!o.acceptUsed) {
    steps.push({
      id: "fresh",
      why: `This server is new: no agent ran as ${u} (no agent record, no Claude session).`,
      actions: [asU(
        ["sh", "-c", 'for d in "$1" "$2"; do if [ -d "$d" ] && [ -n "$(ls -A -- "$d")" ]; then echo "$d is not empty"; exit 1; fi; done', "sh", f.agentDataDir, join(f.claudeDir, "projects")],
        `Agents already ran on this server as ${u}. This set-up runs as root and trusts the code and the folders of ${u}, which those agents could change. Read "Strong protection on a used server" in deploy/RUNBOOK.md; to go on anyway, add --accept-used-server.`,
      )],
    });
  }
  steps.push(
    {
      id: "packages",
      why: "Hard links are protected (no account can link a file it does not own), and the tools of this set-up: access lists (acl) and sudo.",
      actions: [
        { run: ["sh", "-c", "test \"$(sysctl -n fs.protected_hardlinks)\" = 1"], fail: "fs.protected_hardlinks is not 1: an account could hard-link a file that it does not own." },
        copy
          ? { run: ["sh", "-c", "command -v setfacl && command -v visudo"], fail: "acl or sudo is not installed. The first set-up installs them; an update installs no package." }
          : { run: ["apt-get", "install", "-y", "--no-install-recommends", "acl", "sudo"], unless: ["sh", "-c", "command -v setfacl && command -v visudo"] },
      ],
    },
    {
      id: "accounts",
      why: `The agents' own account (${o.agentUser}, no sudo) and the group it shares with ${u}. The second account (${o.chiefUser}, no sudo) for the fleet master, the leads and the Coordinator: its own group, which ${u} is in and ${o.agentUser} is not.`,
      actions: copy ? accountChecks : [
        { run: ["groupadd", "--system", o.group], unless: ["getent", "group", o.group] },
        { run: ["useradd", "--create-home", "--home-dir", agentHome, "--shell", "/bin/bash", "--user-group", o.agentUser], unless: ["id", "-u", o.agentUser] },
        { run: ["usermod", "-aG", o.group, o.agentUser] },
        { run: ["usermod", "-aG", o.group, u], unless: inGroup(u, o.group), changes: true },
        { run: ["chmod", "0700", agentHome], as: o.agentUser },
        { run: ["install", "-d", "-m", "0700", agentClaude], as: o.agentUser },
        { run: ["useradd", "--create-home", "--home-dir", chiefHome, "--shell", "/bin/bash", "--user-group", o.chiefUser], unless: ["id", "-u", o.chiefUser] },
        // It reads the workspace and the widgets, as the workers do; the console writes its homes.
        { run: ["usermod", "-aG", o.group, o.chiefUser] },
        { run: ["usermod", "-aG", o.chiefUser, u], unless: inGroup(u, o.chiefUser), changes: true },
        { run: ["chmod", "0700", chiefHome], as: o.chiefUser },
        { run: ["install", "-d", "-m", "0700", chiefClaude], as: o.chiefUser },
        ...apart,
      ],
    },
    {
      id: "tools",
      why: copy
        ? `Node and gh from the release (root's copy) in ${o.toolsDir}, owned by root: both accounts run them, and neither can change them. Claude Code and dtach stay as they are.`
        : `Node, Claude Code${f.gh ? ", gh" : ""} and dtach in ${o.toolsDir}, owned by root: both accounts run them, and neither can change them. ${u} reads each source.`,
      actions: copy ? [
        { run: ["install", "-d", "-o", "root", "-g", "root", "-m", "0755", o.toolsDir, bin] },
        { run: ["bash", "-c", NODE_FROM_COPY, "bash", join(copy, "node"), node], fail: `The Node folder of the release could not be put in ${node}.`, say: true },
        ...fromRootCopy(join(copy, "gh", "bin", "gh"), `${bin}/gh`, "0755"),
        { run: ["test", "-x", `${bin}/claude`], fail: `Claude Code is not in ${bin}: the first set-up puts it there. An update does not change it.` },
        { run: ["test", "-x", `${bin}/dtach`], fail: `dtach is not in ${bin}: the first set-up puts it there. An update does not change it.` },
      ] : [
        { run: ["install", "-d", "-o", "root", "-g", "root", "-m", "0755", o.toolsDir, bin] },
        // The user reads the Node folder into a stream; root writes it, in a folder of root that
        // no other account can enter. So the user never holds a tree that root walks. Root
        // extracts a stream that the user wrote: it is safe because GNU tar (Ubuntu's; the image
        // must use it) strips a leading "/", refuses a member with "..", and makes a link that
        // points outside only at the end of the extraction. The setuid and device check stays.
        { run: ["rm", "-rf", `${node}.new`] },
        { run: ["install", "-d", "-o", "root", "-g", "root", "-m", "0700", `${node}.new`] },
        {
          run: ["bash", "-c", 'set -o pipefail; runuser -u "$1" -- tar -C "$2" -cf - . | tar -C "$3" -xf - --no-same-owner --no-same-permissions', "bash", u, f.nodeDir, `${node}.new`],
          fail: `${u} cannot read ${f.nodeDir}, or it is not a folder.`,
        },
        { run: ["chmod", "-R", "u-s,g-s,go-w", `${node}.new`] },
        {
          run: ["sh", "-c", 'test -z "$(find "$1" \\( -type b -o -type c -o -type p -o -type s -o -perm /6000 \\) -print -quit)"', "sh", `${node}.new`],
          fail: `The Node folder ${f.nodeDir} holds a device, a pipe, a socket or a setuid file: it is not a copy of Node.`,
        },
        { run: ["chmod", "0755", `${node}.new`] },
        { run: ["rm", "-rf", node] },
        { run: ["mv", `${node}.new`, node] },
        ...copyAsUser(u, f.claude!, `${bin}/claude`),
        ...copyAsUser(u, f.dtach!, `${bin}/dtach`),
        ...(f.gh ? copyAsUser(u, f.gh, `${bin}/gh`) : []),
      ],
    },
    {
      id: "private",
      why: `The console's data and settings: only ${u} reads them. ${u} does it itself.`,
      actions: [
        ...f.privateDirs.flatMap((d): Action[] => [asU(["install", "-d", "-m", "0700", d]), asU(["chmod", "0700", d])]),
        asU(["test", "-O", f.envFile], `The settings file ${f.envFile} is not of ${u}.`),
        asU(["chmod", "0600", f.envFile]),
        ...f.privateFiles.map((p) => asU(["chmod", "0600", p])),
      ],
    },
    {
      id: "shared",
      why: "The folders the console and its agents share: the agents' homes, the session sockets, the widgets, the workspace.",
      actions: [
        // The parent of the homes becomes root's first; then a test of the homes path holds.
        { run: ["install", "-d", "-o", "root", "-g", "root", "-m", "0755", dirname(o.homesRoot)] },
        { run: ["chown", "root:root", dirname(o.homesRoot)] },
        { run: ["chmod", "0755", dirname(o.homesRoot)] },
        { run: ["test", "!", "-L", o.homesRoot], fail: `${o.homesRoot} is a symbolic link.` },
        { run: ["install", "-d", "-o", "root", "-g", o.group, "-m", "3770", o.homesRoot] },
        { run: ["chown", `root:${o.group}`, o.homesRoot] },
        { run: ["chmod", "3770", o.homesRoot] },
        // Design B (server/agents/agentclone.ts), in the homes' folder (the agents can write it):
        // clones/, each agent makes its own clone there; uploads/ and settings/, the console's, the
        // agents may read. Never through a path: ensureSharedDir.
        { dir: `${o.homesRoot}/clones`, owner: "root", group: o.group, mode: 0o3770 },
        { dir: `${o.homesRoot}/uploads`, owner: u, group: o.group, mode: 0o2750 },
        { dir: `${o.homesRoot}/settings`, owner: u, group: o.group, mode: 0o2750 },
        { write: o.tmpfiles, text: `d ${o.dtachDir} 3770 ${u} ${o.group} -\n`, mode: 0o644, owner: "root", group: "root" },
        { run: ["systemd-tmpfiles", "--create", o.tmpfiles] },
        // The second account's homes (root's, its group, 3770: the workers cannot enter it; the
        // console never makes it) and its socket folder (the console's, its group, 3770), made
        // now and at each boot (/run is new at each boot).
        { dir: homes, owner: "root", group: o.chiefUser, mode: 0o3770 },
        { write: o.chiefTmpfiles, text: `d ${o.chiefDtachDir} 3770 ${u} ${o.chiefUser} -\n`, mode: 0o644, owner: "root", group: "root" },
        { run: ["systemd-tmpfiles", "--create", o.chiefTmpfiles] },
        asU(["install", "-d", "-m", "2770", f.widgetsDir]),
        asU(["chgrp", o.group, f.widgetsDir]),
        asU(["chmod", "2770", f.widgetsDir]),
        asU(["setfacl", "-R", "-m", `g:${o.group}:rwX`, "-m", `d:g:${o.group}:rwX`, f.widgetsDir]),
        asU(["test", "-d", f.workspace, "-a", "-O", f.workspace], `The workspace ${f.workspace} is not a folder of ${u}.`),
        asU(["chgrp", o.group, f.workspace]),
        asU(["chmod", "2750", f.workspace]),
      ],
    },
    {
      id: "helper",
      why: `The exec helper (${o.helper}): the one way the console starts a process as ${o.agentUser}.${copy ? " It comes from the release: a call after this run starts the new one; an agent that runs keeps its process." : ""}`,
      actions: [
        ...(copy ? fromRootCopy(join(copy, "app", "deploy", "choibot-agent-exec"), o.helper, "0755") : copyAsUser(u, join(f.app, "deploy", "choibot-agent-exec"), o.helper)),
        { write: o.helperConf, text: helperConfText(f, o), mode: 0o644, owner: "root", group: "root" },
        { write: o.sudoers, text: sudoersText(u, o), mode: 0o440, owner: "root", group: "root", check: ["visudo", "-cf"] },
      ],
    },
    {
      id: "agent-git",
      why: `The git settings of ${o.agentUser}: the repos belong to ${u}, and an automatic clean-up would write where agents cannot.`,
      actions: [
        { run: ["git", "config", "--global", "--replace-all", "safe.directory", "*"], as: o.agentUser },
        { run: ["git", "config", "--global", "gc.auto", "0"], as: o.agentUser },
        { run: ["git", "config", "--global", "maintenance.auto", "false"], as: o.agentUser },
      ],
    },
    {
      id: "chief-git",
      why: `The git settings of ${o.chiefUser}: no automatic clean-up, and no folder that git takes as safe but the agent folders of its own homes, which the console names one exact path at a time (the helper's git-safe). Any other entry ("*", a worker's clone) is removed; those stay, so its git there keeps working.`,
      actions: [
        { run: ["git", "config", "--global", "gc.auto", "0"], as: o.chiefUser },
        { run: ["git", "config", "--global", "maintenance.auto", "false"], as: o.chiefUser },
        { run: ["sh", "-c", CHIEF_SAFE_PRUNE, "sh", homes], as: o.chiefUser, say: true },
      ],
    },
    {
      id: "settings",
      why: `The console's settings for strong protection (${u} writes them). ${copy ? "They take effect when the update starts the console." : "They take effect at its start (the next step)."}`,
      actions: [{ env: settingsEnv, as: u }],
    },
    {
      id: "restart",
      why: `The console starts again ONLY when this run changed its settings or the groups of ${u}, when the user manager of ${u} lacks the group ${o.chiefUser} (a group reaches a process only at its start), when the console does not run, or when the settings file is newer than the console's process. Then the user manager of ${u} starts again, and before it starts again every agent that runs stops (the console starts them again). Else: no restart. Where it does not run (an image build), its first start does it.`,
      actions: [{
        run: ["sh", "-c", RESTART_STEP, "sh", String(f.uid), u, CHANGED_MARK, o.chiefUser, "/proc", f.envFile, f.unit, "/sys/fs/cgroup"],
        fail: `The restart of the user manager of ${u} (user@${f.uid}.service) failed.`, say: true,
      }],
    },
    {
      id: "check",
      why: `Check, after the start: ${u} can start the helper as both accounts; the folders of the second account; a file of ${u} in its homes is for it and not for ${o.agentUser}; the console's process has the group.`,
      actions: [
        asU(["sudo", "-n", "-u", o.agentUser, o.helper, "probe"], `${u} cannot start the helper as ${o.agentUser}.`),
        asU(["sudo", "-n", "-u", o.chiefUser, o.helper, "probe"], `${u} cannot start the helper as ${o.chiefUser}.`),
        ...([[homes, `root:${o.chiefUser} 3770`], [o.chiefDtachDir, `${u}:${o.chiefUser} 3770`]] as const).map(([d, want]): Action => ({
          run: ["sh", "-c", 'test ! -L "$1" && test "$(stat -c "%U:%G %a" -- "$1")" = "$2"', "sh", d, want], fail: `${d} is not ${want} (or it is a link).`,
        })),
        { run: ["sh", "-c", HOMES_FILE_CHECK, "sh", homes, u, o.chiefUser, o.agentUser], fail: `A file of ${u} in the homes of ${o.chiefUser} is not as it must be.`, say: true },
        {
          run: ["sh", "-c", CONSOLE_GROUP_CHECK, "sh", String(f.uid), f.unit, o.chiefUser, "/sys/fs/cgroup", "/proc"],
          fail: `The console's process does not have the group ${o.chiefUser}.`, say: true,
        },
      ],
    },
  );
  if (!copy) return steps;
  // From a root copy: no restart, and so no check of the console's process (the update does both).
  return steps.filter((s) => s.id !== "restart").map((s) => (s.id !== "check" ? s : {
    ...s,
    why: `Check: ${u} can start the helper as both accounts; the folders of the second account; a file of ${u} in its homes is for it and not for ${o.agentUser}.`,
    actions: s.actions.filter((a) => !("run" in a && a.run[2] === CONSOLE_GROUP_CHECK)),
  }));
}


// ------------------------------------------------------------- dry run, apply

const q = (s: string): string => (/^[A-Za-z0-9_./:=@%+,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const line = (argv: string[]): string => argv.map(q).join(" ");

// The plan as a person reads it: each step, why, and each action as a shell line.
export function planText(steps: Step[]): string {
  const out: string[] = [];
  for (const s of steps) {
    out.push(`# ${s.id}: ${s.why}`);
    for (const a of s.actions) {
      if ("run" in a) out.push(`${a.unless ? `${line(a.unless)} >/dev/null 2>&1 || ` : ""}${a.as ? `runuser -u ${q(a.as)} -- ` : ""}${line(a.run)}`);
      else if ("write" in a) out.push(`write ${a.write} (${a.owner}:${a.group} ${a.mode.toString(8).padStart(4, "0")}${a.check ? `, checked by ${a.check.join(" ")}` : ""}):\n${a.text.replace(/^/gm, "    ").trimEnd()}`);
      else if ("dir" in a) out.push(`folder ${a.dir} (${a.owner}:${a.group} ${a.mode.toString(8).padStart(4, "0")}): mkdir, or a real folder of root${a.owner === "root" ? "" : ` or ${a.owner}`} that is there; owner and mode set on the open folder`);
      else if ("settingsCheck" in a) out.push(`check the settings, as ${a.as}: systemd can read ${Object.keys(a.settingsCheck).join(" ")}`);
      else out.push(`settings, as ${a.as}: ${Object.entries(a.env).map(([k, v]) => `${k}=${v}`).join(" ")}`);
    }
    out.push("");
  }
  return out.join("\n");
}

export type Exec = (argv: string[], o?: { as?: string; input?: string }) => { code: number; out: string };

export const SETTINGS_MAX = 256 * 1024;

export const realExec: Exec = (argv, o = {}) => {
  const full = o.as ? ["runuser", "-u", o.as, "--", ...argv] : argv;
  const r = spawnSync(full[0], full.slice(1), {
    encoding: "utf8", input: o.input, cwd: "/",
    env: ROOT_ENV as unknown as NodeJS.ProcessEnv,
  });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? String(r.error.message) : ""}` };
};

// A folder in a folder that the agents can write and that is sticky (the homes' folder). Made by
// one mkdir (no -p, so nothing that an agent put there is used); when an entry is there, it is
// taken only when it is a real folder whose owner is root or the owner to be: in a sticky folder no
// agent can then rename or replace it. The owner, the group and the mode are set on the folder
// opened with O_NOFOLLOW (fchown, fchmod): no step follows a link. Null when done, else the reason.
export type DirFs = {
  mkdir: (p: string, mode: number) => void; lstat: (p: string) => Stats; open: (p: string, flags: number) => number; fstat: (fd: number) => Stats;
  fchown: (fd: number, uid: number, gid: number) => void; fchmod: (fd: number, mode: number) => void; close: (fd: number) => void;
};
const REAL_DIR_FS: DirFs = {
  mkdir: (p, mode) => { mkdirSync(p, { mode }); }, lstat: lstatSync, open: (p, flags) => openSync(p, flags), fstat: fstatSync,
  fchown: fchownSync, fchmod: fchmodSync, close: closeSync,
};

export function ensureSharedDir(a: DirAction, ids: { uid: number; gid: number }, fsx: DirFs = REAL_DIR_FS): string | null {
  const ok = (uid: number) => uid === 0 || uid === ids.uid;
  try {
    fsx.mkdir(a.dir, 0o700);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") return `${a.dir} cannot be made (${(e as NodeJS.ErrnoException).code ?? "error"}).`;
    const st = fsx.lstat(a.dir);
    if (st.isSymbolicLink() || !st.isDirectory() || !ok(st.uid)) return `${a.dir} is there, and it is not a real folder of root${a.owner === "root" ? "" : ` or ${a.owner}`}. Look at it, remove it, and run the set-up again.`;
  }
  let fd: number;
  try {
    fd = fsx.open(a.dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (e) {
    return `${a.dir} cannot be opened as a folder (${(e as NodeJS.ErrnoException).code ?? "error"}).`;
  }
  try {
    const st = fsx.fstat(fd);
    if (!st.isDirectory() || !ok(st.uid)) return `${a.dir} changed while the set-up ran. Run it again.`;
    fsx.fchown(fd, ids.uid, ids.gid);
    fsx.fchmod(fd, a.mode);
    return null;
  } finally {
    fsx.close(fd);
  }
}

// The uid of an account and the gid of a group, from root's own lookup.
function idsOf(exec: Exec, owner: string, group: string): { uid: number; gid: number } | string {
  const u = exec(["id", "-u", "--", owner]);
  const g = exec(["getent", "group", group]);
  const uid = Number(u.out.trim());
  const gid = Number(g.out.trim().split(":")[2]);
  if (u.code !== 0 || !/^\d+$/.test(u.out.trim())) return `no account ${owner}`;
  if (g.code !== 0 || !Number.isInteger(gid) || gid < 0) return `no group ${group}`;
  return { uid, gid };
}

export type ApplyDeps = {
  exec?: Exec; writeFile?: (path: string, text: string) => void; dir?: (a: DirAction) => string | null; envFile: string; log?: (s: string) => void;
  // The accounts whose uids fill the marks (the plan's options).
  opts?: Pick<StrongOpts, "agentUser" | "chiefUser">;
};

// Run the plan as root, step by step. The first action that fails stops it: the step, what
// failed and the output are printed, and the exit code is 1.
export function applyPlan(steps: Step[], d: ApplyDeps): number {
  const exec = d.exec ?? realExec;
  const log = d.log ?? ((s) => console.log(s));
  const write = d.writeFile ?? ((p: string, t: string) => writeFileSync(p, t, { mode: 0o600 }));
  const fail = (s: Step, what: string, out: string) => {
    log(`✖ ${s.id}: ${what}\n${printable(out.trim()).split("\n").slice(-12).map((l) => `    ${l}`).join("\n")}`);
    return 1;
  };
  // The uid of each account of a mark, read when a mark is first met (the account exists then).
  const accounts = { [AGENT_UID_MARK]: (d.opts ?? STRONG_DEFAULTS).agentUser, [CHIEF_UID_MARK]: (d.opts ?? STRONG_DEFAULTS).chiefUser };
  const uids = new Map<string, string>();
  const uidOf = (mark: keyof typeof accounts): { uid: string } | { out: string } => {
    const have = uids.get(mark);
    if (have) return { uid: have };
    const r = exec(["id", "-u", accounts[mark]]);
    const uid = r.out.trim();
    if (r.code !== 0 || !/^[1-9][0-9]*$/.test(uid)) return { out: r.out };
    uids.set(mark, uid);
    return { uid };
  };
  const fill = (s: Step, text: string): string | null => {
    let t = text;
    for (const mark of [AGENT_UID_MARK, CHIEF_UID_MARK] as const) {
      if (!t.includes(mark)) continue;
      const u = uidOf(mark);
      if ("out" in u) { fail(s, `the uid of ${accounts[mark]}`, u.out); return null; }
      t = t.split(mark).join(u.uid);
    }
    return t;
  };
  // The settings file, as its user reads it: at most SETTINGS_MAX bytes, within 30 s; or why not.
  const readSettings = (as: string): { text: string } | { why: string } => {
    const r = exec(["timeout", "-s", "KILL", "30", "head", "-c", String(SETTINGS_MAX + 1), "--", d.envFile], { as });
    if (r.code !== 0) return { why: `${as} cannot read ${d.envFile}` };
    if (Buffer.byteLength(r.out) > SETTINGS_MAX) return { why: `${d.envFile} is larger than ${SETTINGS_MAX} bytes` };
    return { text: r.out };
  };
  let changed = false;
  for (const s of steps) {
    log(`→ ${s.id}: ${s.why}`);
    for (const a of s.actions) {
      if ("run" in a) {
        if (a.unless && exec(a.unless).code === 0) continue;
        const argv = a.run.map((x) => (x === CHANGED_MARK ? (changed ? "1" : "0") : x));
        const r = exec(argv, a.as ? { as: a.as } : {});
        if (r.code !== 0) return fail(s, a.fail ?? line(argv), r.out);
        if (a.changes) changed = true;
        if (a.say && r.out.trim()) log(printable(r.out.trim()).split("\n").slice(-6).map((l) => `    ${l}`).join("\n"));
      } else if ("dir" in a) {
        const why = (d.dir ?? ((x: DirAction) => { const ids = idsOf(exec, x.owner, x.group); return typeof ids === "string" ? ids : ensureSharedDir(x, ids); }))(a);
        if (why !== null) return fail(s, `folder ${a.dir}`, why);
      } else if ("settingsCheck" in a) {
        const read = readSettings(a.as);
        if ("why" in read) return fail(s, read.why, "");
        // The uids are known later: a plain number stands in for each mark.
        const set = Object.fromEntries(Object.entries(a.settingsCheck).map(([k, v]) => [k, v.split(AGENT_UID_MARK).join("1").split(CHIEF_UID_MARK).join("1")]));
        const next = settingsText(read.text, set);
        if (typeof next !== "string") return fail(s, `${d.envFile}: ${next.refused}. Change that, then run the set-up again.`, "");
      } else if ("write" in a) {
        // Root's own folders only (/etc): a new name, checked, its owner and mode, then its place.
        const tmp = `${a.write}.tmp-strong`;
        const text = fill(s, a.text);
        if (text === null) return 1;
        write(tmp, text);
        if (a.check) {
          const r = exec([...a.check, tmp]);
          if (r.code !== 0) { exec(["rm", "-f", tmp]); return fail(s, `${a.check.join(" ")} ${tmp}`, r.out); }
        }
        for (const argv of [["chown", `${a.owner}:${a.group}`, tmp], ["chmod", a.mode.toString(8), tmp], ["mv", "-f", tmp, a.write]]) {
          const r = exec(argv);
          if (r.code !== 0) return fail(s, line(argv), r.out);
        }
      } else {
        // The settings file is the console user's: that user reads it and writes it. systemd reads it
        // for the console: root writes only a text that systemd reads with the new values, and
        // reads it back. No text of the file is ever printed (it holds secrets).
        const read = readSettings(a.as);
        if ("why" in read) return fail(s, read.why, "");
        const cur = read.text;
        const set: Record<string, string> = {};
        for (const [k, v] of Object.entries(a.env)) {
          const filled = fill(s, v);
          if (filled === null) return 1;
          set[k] = filled;
        }
        // The same values for systemd: no write, and nothing for the restart to do.
        const now = systemdValues(cur);
        if (settingsRefusal(cur) === null && Object.entries(set).every(([k, v]) => now.get(k) === v)) continue;
        const next = settingsText(cur, set);
        if (typeof next !== "string") return fail(s, `${d.envFile}: ${next.refused}. Change that, then run the set-up again.`, "");
        changed = true;
        const w = exec(["sh", "-c", 'umask 077 && cat > "$1.strong-new" && mv -f "$1.strong-new" "$1"', "sh", d.envFile], { as: a.as, input: next });
        if (w.code !== 0) return fail(s, `${a.as} cannot write ${d.envFile}`, "");
        // Success only when the file says the new values, by the rules that systemd reads it with.
        const back = readSettings(a.as);
        const got = "why" in back ? null : systemdValues(back.text);
        if (got === null || "why" in back || settingsRefusal(back.text) !== null || !Object.entries(set).every(([k, v]) => got.get(k) === v)) {
          return fail(s, `${d.envFile} does not hold the new settings after the write`, "");
        }
      }
    }
  }
  log(`✔ Strong protection is set up. ${PRODUCT} runs with it now (on a server where it did not run: from its first start).`);
  return 0;
}

// Root's own lookup of the console user: its uid and its home.
export function lookupUser(user: string, exec: Exec): Who | null {
  const r = exec(["getent", "passwd", user]);
  const p = r.out.trim().split(":");
  if (r.code !== 0 || p.length < 7 || p[0] !== user || !/^[0-9]+$/.test(p[2]) || !okPath(p[5])) return null;
  return { user, uid: Number(p[2]), home: p[5] };
}

// ------------------------------------------------------------------ the settings file

// The console's settings file, as systemd reads it for the console (EnvironmentFile=;
// src/basic/env-file.c parse_env_file_internal of systemd 255, the system of Ubuntu 24.04): each
// assignment, and where its text is: [start, stop) from its key's first character to the line end
// that ends its value (that line end is not in it), `end` after that line end. A line end is "\n"
// or "\r"; white space is " ", "\t" and line ends only (not U+00A0, not a BOM); "#" or ";" where a
// key may start opens a comment; a value may be quoted ('…', "…"), and a quote or a backslash
// before a line end joins lines.
export type Assign = { key: string; value: string; start: number; stop: number; end: number };
export type EnvRead = { assigns: Assign[]; state: string; quoteAt: number };

export function readSystemdEnv(text: string): EnvRead {
  const NL = "\n\r", WS = " \t\n\r";
  const assigns: Assign[] = [];
  let state = "PRE_KEY", key = "", value = "", keyWs = -1, valueWs = -1, start = 0, quoteAt = -1;
  const push = (at: number, nl: boolean) => {
    const k = keyWs >= 0 ? key.slice(0, keyWs) : key;
    const v = state === "VALUE" && valueWs >= 0 ? value.slice(0, valueWs) : value;
    assigns.push({ key: k, value: v, start, stop: at, end: nl ? at + 1 : at });
    key = ""; value = "";
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    switch (state) {
      case "PRE_KEY":
        if (c === "#" || c === ";") state = "COMMENT";
        else if (!WS.includes(c)) { state = "KEY"; keyWs = -1; key = c; start = i; }
        break;
      case "KEY":
        if (NL.includes(c)) { state = "PRE_KEY"; key = ""; }
        else if (c === "=") { state = "PRE_VALUE"; valueWs = -1; value = ""; }
        else { if (!WS.includes(c)) keyWs = -1; else if (keyWs < 0) keyWs = key.length; key += c; }
        break;
      case "PRE_VALUE":
        if (NL.includes(c)) { push(i, true); state = "PRE_KEY"; }
        else if (c === "'") { state = "SINGLE_QUOTE_VALUE"; quoteAt = i; }
        else if (c === '"') { state = "DOUBLE_QUOTE_VALUE"; quoteAt = i; }
        else if (c === "\\") state = "VALUE_ESCAPE";
        else if (!WS.includes(c)) { state = "VALUE"; value += c; }
        break;
      case "VALUE":
        if (NL.includes(c)) { push(i, true); state = "PRE_KEY"; }
        else if (c === "\\") { state = "VALUE_ESCAPE"; valueWs = -1; }
        else { if (!WS.includes(c)) valueWs = -1; else if (valueWs < 0) valueWs = value.length; value += c; }
        break;
      case "VALUE_ESCAPE":
        state = "VALUE";
        if (!NL.includes(c)) value += c;
        break;
      case "SINGLE_QUOTE_VALUE":
        if (c === "'") state = "PRE_VALUE"; else value += c;
        break;
      case "DOUBLE_QUOTE_VALUE":
        if (c === '"') state = "PRE_VALUE"; else if (c === "\\") state = "DOUBLE_QUOTE_VALUE_ESCAPE"; else value += c;
        break;
      case "DOUBLE_QUOTE_VALUE_ESCAPE":
        state = "DOUBLE_QUOTE_VALUE";
        if ('"\\`$'.includes(c)) value += c; else if (c !== "\n") value += `\\${c}`;
        break;
      case "COMMENT":
        if (c === "\\") state = "COMMENT_ESCAPE"; else if (NL.includes(c)) state = "PRE_KEY";
        break;
      case "COMMENT_ESCAPE":
        state = NL.includes(c) ? "PRE_KEY" : "COMMENT";
        break;
    }
  }
  if (["PRE_VALUE", "VALUE", "VALUE_ESCAPE", "SINGLE_QUOTE_VALUE", "DOUBLE_QUOTE_VALUE", "DOUBLE_QUOTE_VALUE_ESCAPE"].includes(state)) push(text.length, false);
  return { assigns, state, quoteAt };
}

// The values that systemd reads: the last assignment of a key wins.
export function systemdValues(text: string): Map<string, string> {
  return new Map(readSystemdEnv(text).assigns.map((a) => [a.key, a.value]));
}

// A value that root writes into the settings: a path or a number, nothing that systemd reads
// otherwise (no space, quote or backslash).
const PLAIN_VALUE = /^[A-Za-z0-9._/:@-]*$/;
const lineOf = (text: string, at: number): number => text.slice(0, at).split(/\r\n|\n|\r/).length;

// Why root does not write these keys into this text, or null. Refused: a NUL (systemd stops reading
// there), bytes that are not UTF-8 (systemd refuses them in a key or a value; root reads the text
// as UTF-8, so it cannot tell such bytes from the character U+FFFD, and refuses both, in a comment
// too), a comment line that ends with a
// backslash (systemd before 254 joins the next line to it), and a text that ends inside a quoted
// value or after a backslash (a key added at the end would be in it). Every other form is read by
// systemd's rules (CRLF, "KEY = v", quotes, "export X=1", a backslash at a line end).
export function settingsRefusal(text: string): string | null {
  if (text.includes("\u0000")) return `line ${lineOf(text, text.indexOf("\u0000"))} holds a NUL character`;
  if (text.includes("\ufffd")) return `line ${lineOf(text, text.indexOf("\ufffd"))} holds bytes that are not UTF-8, or the character U+FFFD (root cannot tell them apart)`;
  const lines = text.split(/\r\n|\n|\r/);
  for (let n = 0; n < lines.length; n++) if (/^[ \t]*[#;]/.test(lines[n]) && lines[n].endsWith("\\")) return `line ${n + 1} is a comment that ends with a backslash`;
  const r = readSystemdEnv(text);
  if (r.state.includes("QUOTE")) return `the quoted value of line ${lineOf(text, r.quoteAt)} does not end`;
  if (r.state === "VALUE_ESCAPE") return "the last line ends with a backslash";
  return null;
}

// The text with these keys set, by systemd's reading: the first assignment of a key becomes
// KEY=value (its line end stays), its other assignments go (with their line ends), a key that is
// not there is added at the end. Every other character stays. Refused (a string) when the text is
// refused, a value is not plain, or the result would not read as the old values with these set.
export function settingsText(text: string, set: Record<string, string>): string | { refused: string } {
  const why = settingsRefusal(text);
  if (why) return { refused: why };
  for (const [k, v] of Object.entries(set)) if (!PLAIN_VALUE.test(v)) return { refused: `the value of ${k} is not plain` };
  const r = readSystemdEnv(text);
  const cuts: { from: number; to: number; put: string }[] = [];
  const done = new Set<string>();
  for (const a of r.assigns) {
    if (!Object.hasOwn(set, a.key)) continue;
    cuts.push(done.has(a.key) ? { from: a.start, to: a.end, put: "" } : { from: a.start, to: a.stop, put: `${a.key}=${set[a.key]}` });
    done.add(a.key);
  }
  let out = "";
  let at = 0;
  for (const c of cuts) { out += text.slice(at, c.from) + c.put; at = c.to; }
  out += text.slice(at);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  for (const [k, v] of Object.entries(set)) {
    if (done.has(k)) continue;
    if (out.length > 0 && readSystemdEnv(out).state !== "PRE_KEY") out += eol;
    out += `${k}=${v}${eol}`;
  }
  const want = systemdValues(text);
  for (const [k, v] of Object.entries(set)) want.set(k, v);
  const got = systemdValues(out);
  const same = got.size === want.size && [...want].every(([k, v]) => got.get(k) === v);
  return same && settingsRefusal(out) === null ? out : { refused: "the keys cannot be set so that systemd reads them" };
}

// ------------------------------------------------------- the facts, through a pipe

export const FACTS_MAX = 64 * 1024;
// Output of another account's command, as root prints it: printable characters only (no terminal
// escape, no false line of root).
export const printable = (s: string): string => s.replace(/[^\n\x20-\x7e]/g, "?");
export const FACTS_SECONDS = 90;

// A command of another user whose output root reads: at most `max` bytes, within `ms`. Then root
// stops reading, kills the command's process group, and goes on: a process of that user that
// keeps the pipe open (it left the group) holds root no longer.
export type PipeResult = { code: number; out: string } | { why: string };
export const STDERR_MAX = 4096;
export type Pipe = (argv: string[], o: { as: string; max: number; ms: number }) => Promise<PipeResult>;

export function pipeRun(argv: string[], max: number, ms: number): Promise<PipeResult> {
  return new Promise((done) => {
    const c = spawn(argv[0], argv.slice(1), { cwd: "/", env: ROOT_ENV as unknown as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const out: Buffer[] = [];
    let size = 0;
    let err = "";
    let ended = false;
    // After the exit of the child its group id can belong to another process: no kill then.
    let exited = false;
    const end = (r: PipeResult, kill: boolean) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      if (kill && !exited && c.pid) { try { process.kill(-c.pid, "SIGKILL"); } catch { /* gone */ } }
      c.stdout.destroy();
      c.stderr.destroy();
      done(r);
    };
    const timer = setTimeout(() => end({ why: `no answer within ${Math.round(ms / 1000)} s` }, true), ms);
    c.stdout.on("data", (b: Buffer) => {
      size += b.length;
      if (size > max) end({ why: `more than ${max} bytes` }, true);
      else out.push(b);
    });
    c.stderr.on("data", (b: Buffer) => { if (err.length < STDERR_MAX) err = `${err}${b.toString("utf8")}`.slice(0, STDERR_MAX); });
    c.on("exit", () => { exited = true; });
    c.on("error", (e) => end({ why: e.message }, false));
    c.on("close", (code) => {
      const text = Buffer.concat(out).toString("utf8");
      end({ code: code ?? 1, out: code === 0 ? text : `${text}${err}` }, false);
    });
  });
}

export const realPipe: Pipe = (argv, o) => pipeRun(["runuser", "-u", o.as, "--", ...argv], o.max, o.ms);

// The console user's facts: the product's own path functions (bin/lib/strong.ts strongFacts), from
// its code folder `app`, with a clean env. Its own `timeout` ends it too.
export function factsArgv(app: string, home: string, path: string): string[] {
  return [
    "sh", "-c", `cd "$1" && exec timeout -s KILL ${FACTS_SECONDS} env -i HOME="$2" PATH="$3" node_modules/.bin/tsx ${NAMES.cliEntry} strong-setup --print-facts`,
    "sh", app, home, path,
  ];
}

export async function readFacts(pipe: Pipe, user: string, home: string, app: string, path: string): Promise<unknown> {
  const r = await pipe(factsArgv(app, home, path), { as: user, max: FACTS_MAX, ms: (FACTS_SECONDS + 5) * 1000 });
  if ("why" in r) throw new Error(`The facts of ${user} could not be read: ${r.why}.`);
  if (r.code !== 0) throw new Error(`The facts of ${user} could not be read:\n${printable(r.out.trim().slice(-600))}`);
  try { return JSON.parse(r.out); } catch { throw new Error(`The facts of ${user} are not readable.`); }
}

// ------------------------------------------------------------------ the root copy

// Root's own state folder (the updater's: release-format.md §10).
export const ROOT_STATE_DIR = "/var/lib/choibot-update";
// The folders of the system: no fact of a root copy run may point into one, or be a folder above one.
const SYSTEM_DIRS = ["/etc", "/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/boot", "/root", "/proc", "/sys", "/dev", "/run", "/var", ROOT_STATE_DIR];
// What root runs or installs from the copy: these must be there (copyRefusal checks the whole copy).
export const COPY_FILES = ["node/bin/node", "app/bin/lib/strong-root.ts", "app/deploy/choibot-agent-exec", "gh/bin/gh"];
export const COPY_DIRS = ["node", "node/bin", "app", "app/bin", "app/bin/lib", "app/deploy", "gh", "gh/bin"];
// The format's cap on the entries of a release (release-format.md §3; scripts/release/build.sh).
export const COPY_ENTRIES_MAX = 400_000;
export type RootCopy = { copy: string };

// The facts that the plan of a root copy uses, by field. The tools of the facts (nodeDir, claude,
// gh, dtach) are not used: Node and gh come from the copy, and Claude Code and dtach stay.
function usedFacts(f: StrongFacts): [string, string][] {
  const one: [string, string | null][] = [
    ["app", f.app], ["envFile", f.envFile], ["widgetsDir", f.widgetsDir], ["workspace", f.workspace], ["worktreeRoot", f.worktreeRoot],
    ["agentDataDir", f.agentDataDir], ["claudeDir", f.claudeDir],
  ];
  return [
    ...one.filter((x): x is [string, string] => x[1] !== null),
    ...f.privateDirs.map((p): [string, string] => ["privateDirs", p]), ...f.privateFiles.map((p): [string, string] => ["privateFiles", p]),
  ];
}

const inOrAt = (p: string, d: string): boolean => p === d || p.startsWith(`${d}/`);

// Why these facts are refused for a run from the root copy `copy` (the field, and where it points),
// or null. A used fact may not be in, or a folder above: the copy, a folder of the system (/run and
// /var too), the homes of the other accounts (the agents' homes folder, their home folders, any
// other folder under /home but the console user's own home). The records of the persistent agents
// are only compared (oldLayoutRefusal): their folders are in the agents' homes folder.
export function factRefusal(f: StrongFacts, copy: string, o: StrongOpts = STRONG_DEFAULTS): string | null {
  if (f.unit !== NAMES.unit) return `unit: not ${NAMES.unit}`;
  const closed = [copy, ...SYSTEM_DIRS, o.homesRoot, `/home/${o.agentUser}`, `/home/${o.chiefUser}`];
  const check = (k: string, p: string, also: string[]): string | null => {
    if (p === "/") return `${k}: the root folder`;
    const name = (d: string) => (d === copy ? "the root copy of the release" : d);
    const inside = [...closed, ...also].find((d) => inOrAt(p, d));
    if (inside) return `${k}: in ${name(inside)}`;
    const above = [...closed, ...also].find((d) => d.startsWith(`${p}/`));
    if (above) return `${k}: a folder above ${name(above)}`;
    if (inOrAt(p, "/home") && !inOrAt(p, f.home)) return `${k}: in /home, outside the home of ${f.user}`;
    return null;
  };
  for (const [k, p] of usedFacts(f)) { const why = check(k, p, []); if (why) return why; }
  for (const x of f.persistent) {
    const why = check("persistent", x.cwd, []);
    if (why && !inOrAt(x.cwd, o.homesRoot)) return why;
  }
  return null;
}

// root's alone: a real folder or file of root that no other account can write (no setuid or setgid
// file). A link: root's (its own mode means nothing); it is not followed.
const rootsOnly = (st: Stats, dir: boolean): boolean =>
  !st.isSymbolicLink() && (dir ? st.isDirectory() : st.isFile()) && st.uid === 0 && (st.mode & 0o022) === 0 && (dir || (st.mode & 0o6000) === 0);

export type CopyFs = { lstat: (p: string) => Stats; readdir: (p: string) => string[] };
const REAL_COPY_FS: CopyFs = { lstat: lstatSync, readdir: (p) => readdirSync(p) };

// Why root does not run from this copy, or null: every folder from the copy up to /, and every entry
// of the copy (links not followed), must be root's alone; what root runs or installs must be there.
export function copyRefusal(copy: string, fsx: CopyFs = REAL_COPY_FS, max = COPY_ENTRIES_MAX): string | null {
  if (!okPath(copy)) return `${copy} is not a plain full path`;
  const stat = (p: string): Stats | string => { try { return fsx.lstat(p); } catch { return `${p} is not there`; } };
  const notRoots = (p: string, what: string) => `${p} is not a ${what} of root that only root can write`;
  for (let d = copy; ; d = dirname(d)) {
    const st = stat(d);
    if (typeof st === "string") return st;
    if (!rootsOnly(st, true)) return notRoots(d, "folder");
    if (d === "/") break;
  }
  for (const [list, dir] of [[COPY_DIRS, true], [COPY_FILES, false]] as const) {
    for (const x of list) {
      const st = stat(join(copy, x));
      if (typeof st === "string") return st;
      if (!rootsOnly(st, dir)) return notRoots(join(copy, x), dir ? "folder" : "file");
    }
  }
  const todo = [copy];
  let seen = 0;
  while (todo.length > 0) {
    const d = todo.pop()!;
    for (const name of fsx.readdir(d)) {
      if (++seen > max) return `${copy} holds more than ${max} entries`;
      const p = join(d, name);
      const st = stat(p);
      if (typeof st === "string") return st;
      if (st.isSymbolicLink()) { if (st.uid !== 0) return `${p} is a link that is not root's`; continue; }
      if (st.isDirectory()) { if (!rootsOnly(st, true)) return notRoots(p, "folder"); todo.push(p); continue; }
      if (!st.isFile()) return `${p} is not a file, a folder or a link`;
      if (!rootsOnly(st, false)) return notRoots(p, "file");
    }
  }
  return null;
}

// The process of a root copy run.
export type Proc = { env: Record<string, string | undefined>; execArgv: string[]; execPath: string; cwd: string; uid: number; self: string };

// The copy of this file's own run: <copy>/app/bin/lib/strong-root.ts.
export const copyOf = (self: string): string => resolve(dirname(self), "..", "..", "..");

export function processRefusal(p: Proc, copy: string): string | null {
  if (p.uid !== 0) return "The set-up from a root copy changes root's files: run it as root.";
  const keys = Object.keys(p.env).filter((k) => p.env[k] !== undefined);
  if (keys.length !== 1 || p.env.PATH !== FIXED_PATH) return `The environment must be PATH=${FIXED_PATH} and nothing else (env -i): no NODE_OPTIONS, no other key.`;
  if (p.execArgv.length > 0) return "Node runs with options: run it with none.";
  if (p.execPath !== join(copy, "node", "bin", "node")) return `Node must be the copy's own (${join(copy, "node", "bin", "node")}).`;
  if (p.self !== join(copy, "app", "bin", "lib", "strong-root.ts")) return "This file is not in the app folder of a copy.";
  if (p.cwd !== copy && !p.cwd.startsWith(`${copy}/`)) return `The working folder must be in the copy (${copy}).`;
  return null;
}

// One root file from the copy: root reads root's file, writes it under a new name with its owner
// and mode, and renames it into place (a process that has the old one open keeps it). The same
// bytes in a regular file: no copy. The owner and the mode are set each time.
function fromRootCopy(src: string, dest: string, mode: string): Action[] {
  const same = ["sh", "-c", 'test -f "$2" && test ! -L "$2" && cmp -s -- "$1" "$2"', "sh", src, dest];
  return [
    { run: ["install", "-o", "root", "-g", "root", "-m", mode, "-T", "--", src, `${dest}.new`], unless: same },
    { run: ["mv", "-f", "-T", "--", `${dest}.new`, dest], unless: same },
    { run: ["chown", "root:root", "--", dest] },
    { run: ["chmod", mode, "--", dest] },
  ];
}

// Node from the copy ($1) into the tools folder ($2); every mode is set by `chmod -R a+rX,go-w`, so
// no umask changes them (procOf fixes root's umask too). The same files
// (diff -rq): no copy, but the owner and the modes are set again (the same bytes are not enough).
// Else a new folder of root, checked like the user's Node of a first set-up, then two renames.
// Between the two renames there is NO folder $2, for the start of the second mv (about 3 ms,
// measured on an 8-core server): a start of node in that moment fails. A process that runs keeps
// its files.
export const NODE_FROM_COPY = [
  "set -o pipefail",
  'if [ -d "$2" ] && [ ! -L "$2" ] && diff -rq --no-dereference -- "$1" "$2" > /dev/null 2>&1; then',
  '  chown -R -h root:root -- "$2" && chmod -R a+rX,go-w,u-s,g-s -- "$2" || exit 1',
  '  echo "Node is the release\'s already: its owner and modes are set, no other change."; exit 0',
  'fi',
  'rm -rf -- "$2.new" "$2.old" && install -d -o root -g root -m 0700 -- "$2.new" || exit 1',
  'tar -C "$1" -cf - . | tar -C "$2.new" -xf - --no-same-owner --no-same-permissions || exit 1',
  'chmod -R a+rX,go-w,u-s,g-s -- "$2.new" || exit 1',
  'if [ -n "$(find "$2.new" \\( -type b -o -type c -o -type p -o -type s -o -perm /6000 \\) -print -quit)" ]; then echo "The Node folder of the release holds a device, a pipe, a socket or a setuid file."; rm -rf -- "$2.new"; exit 1; fi',
  'chmod 0755 -- "$2.new" || exit 1',
  'if [ -e "$2" ] || [ -L "$2" ]; then mv -T -- "$2" "$2.old" || exit 1; fi',
  'mv -T -- "$2.new" "$2" || exit 1',
  'rm -rf -- "$2.old"',
  'echo "Node is the release\'s now."',
].join("\n");

// The console does not run: no process in the cgroup of its unit or below it (cgroup.events:
// "populated 1") under the user manager. The account can make more folders of that name in its
// part of the tree: each one is tested (at most CGROUP_NAMES_MAX of them; more is a refusal), with
// one `find` under a time limit and the shell's own reads. The agents run in scopes of their own,
// so they are not in it. A process of the account outside the unit's cgroup is not looked for:
// the accepted limit (that account owns the console). Its arguments: the console's uid, the unit
// (root's fixed name), the cgroup root. Run by bash.
export const CGROUP_NAMES_MAX = 100;
export const CONSOLE_STOPPED_CHECK = [
  'systemctl is-active --quiet "user@$1.service" || { echo "The user manager does not run: the console does not run."; exit 0; }',
  'cg=$(systemctl show -p ControlGroup --value "user@$1.service")',
  '[ -n "$cg" ] && [ -d "$3$cg" ] || { echo "The cgroup of the user manager of $1 is not there."; exit 1; }',
  // find exits 1 when a folder goes away during its walk (an agent's scope that ended): such a
  // folder held no process, so the list goes on. The time limit (timeout: 124, or 137 with KILL)
  // and any other failure (find cannot run) refuse.
  'list=$(timeout -s KILL 20 find "$3$cg" -type d -name "$2" -print 2>/dev/null); rc=$?',
  'if [ "$rc" = 124 ] || [ "$rc" = 137 ]; then echo "The cgroup tree of the user manager of $1 could not be read within 20 seconds."; exit 1; fi',
  'if [ "$rc" != 0 ] && [ "$rc" != 1 ]; then echo "The cgroup tree of the user manager of $1 could not be read (find: $rc)."; exit 1; fi',
  'n=0',
  'while IFS= read -r d; do',
  '  [ -n "$d" ] || continue',
  '  n=$((n + 1))',
  `  [ "$n" -le ${CGROUP_NAMES_MAX} ] || { echo "More than ${CGROUP_NAMES_MAX} folders named $2 in the cgroup tree of the user manager of $1."; exit 1; }`,
  '  [ -r "$d/cgroup.events" ] || continue',
  '  while IFS= read -r l; do [ "$l" = "populated 1" ] && { echo "The console ($2) runs."; exit 1; }; done < "$d/cgroup.events"',
  'done <<< "$list"',
  'echo "The console does not run."',
].join("\n");

// ------------------------------------------------------------------ the run from a root copy

const USAGE = `strong-root.ts --user <console user> --app <its running code folder> [--dry-run]
  Root's set-up of strong protection from a root copy of a release (see the head of this file).`;

export type RootCopyDeps = {
  proc: Proc; out: (s: string) => void; err: (s: string) => void;
  copyFs?: CopyFs; exec?: Exec; pipe?: Pipe; dir?: (a: DirAction) => string | null; writeFile?: (path: string, text: string) => void;
  findOldHomes?: (o: StrongOpts, consoleUid: number) => string[];
};

export async function runRootCopy(argv: string[], d: RootCopyDeps): Promise<number> {
  let user: string | undefined, app: string | undefined, dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { d.out(USAGE); return 0; }
    if (a === "--dry-run") dryRun = true;
    else if (a === "--user" && i + 1 < argv.length) user = argv[++i];
    else if (a === "--app" && i + 1 < argv.length) app = argv[++i];
    else { d.err(`✖ Unknown: ${a}\n${USAGE}`); return 2; }
  }
  if (!user || !USER_RE.test(user)) { d.err("✖ --user is not a user name."); return 2; }
  if (!okPath(app)) { d.err("✖ --app is not a plain full path."); return 2; }
  const copy = copyOf(d.proc.self);
  const bad = processRefusal(d.proc, copy) ?? copyRefusal(copy, d.copyFs);
  if (bad) { d.err(`✖ ${bad}`); return 1; }
  const exec = d.exec ?? realExec;
  try {
    const who = lookupUser(user, exec);
    if (!who) { d.err(`✖ There is no account ${user} on this server.`); return 1; }
    // The running code's Node: <home of the install>/node, as install.sh makes it.
    const raw = await readFacts(d.pipe ?? realPipe, user, who.home, app, `${join(dirname(app), "node", "bin")}:/usr/bin:/bin`);
    const facts = checkFacts(raw, who);
    if ("refused" in facts) { d.err(`✖ The facts are refused: ${facts.refused}.`); return 1; }
    if (facts.app !== app) { d.err("✖ The facts are refused: app: the facts are of another code folder."); return 1; }
    const steps = strongPlan(facts, STRONG_DEFAULTS, { oldHomes: (d.findOldHomes ?? findOldHomes)(STRONG_DEFAULTS, who.uid) }, { copy });
    if (dryRun) { d.out(planText(steps)); return 0; }
    return applyPlan(steps, { exec, envFile: facts.envFile, log: d.out, opts: STRONG_DEFAULTS, dir: d.dir, writeFile: d.writeFile });
  } catch (e) {
    d.err(`✖ ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

const realOr = (p: string): string => { try { return realpathSync(p); } catch { return p; } };

// The process of this run, as the checks see it: root's umask fixed (Node's folder of the tools is
// made with it), and the real paths of Node and of this file.
export function procOf(p: Pick<NodeJS.Process, "env" | "execArgv" | "execPath" | "cwd" | "getuid" | "umask">, self: string): Proc {
  p.umask(0o022);
  return { env: { ...p.env }, execArgv: [...p.execArgv], execPath: realOr(p.execPath), cwd: p.cwd(), uid: p.getuid?.() ?? -1, self: realOr(self) };
}

// Run as a program (not when another module imports this file).
const SELF = fileURLToPath(import.meta.url);
if (process.argv[1] && realOr(resolve(process.argv[1])) === realOr(SELF)) {
  runRootCopy(process.argv.slice(2), { proc: procOf(process, SELF), out: (s) => console.log(s), err: (s) => console.error(s) }).then(
    (code) => { process.exitCode = code; },
    (e: unknown) => { console.error(`✖ ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; },
  );
}
