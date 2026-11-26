// bin/lib/strong.ts — `strong-setup`: the root set-up that makes a NEW server start in strong
// protection (server/chief/hardened.ts). Agents then run under their own Linux account, so an
// agent cannot read the console's device keys, settings or data. It does, for one server, the
// root steps of the hardening checklist (C1-C7): the agent account and the shared group, the tools both accounts run, the folders and
// their modes, the exec helper with its config and its sudoers line, and the console's settings.
//
//   strong-setup --user <console user> --dry-run   print the plan; change nothing
//   strong-setup --user <console user>             run it (as root)
//   strong-setup --print-facts                     (as the console user) the facts the plan needs
//
// Two halves. The facts come from the console's own user, through the product's own path
// functions (data dirs, workspace, tools): no path is guessed twice. Root trusts none of them as
// they come: every field is checked (a strict shape), and the uid and the home are root's own
// lookup. The plan is a pure function of the checked facts (the unit tests read it). Root runs
// each action with argv and no shell, and stops at the first one that fails. Every step can run
// again: an action whose state is there already is skipped by its `unless` check.
//
// The rule of who does what: an action on a path that the console user can change (its home,
// the code, the workspace, the widget folder, the settings file, the sources of the tools) runs
// AS that user (runuser), so a symbolic link there gives it nothing more than its own rights.
// Root acts only on root's paths: the accounts, /usr/local, /etc, /srv, /run. The tools are read
// by the user and written by root into a root folder (the Node folder as a tar stream).
//
// For a new server (an image build), before any agent runs: root runs the product's code from a
// checkout that the console user can write. On a server where agents already ran, the set-up
// refuses unless the person accepts that (--accept-used-server; deploy/RUNBOOK.md says what it
// means). It refuses an install with the old names, and code, a workspace or a widget folder
// inside the console user's home (the agents must reach them, never the home). Debian or Ubuntu
// (apt-get). The Claude login of the agents is not here: the Set-up page makes it, through the
// helper's claude-auth verb (server/agents/agentlogin.ts).
//
// The second account (server/chief/chiefaccount.ts): the fleet master, the leads and the
// Coordinator run as their own account, which the workers' account cannot enter: its group, its
// homes folder (AGENT_HOME_ROOT/chief), its socket folder, its line in the sudoers file, its keys
// in the helper's config and in the console's settings. Its Claude login is a second sign-in on
// the Set-up page. On a server with persistent agents of the old layout (they ran as the workers'
// account) the set-up stops before any change: their move is not built yet. At the end the
// console starts again (a new group reaches a process only at its start), and the check reads
// the state after that start.
import { spawnSync } from "node:child_process";
import { closeSync, constants, existsSync, fchmodSync, fchownSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync, type Stats } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { DISPLAY_NAME } from "../../server/brand.js";
import { resolveChiefDataDir } from "../../server/chief/paths.js";
import { resolveAppDataDir, resolveClaudeBin, resolveDtachBin, resolveWorkspaceDir, toolBin, type Env } from "../../server/defaults.js";
import { isChiefId } from "../../server/chief/chiefids.js";
import { AREA_RE } from "../../server/chief/leads/areas.js";
import { resolveIssuesDataDir } from "../../server/issues/paths.js";
import { resolveMasterDataDir } from "../../server/master/paths.js";
import { NEW_NAMES, names } from "../../server/names.mjs";
import { SUDO_ENV_KEEP } from "../../server/agents/terminal.js";
import { resolveCronDataDir } from "./cronspec.js";
import { parseEnv, serializeEnv } from "./env.js";

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

const RECORDS_MAX = 64;

// The persistent records of the console user's own record folder (server/agents/store.ts: one
// <id>.json per agent). A file it cannot read or parse is left out.
export function persistentRecords(dir: string): { id: string; cwd: string }[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const out: { id: string; cwd: string }[] = [];
  for (const n of names.sort()) {
    const id = n.endsWith(".json") ? n.slice(0, -5) : "";
    if (!isChiefId(id) || out.length >= RECORDS_MAX) continue;
    try {
      const cwd = (JSON.parse(readFileSync(join(dir, n), "utf8")) as { cwd?: unknown }).cwd;
      if (typeof cwd === "string") out.push({ id, cwd });
    } catch { /* not a record */ }
  }
  return out;
}

