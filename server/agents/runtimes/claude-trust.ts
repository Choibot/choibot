// server/agents/runtimes/claude-trust.ts — mark a dir as trusted in a Claude
// Code config file, so an interactive `claude` started there skips its folder
// trust dialog ("Is this a project you created or one you trust?"). Nobody
// answers that dialog in a console PTY, and Enter picks "No, exit". Claude Code
// has no CLI flag or setting that skips it in interactive mode (the help text:
// only -p or a non-TTY stdout skips it); it reads
// `<config dir>/.claude.json` → projects["<real path>"].hasTrustDialogAccepted,
// also for each parent dir. Workers never see the dialog: their worktrees sit
// under the already-trusted workspace dir. A lead's home does not.
import { closeSync, fchmodSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
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
  let target: string;
  try {
    target = realpathSync(configFile); // a symlinked config: write its target, keep the link
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      warn(`[chief] ${configFile} does not exist; ${key} not marked trusted (Claude may ask to trust the folder)`);
      return "missing";
    }
    warn(`[chief] ${configFile} not read (${errText(e)}); ${key} not marked trusted`);
    return "failed";
  }
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    let tmp: string | undefined;
    try {
      const before = statSync(target);
      if (!before.isFile()) {
        warn(`[chief] ${configFile} is not a regular file; ${key} not marked trusted`);
        return "invalid";
      }
      let cfg: unknown;
      try { cfg = JSON.parse(readFileSync(target, "utf8")); } catch (e) {
        warn(`[chief] ${configFile} is not valid JSON (${errText(e)}); left untouched, ${key} not marked trusted`);
        return "invalid";
      }
      const projects = isObject(cfg) ? (cfg.projects ?? {}) : undefined;
      const entry = isObject(projects) ? (projects[key] ?? { ...NEW_ENTRY }) : undefined;
      if (!isObject(cfg) || !isObject(projects) || !isObject(entry)) {
        warn(`[chief] ${configFile} does not have the shape of a Claude config; left untouched, ${key} not marked trusted`);
        return "invalid";
      }
      if (entry.hasTrustDialogAccepted === true) return "already";
      cfg.projects = { ...projects, [key]: { ...entry, hasTrustDialogAccepted: true } };
      const mode = before.mode & 0o777;
      tmp = join(dirname(target), `.${basename(target)}.choibot-${process.pid}-${randomBytes(4).toString("hex")}.tmp`);
      const fd = openSync(tmp, "wx", mode);
      try {
        writeSync(fd, JSON.stringify(cfg, null, 2));
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
      warn(`[chief] ${configFile} not updated (${errText(e)}); ${key} not marked trusted`);
      return "failed";
    }
  }
  warn(`[chief] ${configFile} kept changing; ${key} not marked trusted`);
  return "failed";
}
