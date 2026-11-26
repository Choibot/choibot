// bin/install-agent/policy.mjs — the rules of the install agent, as code. The install agent is
// a Claude Code session in the terminal that repairs a failed step of the install
// (bin/lib/repair.ts starts it). Its rules are fixed by the design, and this file decides for
// EACH tool call, before it runs (hook.mjs, a PreToolUse hook):
//
//   allow  with no question: read the state of the server (versions, ports, disk, the log of
//          the console), run a check or a step again, change the console's own folder in the
//          ways a repair needs (its port, its parts, its build, and removing those), restart
//          the console's own service.
//   ask    the person sees the exact command and says yes or no: anything with sudo, a system
//          package, stopping another program, swap, a firewall rule, and every command that
//          this file does not know.
//   deny   never: open a public port, delete a file the console did not make, read the keys
//          or the secrets of other programs, mark a step done (only a check does that: so no
//          pairing code, no write to the console's data, no change to the code of the checks).
//
// "allow" is a short list of exact shapes. Everything else is "ask" or "deny": a command the
// list does not know can never run with no question.
//
// One rule is stricter than the design's words "change files in the console's own folder": a
// free edit of a file there asks first. The folder holds code that the allowed commands run
// (the build reads its config, a check runs the installed parts). An edit with no question
// would be a way around "ask" and "never": write a file, then run an allowed check.
//
// Plain JS with node built-ins only: the hook runs it with the console's own Node, with no
// build step.
import { isAbsolute, relative, resolve } from "node:path";

/**
 * @typedef {object} Ctx
 * @property {string} base the console's own folder (the code, its Node, its command)
 * @property {string} app the code, inside base
 * @property {string} home the home of the user
 * @property {string} user the Linux user
 * @property {string} unit the console's own service
 * @property {string} cronPrefix the prefix of its cron units
 * @property {string} dataDir the console's data (devices, tickets): never touched here
 * @property {string} cli the installed command, as a full path
 * @property {string[]} cliNames the names of the command (server/brand.ts)
 * @property {string} [cwd] the folder the tool call runs in
 */
/** @typedef {{ decision: "allow" | "ask" | "deny", reason: string }} Verdict */

const allow = (reason) => ({ decision: "allow", reason });
const ask = (reason) => ({ decision: "ask", reason });
const deny = (reason) => ({ decision: "deny", reason });

const NEVER_SECRET = "The install agent never reads the keys or the secrets of a program.";
const NEVER_DONE = "The install agent cannot mark a step done or change a check. Only the check of a step does that.";
const NEVER_PUBLIC = "The install agent never opens a public door to your server.";
const NEVER_DELETE = "The install agent never deletes a file that the console did not make.";
const NEVER_NET = "The install agent has no web tool and starts no other agent.";