const real = (p: string): string | null => {
  if (!isAbsolute(p) || !existsSync(p)) return null;
  try { return realpathSync(p); } catch { return null; }
};

// As the console user, from its checkout: the settings file over the env of the shell.
export function strongFacts(repoDir: string, shell: Env = process.env): StrongFacts {
  const envFile = join(repoDir, ".env");
  const env: Env = { ...shell, ...(existsSync(envFile) ? Object.fromEntries(parseEnv(readFileSync(envFile, "utf8"))) : {}) };
  const inApp = (v: string | undefined, def: string) => resolve(repoDir, v?.trim() || def);
  const base = dirname(repoDir);
  const wt = env.AGENT_WORKTREE_ROOT?.trim() ?? "";
  const agentDataDir = inApp(env.AGENT_DATA_DIR, ".agent-data");
  return {
    user: userInfo().username, uid: process.getuid?.() ?? -1, home: homedir(),
    legacy: names().legacy,
    app: repoDir, envFile,
    privateDirs: [...new Set([
      resolveAppDataDir(env), resolveChiefDataDir(env), resolveCronDataDir(env), resolveMasterDataDir(env), resolveIssuesDataDir(env),
      agentDataDir, inApp(env.SERVICES_DATA_DIR, ".services-data"),
    ])],
    privateFiles: ["install.log", "failed-step.log"].map((f) => join(base, f)).filter((f) => existsSync(f)),
    widgetsDir: inApp(env.WIDGETS_DATA_DIR, ".widgets-data"),
    workspace: resolveWorkspaceDir(env),
    worktreeRoot: isAbsolute(wt) ? wt : null,
    agentDataDir, claudeDir: env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude"),
    nodeDir: dirname(dirname(process.execPath)),
    claude: real(resolveClaudeBin(env)), gh: real(toolBin("gh", undefined, env)), dtach: real(resolveDtachBin(env)),
    unit: names().unit, persistent: persistentRecords(agentDataDir),
  };
}

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
  if (!Array.isArray(pr) || pr.length > RECORDS_MAX || !pr.every((r) => r && typeof r === "object" && typeof r.id === "string" && isChiefId(r.id) && okPath(r.cwd))) return { refused: "persistent" };
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
  agentUser: `${NEW_NAMES.dataDir}-agent`, group: `${NEW_NAMES.dataDir}-shared`,
  homesRoot: `/srv/${NEW_NAMES.dataDir}/agent-homes`, dtachDir: `/run/${NEW_NAMES.dtachDir}`,
  toolsDir: `/usr/local/lib/${NEW_NAMES.dataDir}`,
  helper: "/usr/local/bin/choibot-agent-exec", helperConf: "/etc/choibot-agent-exec.conf",
  sudoers: "/etc/sudoers.d/choibot-agent-exec", tmpfiles: `/etc/tmpfiles.d/${NEW_NAMES.dtachDir}.conf`,
  chiefUser: `${NEW_NAMES.dataDir}-chief`, chiefDtachDir: `/run/${NEW_NAMES.dtachDir}-chief`,
  chiefTmpfiles: `/etc/tmpfiles.d/${NEW_NAMES.dtachDir}-chief.conf`,
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
  | { env: Record<string, string>; as: string };
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
// env keys of SUDO_ENV_KEEP reach it (both spellings, as deploy/choibot-agent-exec.sudoers.example).
export function sudoersText(user: string, o: StrongOpts): string {
  const keep = [...new Set([...SUDO_ENV_KEEP, ...SUDO_ENV_KEEP.map((k) => k.replace(/^CHOIBOT_/, "CHOIBOT_")), ...SUDO_ENV_KEEP.map((k) => k.replace(/^CHOIBOT_/, "CHOIBOT_"))])];
  return [
    `# ${o.sudoers} — written by \`strong-setup\` of ${DISPLAY_NAME}. The console runs its agents through`,
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
    `# ${o.helperConf} — written by \`strong-setup\` of ${DISPLAY_NAME} (see deploy/choibot-agent-exec.conf.example).`,
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
export function strongRefusal(f: StrongFacts): string | null {
  if (f.legacy) return `This ${DISPLAY_NAME} keeps the names of an old install. Strong protection by this set-up is for a new server only.`;
  if (f.uid === 0 || f.user === "root") return `The console must run as its own user, not as root.`;
  const inHome = (p: string) => { const r = relative(f.home, p); return r === "" || (!r.startsWith("..") && !isAbsolute(r)); };
  for (const [what, p] of [["code", f.app], ["workspace", f.workspace], ["widget folder", f.widgetsDir]] as const) {
    if (inHome(p)) return `The ${what} of ${DISPLAY_NAME} (${p}) is inside the home of ${f.user}. The agents must reach it, and never the home: install with CHOIBOT_HOME and --workspace outside the home (for example /opt and /srv).`;
  }
  for (const [what, p] of [["Claude Code", f.claude], ["dtach", f.dtach]] as const) {
    if (p === null) return `${what} is not on this server. Run the install line first.`;
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

export function strongPlan(f: StrongFacts, o: StrongOpts = STRONG_DEFAULTS, r: RootFacts = { oldHomes: [] }): Step[] {
  const why = strongRefusal(f) ?? oldLayoutRefusal(f, o, r);
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
  const steps: Step[] = [];
  if (!o.acceptUsed) {
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
        { run: ["apt-get", "install", "-y", "--no-install-recommends", "acl", "sudo"], unless: ["sh", "-c", "command -v setfacl && command -v visudo"] },
      ],
    },
    {
      id: "accounts",
      why: `The agents' own account (${o.agentUser}, no sudo) and the group it shares with ${u}. The second account (${o.chiefUser}, no sudo) for the fleet master, the leads and the Coordinator: its own group, which ${u} is in and ${o.agentUser} is not.`,
      actions: [
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
        {
          run: ["sh", "-c", '! id -nG -- "$1" | tr " " "\\n" | grep -qx -- "$2"', "sh", o.agentUser, o.chiefUser],
          fail: `${o.agentUser} is in the group ${o.chiefUser}: a worker could read the tokens of the fleet master, the leads and the Coordinator. Remove it (gpasswd -d ${o.agentUser} ${o.chiefUser}), then run the set-up again.`,
        },
        {
          run: ["sh", "-c", 'g=$(id -gn -- "$2") && ! id -nG -- "$1" | tr " " "\\n" | grep -qx -- "$g"', "sh", o.chiefUser, u],
          fail: `${o.chiefUser} is in the group of ${u}: it could read the console's own files. Remove it from that group (gpasswd -d), then run the set-up again.`,
        },
      ],
    },
    {
      id: "tools",
      why: `Node, Claude Code${f.gh ? ", gh" : ""} and dtach in ${o.toolsDir}, owned by root: both accounts run them, and neither can change them. ${u} reads each source.`,
      actions: [
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
      why: `The exec helper (${o.helper}): the one way the console starts a process as ${o.agentUser}.`,
      actions: [
        ...copyAsUser(u, join(f.app, "deploy", "choibot-agent-exec"), o.helper),
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
      why: `The console's settings for strong protection (${u} writes them). They take effect at its start (the next step).`,
      actions: [{
        env: {
          CHIEF_AGENT_UID: AGENT_UID_MARK, AGENT_HOME_ROOT: o.homesRoot, AGENT_CLAUDE_CONFIG_DIR: agentClaude,
          AGENT_DTACH_DIR: o.dtachDir, AGENT_DTACH_BIN: `${bin}/dtach`, CLAUDE_CODE_EXECUTABLE: `${bin}/claude`,
          AGENT_EXEC_HELPER: o.helper,
          CHIEF_PERSISTENT_UID: CHIEF_UID_MARK, AGENT_CHIEF_CLAUDE_CONFIG_DIR: chiefClaude, AGENT_CHIEF_DTACH_DIR: o.chiefDtachDir,
        },
        as: u,
      }],
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
  return steps;
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
      else out.push(`settings, as ${a.as}: ${Object.entries(a.env).map(([k, v]) => `${k}=${v}`).join(" ")}`);
    }
    out.push("");
  }
  return out.join("\n");
}

export type Exec = (argv: string[], o?: { as?: string; input?: string }) => { code: number; out: string };

const realExec: Exec = (argv, o = {}) => {
  const full = o.as ? ["runuser", "-u", o.as, "--", ...argv] : argv;
  const r = spawnSync(full[0], full.slice(1), {
    encoding: "utf8", input: o.input, cwd: "/",
    env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8", DEBIAN_FRONTEND: "noninteractive" } as unknown as NodeJS.ProcessEnv,
  });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? String(r.error.message) : ""}` };
};

// A folder in a folder that the agents can write and that is sticky (the homes' folder). Made by
// one mkdir (no -p, so nothing that an agent put there is used); when an entry is there, it is
// taken only when it is a real folder whose owner is root or the owner to be: in a sticky folder no
// agent can then rename or replace it. The owner, the group and the mode are set on the folder
// opened with O_NOFOLLOW (fchown, fchmod): no step follows a link. Null when done, else the reason.
export function ensureSharedDir(a: DirAction, ids: { uid: number; gid: number }): string | null {
  const ok = (uid: number) => uid === 0 || uid === ids.uid;
  try {
    mkdirSync(a.dir, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") return `${a.dir} cannot be made (${(e as NodeJS.ErrnoException).code ?? "error"}).`;
    const st = lstatSync(a.dir);
    if (st.isSymbolicLink() || !st.isDirectory() || !ok(st.uid)) return `${a.dir} is there, and it is not a real folder of root${a.owner === "root" ? "" : ` or ${a.owner}`}. Look at it, remove it, and run the set-up again.`;
  }
  let fd: number;
  try {
    fd = openSync(a.dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (e) {
    return `${a.dir} cannot be opened as a folder (${(e as NodeJS.ErrnoException).code ?? "error"}).`;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isDirectory() || !ok(st.uid)) return `${a.dir} changed while the set-up ran. Run it again.`;
    fchownSync(fd, ids.uid, ids.gid);
    fchmodSync(fd, a.mode);
    return null;
  } finally {
    closeSync(fd);
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
    log(`✖ ${s.id}: ${what}\n${out.trim().split("\n").slice(-12).map((l) => `    ${l}`).join("\n")}`);
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
        if (a.say && r.out.trim()) log(r.out.trim().split("\n").slice(-6).map((l) => `    ${l}`).join("\n"));
      } else if ("dir" in a) {
        const why = (d.dir ?? ((x: DirAction) => { const ids = idsOf(exec, x.owner, x.group); return typeof ids === "string" ? ids : ensureSharedDir(x, ids); }))(a);
        if (why !== null) return fail(s, `folder ${a.dir}`, why);
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
        // The settings file is the console user's: that user reads it and writes it.
        const cur = exec(["cat", "--", d.envFile], { as: a.as });
        if (cur.code !== 0) return fail(s, `${a.as} cannot read ${d.envFile}`, cur.out);
        const values = parseEnv(cur.out);
        for (const [k, v] of Object.entries(a.env)) {
          const filled = fill(s, v);
          if (filled === null) return 1;
          values.set(k, filled);
        }
        // The same settings: no write, and nothing for the restart to do.
        if (serializeEnv(values) === serializeEnv(parseEnv(cur.out))) continue;
        changed = true;
        const w = exec(["sh", "-c", 'umask 077 && cat > "$1.strong-new" && mv -f "$1.strong-new" "$1"', "sh", d.envFile], { as: a.as, input: serializeEnv(values) });
        if (w.code !== 0) return fail(s, `${a.as} cannot write ${d.envFile}`, w.out);
      }
    }
  }
  log(`✔ Strong protection is set up. ${DISPLAY_NAME} runs with it now (on a server where it did not run: from its first start).`);
  return 0;
}

// ------------------------------------------------------------------ the command

export type StrongCmd = {
  repoDir: string; user?: string; dryRun?: boolean; printFacts?: boolean; factsFile?: string; acceptUsed?: boolean;
  isRoot?: boolean; exec?: Exec; out?: (s: string) => void; err?: (s: string) => void;
  // A test's stand-in for root's look at the homes' folder.
  findOldHomes?: (o: StrongOpts, consoleUid: number) => string[];
};

const CLI_FILE = NEW_NAMES.cliEntry.replace(/^bin\//, "");

// Root's own lookup of the console user: its uid and its home.
export function lookupUser(user: string, exec: Exec): Who | null {
  const r = exec(["getent", "passwd", user]);
  const p = r.out.trim().split(":");
  if (r.code !== 0 || p.length < 7 || p[0] !== user || !/^[0-9]+$/.test(p[2]) || !okPath(p[5])) return null;
  return { user, uid: Number(p[2]), home: p[5] };
}

// The facts of another user, as that user: the same command with --print-facts, from the same
// checkout, with a clean env. The output is not trusted (checkFacts).
function factsOf(user: string, home: string, repoDir: string, exec: Exec): unknown {
  const r = exec(["sh", "-c", `cd "$1" && exec env -i HOME="$2" PATH="$3" node_modules/.bin/tsx bin/${CLI_FILE} strong-setup --print-facts`, "sh", repoDir, home, `${dirname(process.execPath)}:/usr/bin:/bin`], { as: user });
  if (r.code !== 0) throw new Error(`The facts of ${user} could not be read:\n${r.out.trim().slice(-600)}`);
  try { return JSON.parse(r.out); } catch { throw new Error(`The facts of ${user} are not readable.`); }
}

export async function runStrongSetup(c: StrongCmd): Promise<number> {
  const out = c.out ?? ((s: string) => console.log(s));
  const err = c.err ?? ((s: string) => console.error(s));
  if (c.printFacts) { out(JSON.stringify(strongFacts(c.repoDir))); return 0; }
  const root = c.isRoot ?? process.getuid?.() === 0;
  const exec = c.exec ?? realExec;
  const user = c.user ?? (root ? undefined : userInfo().username);
  if (!user) { err("Give --user <the user of the console>."); return 2; }
  if (!USER_RE.test(user)) { err("✖ --user is not a user name."); return 2; }
  if (c.factsFile && !c.dryRun) { err("✖ A file of facts is for the dry run only."); return 2; }
  if (!c.dryRun && !root) { err("✖ The set-up changes users, folders and sudo rules: run it as root. To read the plan: --dry-run."); return 1; }
  try {
    let raw: unknown;
    if (c.factsFile) raw = JSON.parse(readFileSync(c.factsFile, "utf8"));
    else if (user === userInfo().username) raw = strongFacts(c.repoDir);
    else if (root) raw = undefined;
    else { err(`✖ To read the facts of ${user}, run this as root, or as ${user}.`); return 1; }
    let who = lookupUser(user, exec);
    if (!who) {
      // A dry run on another machine, from a file: its uid and home stand in for the lookup.
      const f = raw as { uid?: unknown; home?: unknown } | undefined;
      if (!(c.dryRun && c.factsFile && typeof f?.uid === "number" && okPath(f?.home))) { err(`✖ There is no account ${user} on this server.`); return 1; }
      who = { user, uid: f.uid, home: f.home };
      out(`(dry run: no account ${user} here; the uid and the home of the file stand in)`);
    }
    if (raw === undefined) raw = factsOf(user, who.home, c.repoDir, exec);
    const facts = checkFacts(raw, who);
    if ("refused" in facts) { err(`✖ The facts are refused: ${facts.refused}.`); return 1; }
    const opts: StrongOpts = { ...STRONG_DEFAULTS, acceptUsed: c.acceptUsed === true };
    // Root's own look at the homes' folder (the dry run too: it shows the stop of the old layout).
    const steps = strongPlan(facts, opts, { oldHomes: (c.findOldHomes ?? findOldHomes)(opts, who.uid) });
    if (c.dryRun) { out(planText(steps)); return 0; }
    return applyPlan(steps, { exec, envFile: facts.envFile, log: out, opts });
  } catch (e) {
    err(`✖ ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
