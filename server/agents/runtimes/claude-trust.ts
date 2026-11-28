// server/agents/runtimes/claude-trust.ts — the first-run marks in a Claude Code config file
// (`<config dir>/.claude.json`). Nobody answers a first-run screen in a console PTY.
// - markOnboarded / ONBOARD_JS: hasCompletedOnboarding, or Claude starts at its theme picker.
// - trustClaudeDir: projects["<real path>"].hasTrustDialogAccepted, also read for each parent
//   dir, or Claude asks "Is this a project you created or one you trust?" and Enter picks
//   "No, exit". Claude Code has no CLI flag or setting that skips it in interactive mode (the
//   help text: only -p or a non-TTY stdout skips it). A trusted parent counts only up to the
//   root of a git repo (Claude Code 2.1.332): in a repo root, only its own key counts. A worker
//   of an own install answers the dialog in its pane (the folder is the user's). A lead's home is
//   marked; an agent's own clone too (strong protection, ONBOARD_JS below).
import { closeSync, existsSync, fchmodSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

export type TrustOutcome = "written" | "already" | "missing" | "invalid" | "failed";

// The kinds whose cwd is a home that the console itself made (chief/homes.ts), outside the
// workspace dir: the console marks that home as trusted. Never a folder of the user.
export const CONSOLE_HOME_KINDS: ReadonlySet<string> = new Set(["lead", "coordinator", "fleet-master"]);

// The fields Claude Code (2.1.x) gives a new project entry when its own dialog
// is accepted: an entry with only the trust key would lack the arrays Claude
// expects there.
const NEW_ENTRY = {
  allowedTools: [], mcpContextUris: [], mcpServers: {}, enabledMcpjsonServers: [], disabledMcpjsonServers: [],
  hasTrustDialogAccepted: false, hasClaudeMdExternalIncludesApproved: false, hasClaudeMdExternalIncludesWarningShown: false,
};

// Running Claude processes rewrite the file too: a read that changed before
// the rename is done again, at most this many times.
const ATTEMPTS = 3;

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// Claude keys the entry by its cwd, which the OS gives as a real path.
function realDir(dir: string): string {
  try { return realpathSync(dir); } catch { return resolve(dir); }
}

// Sets projects[realpath(dir)].hasTrustDialogAccepted = true in configFile when
// it is missing or false; every other key stays as it is. Never creates the
// file and never replaces one that is not a valid config: one [chief] warning,
// no write. Synchronous, so the read → rename window has no await in it; the
// write is a temp file in the same dir with the file's mode, then a rename.
// Never throws.
export function trustClaudeDir(configFile: string, dir: string, warn: (s: string) => void = (s) => console.warn(s)): TrustOutcome {
  const key = realDir(dir);
  return editClaudeConfig(configFile, (cfg) => {
    const projects = cfg.projects ?? {};
    const entry = isObject(projects) ? (projects[key] ?? { ...NEW_ENTRY }) : undefined;
    if (!isObject(projects) || !isObject(entry)) return "invalid";
    if (entry.hasTrustDialogAccepted === true) return "already";
    return { ...cfg, projects: { ...projects, [key]: { ...entry, hasTrustDialogAccepted: true } } };
  }, { what: `${key} not marked trusted`, missing: "Claude may ask to trust the folder" }, warn);
}

// Sets hasCompletedOnboarding = true in configFile when it is not true: the first start of
// Claude Code on a config without it shows the theme picker and the login method, and nobody
// answers them in a console PTY. `claude auth login` does not set it (Claude Code 2.1.332); only
// a finished first-run screen does. Every other key stays as it is. A missing file is made with
// only this key, unless `configDir` (the folder of the login: ~/.claude or CLAUDE_CONFIG_DIR) has
// the old `.config.json`: Claude reads that one then, and a second file would make it warn. The
// rest as trustClaudeDir. Never throws.
export function markOnboarded(configFile: string, configDir: string, warn: (s: string) => void = (s) => console.warn(s)): TrustOutcome {
  return editClaudeConfig(configFile, (cfg) => (cfg.hasCompletedOnboarding === true ? "already" : { ...cfg, hasCompletedOnboarding: true }),
    { what: "its first-run screens not marked done", missing: "Claude may show its theme picker", legacy: join(configDir, ".config.json") }, warn);
}

// The same mark for a spawn through the root helper (strong protection): there the console writes
// nothing into the agents' config (ruling 2c-7-a), so the agent user marks it itself, just before
// Claude starts, with the env Claude gets (CLAUDE_CONFIG_DIR or HOME). Node of AGENT_PATH, as the
// helper's own TRUST_JS. The rules of markOnboarded: a missing file is made only without the old
// .config.json; a file that is not a JSON object is left untouched; temp file, re-stat, rename.
// After each write it reads the file again: a writer that read it before (the helper's trust of a
// repo, with no check before its rename) can put its copy, with no key, over the new one; the key
// is then set once more. The temp file gets its name only when this script made it.
// The agent's own clone (argv[1], named by the console: AGENT_HOME_ROOT/clones/<id>; else ""): the
// helper's repo-clone trusts the clones' folder, but the clone is a git repo root, where Claude
// counts no trusted parent (claude 2.1.332 asks its folder question there). So the clone gets its
// own key: projects["<real path of the clone>"], with the fields of a new entry. Only when the
// clone is the folder Claude starts in (its real path is the cwd), and only when its parent folder
// is trusted in the same file already (the helper's key): never a folder that the helper does not
// trust, never a folder that only the caller names.
// Every failure is silent: Claude then starts as before (its theme picker, shown in its terminal).
export const ONBOARD_JS = `
const fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto");
const dir = process.env.CLAUDE_CONFIG_DIR || "";
const file = dir ? path.join(dir, ".claude.json") : path.join(os.homedir(), ".claude.json");
const legacy = path.join(dir || path.join(os.homedir(), ".claude"), ".config.json");
let clone = "";
try { const c = process.argv[1] || ""; if (c && fs.realpathSync(c) === fs.realpathSync(process.cwd())) clone = fs.realpathSync(c); } catch {}
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const trusted = (j, k) => isObj(j.projects) && isObj(j.projects[k]) && j.projects[k].hasTrustDialogAccepted === true;
const change = (j) => {
  let changed = false;
  if (j.hasCompletedOnboarding !== true) { j.hasCompletedOnboarding = true; changed = true; }
  if (clone && trusted(j, path.dirname(clone)) && !trusted(j, clone)) {
    const cur = isObj(j.projects[clone]) ? j.projects[clone] : {};
    j.projects[clone] = { allowedTools: [], mcpContextUris: [], mcpServers: {}, enabledMcpjsonServers: [], disabledMcpjsonServers: [],
      hasClaudeMdExternalIncludesApproved: false, hasClaudeMdExternalIncludesWarningShown: false, ...cur, hasTrustDialogAccepted: true };
    changed = true;
  }
  return changed;
};
let tmp = "";
try {
  for (let i = 0; i < 5; i++) {
    let target;
    try { target = fs.realpathSync(file); } catch (e) {
      if (e.code !== "ENOENT" || fs.existsSync(legacy)) break;
      try { fs.writeFileSync(file, JSON.stringify({ hasCompletedOnboarding: true }, null, 2), { flag: "wx", mode: 0o600 }); continue; }
      catch (e2) { if (e2.code === "EEXIST") continue; break; }
    }
    const before = fs.statSync(target);
    if (!before.isFile()) break;
    const j = JSON.parse(fs.readFileSync(target, "utf8"));
    if (!isObj(j) || !change(j)) break;
    const t = path.join(path.dirname(target), "." + path.basename(target) + ".onboard-" + process.pid + "-" + crypto.randomBytes(4).toString("hex") + ".tmp");
    fs.writeFileSync(t, JSON.stringify(j, null, 2), { flag: "wx", mode: before.mode & 0o777 });
    tmp = t;
    fs.chmodSync(tmp, before.mode & 0o777);
    const now = fs.statSync(target);
    if (now.ino !== before.ino || now.mtimeMs !== before.mtimeMs || now.size !== before.size) { fs.unlinkSync(tmp); tmp = ""; continue; }
    fs.renameSync(tmp, target);
    tmp = "";
  }
} catch { if (tmp) { try { fs.unlinkSync(tmp); } catch {} } }
`;

// The command of a spawn through the helper: a shell as the agent user runs ONBOARD_JS (with the
// agent's own clone, or ""), then execs `bin` with `args` unchanged (the same process, so dtach
// still hosts Claude itself).
export function onboardedLaunch(bin: string, args: string[], clone?: string): { command: string; args: string[] } {
  return { command: "/bin/sh", args: ["-c", 'node -e "$0" -- "$1" </dev/null >/dev/null 2>&1; shift; exec "$@"', ONBOARD_JS, clone ?? "", bin, ...args] };
}

// One change of a Claude config file, with the checks and the safe write described above.
// `legacy`: a missing file is made (mode 0600) with the change applied to {}, unless that file
// (the old config) is there.
function editClaudeConfig(
  configFile: string,
  change: (cfg: Record<string, unknown>) => Record<string, unknown> | "already" | "invalid",
  say: { what: string; missing: string; legacy?: string },
  warn: (s: string) => void,
): TrustOutcome {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    let target: string;
    try {
      target = realpathSync(configFile); // a symlinked config: write its target, keep the link
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        warn(`[chief] ${configFile} not read (${errText(e)}); ${say.what}`);
        return "failed";
      }
      if (say.legacy === undefined || existsSync(say.legacy)) {
        warn(`[chief] ${configFile} does not exist; ${say.what} (${say.missing})`);
        return "missing";
      }
      const made = change({});
      if (typeof made === "string") return made;
      try {
        const fd = openSync(configFile, "wx", 0o600);
        try { writeSync(fd, JSON.stringify(made, null, 2)); } finally { closeSync(fd); }
        return "written";
      } catch (e2) {
        if ((e2 as NodeJS.ErrnoException).code === "EEXIST") continue; // made meanwhile: read it
        warn(`[chief] ${configFile} not made (${errText(e2)}); ${say.what}`);
        return "failed";
      }
    }
    let tmp: string | undefined;
    try {
      const before = statSync(target);
      if (!before.isFile()) {
        warn(`[chief] ${configFile} is not a regular file; ${say.what}`);
        return "invalid";
      }
      let cfg: unknown;
      try { cfg = JSON.parse(readFileSync(target, "utf8")); } catch (e) {
        warn(`[chief] ${configFile} is not valid JSON (${errText(e)}); left untouched, ${say.what}`);
        return "invalid";
      }
      const next = isObject(cfg) ? change(cfg) : "invalid";
      if (next === "invalid") {
        warn(`[chief] ${configFile} does not have the shape of a Claude config; left untouched, ${say.what}`);
        return "invalid";
      }
      if (next === "already") return "already";
      const mode = before.mode & 0o777;
      tmp = join(dirname(target), `.${basename(target)}.choibot-${process.pid}-${randomBytes(4).toString("hex")}.tmp`);
      const fd = openSync(tmp, "wx", mode);
      try {
        writeSync(fd, JSON.stringify(next, null, 2));
        fchmodSync(fd, mode); // the umask may have narrowed it
      } finally {
        closeSync(fd);
      }
      const now = statSync(target);
      if (now.ino !== before.ino || now.mtimeMs !== before.mtimeMs || now.size !== before.size) {
        unlinkSync(tmp);
        tmp = undefined;
        continue; // a Claude process wrote it meanwhile: read it again
      }
      renameSync(tmp, target);
      return "written";
    } catch (e) {
      if (tmp !== undefined) { try { unlinkSync(tmp); } catch { /* gone */ } }
      warn(`[chief] ${configFile} not updated (${errText(e)}); ${say.what}`);
      return "failed";
    }
  }
  warn(`[chief] ${configFile} kept changing; ${say.what}`);
  return "failed";
}