/** p is root or inside it (path boundaries, after `..` is resolved). */
export function inside(p, root) {
  const rel = relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** A path as the tool would open it: `~` is the home, a relative path starts at cwd. */
export function absPath(p, ctx) {
  const s = p === "~" ? ctx.home : p.startsWith("~/") ? `${ctx.home}/${p.slice(2)}` : p;
  return resolve(ctx.cwd ?? ctx.base, s);
}

// A path, or a text with a path in it, that holds a key, a login or a secret. The file browser of
// the Server page refuses the same paths (server/files/wide.ts).
export const SECRET_PATH = new RegExp([
  "(^|/)\\.ssh(/|$)", "(^|/)\\.gnupg(/|$)", "(^|/)\\.aws(/|$)", "(^|/)\\.azure(/|$)", "(^|/)\\.kube(/|$)",
  "(^|/)\\.config/(gh|gcloud|op|rclone)(/|$)", "(^|/)\\.docker/config\\.json", "(^|/)\\.netrc$", "(^|/)\\.npmrc$",
  "(^|/)\\.pgpass$", "(^|/)\\.git-credentials$", "(^|/)\\.claude(/|\\.json|$)", "(^|/)\\.claude-accounts(/|$)", "(^|/)\\.codex(/|$)",
  "(^|/)\\.env($|\\.)", "\\.(pem|key|p12|pfx|keystore|jks)$", "(^|/)id_(rsa|dsa|ecdsa|ed25519)", "keypair", "(^|/)user-token$",
  "^/etc/(shadow|gshadow|sudoers)", "^/etc/ssh/", "^/etc/ssl/private", "^/proc/[^/]+/environ$", "^/root(/|$)", "wallet",
].join("|"), "i");

// The same, for the text of a shell command (no path was parsed out of it).
const SECRET_WORD = /\b(auth\s+token|setup-token|show-token|authkey|passwd|password)\b|\.ssh\b|\.gnupg\b|\.aws\b|\.kube\b|\.config\/(gh|gcloud)\b|\.netrc\b|\.npmrc\b|\.pgpass\b|\.git-credentials\b|\.claude\b|\.codex\b|\.env\b|\.pem\b|\bid_(rsa|dsa|ecdsa|ed25519)\b|keypair|user-token|\/etc\/(shadow|gshadow|sudoers)|\/etc\/ssl\/private|\/proc\/[^\s/]+\/environ|(^|\s)\/root(\/|\s|$)|credentials|\bsecret|\bwallet/i;

/** The path holds a secret, or it is the console's own data. */
function secretPath(p, ctx) {
  return SECRET_PATH.test(p) || inside(p, ctx.dataDir);
}

/** A file in the console's own folder that the agent must not change: the code (the checks are in it). */
function protectedPath(p, ctx) {
  return ["server", "bin", "src", "deploy", "scripts"].some((d) => inside(p, `${ctx.app}/${d}`)) || p === `${ctx.app}/package.json`;
}

const unitFile = (ctx) => `${ctx.home}/.config/systemd/user/${ctx.unit}`;
// Files of the system that say what the server is. No secret is in them.
const SYSTEM_FACTS = new Set(["/etc/os-release", "/proc/meminfo", "/proc/cpuinfo", "/proc/version", "/proc/loadavg", "/proc/uptime", "/etc/hostname"]);

function readVerdict(p, ctx) {
  if (secretPath(p, ctx)) return deny(NEVER_SECRET);
  if (inside(p, ctx.base) || p === unitFile(ctx) || SYSTEM_FACTS.has(p)) return allow("It reads the state of the console or of the server.");
  return ask("This file is not in the console's own folder.");
}

function writeVerdict(p, ctx) {
  if (secretPath(p, ctx)) return deny(inside(p, ctx.dataDir) ? NEVER_DONE : NEVER_SECRET);
  if (protectedPath(p, ctx)) return deny(NEVER_DONE);
  if (inside(p, ctx.base) || p === unitFile(ctx)) return ask("It changes a file in the console's own folder. Read the change first.");
  return ask("This file is not in the console's own folder.");
}

/** What a repair may remove with no question: the build, the installed parts, the installer's own temp files and log. */
function buildOutput(p, ctx) {
  return [".next", ".next-build", ".next-prev", ".next-failed", "node_modules"].some((d) => inside(p, `${ctx.app}/${d}`))
    || inside(p, `${ctx.base}/.tmp`) || p === `${ctx.base}/install.log` || p === `${ctx.base}/failed-step.log`;
}

// --------------------------------------------------------------------- shell

// One shape of the allow list: the words of the command, each one a text or a test.
const NUM = /^\d{1,6}$/;
const WORD = /^[A-Za-z0-9_.@:+=,/-]+$/;

/** Every word of `words` (after the first `from`) passes `ok`. */
const rest = (words, from, ok) => words.slice(from).every(ok);

/** The command is ONE plain command: no chain, no pipe, no redirect, no expansion, no quote. */
const PLAIN = /^[A-Za-z0-9_.@:+=,/ -]+$/;

function pathWords(words, from, ctx) {
  return words.slice(from).filter((w) => !w.startsWith("-") && !NUM.test(w)).map((w) => absPath(w, ctx));
}

/** The shapes that run with no question. `words` is a plain command, split at spaces. */
function allowedShape(words, ctx) {
  const [cmd, a, b] = words;
  const cwd = ctx.cwd ?? ctx.base;
  const own = (u) => u === ctx.unit || u === ctx.unit.replace(/\.service$/, "") || u.startsWith(ctx.cronPrefix);

  // A check or a step of the console, again. Never `pair`: the code is for the person.
  if (cmd === ctx.cli || ctx.cliNames.includes(cmd)) {
    const sub = words.slice(1).join(" ");
    // `port <n>` is the one change of the settings: another port, when a program took the old one.
    return /^(doctor( --details)?|setup --auto( --brief)?( --port \d{4,5})?|port \d{4,5}|access|names|status|restart( console)?)$/.test(sub);
  }
  if (cmd === "systemctl" && a === "--user") {
    const flags = (w, i, all) => /^(--no-pager|--no-legend|--all|--quiet|--full|-l|-n|-p|--property=[A-Za-z,]+)$/.test(w) || NUM.test(w) || (all[i - 1] === "-p" && /^[A-Za-z,]+$/.test(w));
    if (["status", "is-active", "is-enabled", "is-failed", "cat", "show"].includes(b)) return rest(words, 3, (w, i, all) => flags(w, i, all) || own(w));
    if (["is-system-running", "daemon-reload", "list-units", "list-unit-files", "list-timers"].includes(b)) return rest(words, 3, flags);
    // The console's own service, and no other one.
    if (["restart", "start", "try-restart", "reset-failed"].includes(b)) return words.length >= 4 && rest(words, 3, own);
    return false;
  }
  if (cmd === "journalctl") {
    const u = words.indexOf("-u");
    // The log of the console's own service, and of no other one.
    return a === "--user" && u > 0 && words.lastIndexOf("-u") === u && own(words[u + 1] ?? "") && !words.includes("-f") && !words.includes("--follow")
      && rest(words, 2, (w, i, all) => w === "-u" || all[i - 1] === "-u" || w === "--no-pager" || w === "-n" || w === "-e" || w === "-b" || NUM.test(w) || /^--(lines|since|until)=[\w :.-]+$/.test(w));
  }
  if (cmd === "loginctl") return a === "show-user" && b === ctx.user && rest(words, 3, (w) => /^--property=[A-Za-z,]+$/.test(w));

  // The state of the server: versions, memory, disk, ports.
  const one = words.length === 1, two = words.length === 2;
  if (["nproc", "uptime", "whoami", "id", "date", "hostname", "pwd", "arch"].includes(cmd)) return one;
  if (cmd === "uname") return one || (two && /^-[amrsnv]+$/.test(a));
  if (cmd === "free") return one || (two && /^-[mhg]$/.test(a));
  if (cmd === "df") return rest(words, 1, (w) => /^-[hPkT]+$/.test(w) || w === "/" || inside(absPath(w, ctx), ctx.base) || w === ctx.home);
  if (cmd === "ss") return two && /^-[ltnpH]+$/.test(a);
  if (["node", "pnpm", "git", "npm", "dtach", "gh", "claude", "tailscale", "ldd"].includes(cmd) && two && (a === "--version" || a === "-v" || a === "version")) return true;
  if (cmd === "getconf") return two && a === "GNU_LIBC_VERSION";
  if (cmd === "command" || cmd === "which" || cmd === "type") return (cmd === "command" ? a === "-v" && words.length === 3 : two) && WORD.test(words[words.length - 1]);
  if (cmd === "cat" && two && SYSTEM_FACTS.has(a)) return true;

  // Files, in the console's own folder only.
  const paths = pathWords(words, 1, ctx);
  const allInside = paths.every((p) => inside(p, ctx.base) && !secretPath(p, ctx));
  if (["ls", "cat", "head", "tail", "wc", "stat", "du", "file", "sha256sum"].includes(cmd)) {
    return allInside && (paths.length > 0 ? true : inside(cwd, ctx.base) && ["ls", "du"].includes(cmd));
  }
  // A new folder. And the removal of what a new build makes again.
  if (cmd === "mkdir") return paths.length > 0 && allInside && paths.every((p) => !protectedPath(p, ctx));
  if (cmd === "rm" || cmd === "rmdir") return paths.length > 0 && paths.every((p) => buildOutput(p, ctx));
  // The parts and the build of the console, in its code folder.
  if (cmd === "pnpm" && cwd === ctx.app) return /^(install( --frozen-lockfile)?|build)$/.test(words.slice(1).join(" "));
  return false;
}

// A command that opens the server to the internet, in any place of the text.
const PUBLIC_DOOR = [
  /\btailscale\s+funnel\b/i, /\b(ngrok|cloudflared|localtunnel|bore|frpc|serveo|pagekite)\b/i,
  /\bssh\b[^|;&]*\s-[A-Za-z]*R\b/, /\bufw\b[^|;&]*\b(allow|disable|reset)\b/i,
  /\b(iptables|ip6tables)\b[^|;&]*(-j\s*ACCEPT|-F\b|--flush|-P\s+\w+\s+ACCEPT)/i, /\bnft\b[^|;&]*\b(accept|flush)\b/i,
  /\bfirewall-cmd\b[^|;&]*--(add-(port|service|rich-rule)|zone=public|panic-off)/i,
  /\b0\.0\.0\.0\b/, /\[?::\]?:\d+/, /\bHOST=(?!127\.0\.0\.1\b|localhost\b)/, /--(host|bind|address)[= ](?!127\.0\.0\.1\b|localhost\b)\S/i,
  /\bsocat\b[^|;&]*LISTEN/i, /\b(nc|ncat|netcat)\b[^|;&]*\s-[A-Za-z]*l/i,
];

// A command that removes or empties files.
const DELETES = new Set(["rm", "rmdir", "unlink", "shred", "truncate", "wipe", "srm"]);

/** The parts of a command line between `;`, `&&`, `||`, `|`, `&` and new lines. */
const segments = (command) => command.split(/\|\||&&|[;|&\n]/).map((s) => s.trim()).filter(Boolean);

/** The words of one part, with `sudo`, `env X=…`, `nohup` and the like taken off the front. */
function bareWords(segment) {
  let words = segment.split(/\s+/).filter(Boolean);
  for (;;) {
    const [w] = words;
    if (w === "sudo" || w === "doas") { words = words.slice(1); while (words[0]?.startsWith("-")) words = words.slice(words[0] === "-u" || words[0] === "-g" ? 2 : 1); continue; }
    if (["nohup", "exec", "command", "time", "nice", "setsid", "xargs", "env", "then", "do", "else", "{", "("].includes(w) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w ?? "")) { words = words.slice(1); continue; }
    return words;
  }
}

/** @param {string} command @param {Ctx} ctx @returns {Verdict} */
export function bashVerdict(command, ctx) {
  const text = command.trim();
  if (!text) return ask("An empty command.");

  if (PUBLIC_DOOR.some((re) => re.test(text))) return deny(NEVER_PUBLIC);
  if (SECRET_WORD.test(text) || text.includes(ctx.dataDir)) return deny(text.includes(ctx.dataDir) ? NEVER_DONE : NEVER_SECRET);
  // The environment of a shell can hold a token.
  if (segments(text).some((s) => /^(sudo\s+)?(printenv|env|set|export -p|declare( -[A-Za-z]+)?)(\s+-\S+)*$/.test(s))) return deny(NEVER_SECRET);

  for (const seg of segments(text)) {
    const words = bareWords(seg);
    const [cmd] = words;
    if (!cmd) continue;
    // A delete inside another command (`sh -c "rm …"`, `bash -lc`, a script on one line): its
    // target cannot be read here.
    if (!DELETES.has(cmd) && words.slice(1).some((w) => DELETES.has(w.replace(/^["'`(]+/, "")))) return deny(NEVER_DELETE);
    // The code of the first device is for the person, and a paired device is a step that is done.
    const names = ctx.cliNames.join("|");
    if ((cmd === ctx.cli || new RegExp(`(^|/)(${names})$`).test(cmd) || new RegExp(`\\bbin/(${names})\\.ts\\b`).test(seg))
      && /\b(pair|brain|queue|agents|leads|remind|cron)\b/.test(seg)) return deny(NEVER_DONE);
    const deletes = DELETES.has(cmd) || (cmd === "find" && /\s-(delete|exec|execdir|ok)\b/.test(seg)) || (cmd === "dd" && /\bof=/.test(seg))
      || (cmd === "git" && /\b(clean|reset\s+--hard|checkout\s+--\s)\b/.test(seg));
    if (deletes) {
      // Each path must be a plain word that resolves into the console's own folder.
      const args = words.slice(1).filter((w) => !w.startsWith("-") && !/^(if|of)=/.test(w));
      // git with -C works in another folder than the one of the call: its target is not known.
      const targets = cmd === "dd" ? words.filter((w) => w.startsWith("of=")).map((w) => w.slice(3)) : cmd === "find" ? args.slice(0, 1)
        : cmd === "git" ? (words.includes("-C") ? [] : [ctx.cwd ?? ctx.base]) : args;
      // A path with no `/` at its start is only sure when the command is alone on its line
      // (a `cd` before it would change what it means).
      const alone = segments(text).length === 1;
      const safe = targets.length > 0 && targets.every((t) => WORD.test(t) && (alone || isAbsolute(t)) && inside(absPath(t, ctx), ctx.base) && absPath(t, ctx) !== ctx.base);
      if (!safe) return deny(NEVER_DELETE);
    }
  }

  if (PLAIN.test(text) && allowedShape(text.split(/ +/), ctx)) return allow("A read of the state, a check, or a repair step of the console's own folder.");
  return ask(/\bsudo\b/.test(text) ? "This command needs root." : "This command is not on the list of the install agent.");
}

// ---------------------------------------------------------------------- tools

const str = (v) => (typeof v === "string" ? v : "");

/**
 * The verdict for one tool call. null: a tool with no effect on the server (a to-do list, a
 * question to the person); the normal flow of Claude Code decides.
 * @param {string} tool @param {Record<string, unknown>} input @param {Ctx} ctx @returns {Verdict | null}
 */
export function decide(tool, input, ctx) {
  const at = { ...ctx, cwd: ctx.cwd ?? ctx.base };
  switch (tool) {
    case "Bash": return bashVerdict(str(input?.command), at);
    case "Read": return readVerdict(absPath(str(input?.file_path), at), at);
    case "Grep":
    case "Glob": {
      const p = absPath(str(input?.path) || at.cwd, at);
      // A pattern can climb out of the folder (`../**`) or name a secret file.
      const pattern = `${str(input?.pattern)} ${str(input?.glob)}`;
      if (SECRET_WORD.test(pattern)) return deny(NEVER_SECRET);
      if (tool === "Glob" && (pattern.includes("..") || pattern.trim().startsWith("/") || pattern.trim().startsWith("~"))) return ask("This search leaves the console's own folder.");
      return readVerdict(p, at);
    }
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit": return writeVerdict(absPath(str(input?.file_path) || str(input?.notebook_path), at), at);
    case "TodoWrite":
    case "AskUserQuestion":
    case "ExitPlanMode":
    case "BashOutput":
    case "KillShell":
    case "KillBash": return null;
    default: return deny(NEVER_NET);
  }
}
