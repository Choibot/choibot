// server/files/wide.ts — what the file browser of the Server page never serves (./browse.ts).
// The browser can go to "/", so its refusal list is wider than the one of the code explorer:
//   1. every place and name of ./refused.ts (the console's own .env, data dirs, the login and
//      key stores of the console's user, Git internals),
//   2. every path of the install agent's SECRET_PATH (bin/install-agent/policy.mjs),
//   3. more stores of keys and logins, the live system (/proc, /sys, /dev, /run), the homes of
//      other users, and the places the owner of the server adds (FILES_REFUSED_EXTRA).
// CLASSES is the whole list, one entry per class: the tests and the table in the pull request
// read it. A rule is checked on a REAL path and on each folder above it, so a link to a secret
// and a file inside a secret folder are refused too.
//
// A refused entry is shown in a folder list as a locked row with the reason (WHY). Its content,
// its size, its date and its children are never served.
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { SECRET_PATH } from "../../bin/install-agent/policy.mjs";
import { DISPLAY_NAME } from "../brand.js";
import { resolveAppDataDir } from "../defaults.js";
import { resolveWidgetsDataDir } from "../widgets/paths.js";
import { isRefused, refusalFor, type Refusal } from "./refused.js";

type Env = Record<string, string | undefined>;

// "content": not from a path. The content route gives it for a file whose bytes look like a key (./keylike.ts).
export type WhyId = "key" | "console" | "system" | "other-user" | "private" | "content";
// The line of a locked row.
export const WHY: Record<WhyId, string> = {
  key: "Not shown: it holds a key or a login",
  console: `Not shown: ${DISPLAY_NAME}'s own records and settings`,
  system: "Not shown: a part of the running system, not a file on your disk",
  "other-user": "Not shown: the home folder of another user",
  private: "Not shown: this place is private on this server",
  content: "Not shown: this file looks like it holds a key",
};

export type Wide = {
  base: Refusal;
  home: string;
  // The console's own data that ./refused.ts does not name (the widgets' data, the sessions'
  // sockets and terminal histories, the root of the data dirs).
  consoleDirs: string[];
  // The home folders of the other users of the server (/etc/passwd), and /root.
  otherHomes: string[];
  // FILES_REFUSED_EXTRA: places the owner of the server keeps private. The Files tab changes
  // this list while the server runs (./browse.ts).
  extraDirs: string[];
  // The same places as they were given (a link is not followed): what the user reads.
  extraGiven: string[];
  // The folder name of the agents' copies in a repo, and the one folder of all copies when it
  // is set as an absolute path.
  worktreeName: string;
  worktreeRoot: string | null;
};

const real = (p: string): string => {
  try { return realpathSync(p); } catch { return resolve(p); }
};
const readPasswd = (): string => {
  try { return readFileSync("/etc/passwd", "utf8"); } catch { return ""; }
};
const within = (p: string, dir: string): boolean => p === dir || p.startsWith(dir === sep ? sep : dir + sep);

// Under HOME, more than ./refused.ts HOME_STORES and SECRET_PATH: wallets and keypairs of chain
// tools, password stores, the logins of browsers and of cloud and deploy tools.
const MORE_HOME_STORES = [
  ".config/solana", ".config/op", ".config/gcloud", ".config/rclone", ".config/doctl", ".config/hcloud", ".config/configstore",
  ".config/google-chrome", ".config/chromium", ".config/BraveSoftware", ".mozilla",
  ".password-store", ".local/share/keyrings", ".local/share/com.vercel.cli", ".terraform.d", ".fly", ".wrangler",
  ".electrum", ".bitcoin", ".ethereum", ".cargo/credentials", ".cargo/credentials.toml", ".pypirc", ".gem", ".vault-token",
  ".azure", ".kube", ".my.cnf", ".s3cfg", ".boto",
];
// A file or folder of one of these names, anywhere. Each name is a known store of a key, a
// login or typed secrets (a shell history holds pasted tokens).
const MORE_NAMES = new Set([
  "credentials", "credentials.json", "credentials.toml", "credentials.yaml", "credentials.yml", "credentials.db",
  "secrets.json", "secrets.yaml", "secrets.yml", "secrets.toml", "secrets.env", "secret.json", "secret.key",
  "token.json", "auth.json", ".htpasswd", "id.json", "kubeconfig", "terraform.tfstate", "terraform.tfstate.backup",
  ".bash_history", ".zsh_history", ".python_history", ".psql_history", ".mysql_history", ".node_repl_history", ".lesshst", ".viminfo",
  // Start files of a shell (an exported token is often in one), and the settings of direnv and Git.
  ".bashrc", ".bash_profile", ".bash_login", ".profile", ".zshrc", ".zshenv", ".zprofile", ".zlogin", ".envrc", ".gitconfig",
]);
// A file whose name ends so, anywhere.
// (prod.env, passwords.txt, a copy of .git-credentials or .gitconfig under another name.)
const MORE_ENDS = /\.(kdbx?|ovpn|tfvars|keytab)$|.\.env$|^mnemonic|^seed(-?phrase)?\.(txt|json)$|^service[-_]?account.*\.json$|^passwords?\.|^\.?git-credentials|^\.gitconfig\./i;
// The unit files of the user's service manager: an Environment= line can hold a token. The
// folder and its drop-in folders are listed; each file in them is a locked row.
const USER_UNITS = ".config/systemd/user";
const UNIT_FOLDER = /\.(d|wants|requires)$/;
// Stores of the system (a key of the server, a network password, the data of a database).
const SYSTEM_STORES = [
  "/etc/ssh", "/etc/wireguard", "/etc/NetworkManager/system-connections", "/etc/letsencrypt", "/etc/security/opasswd", "/etc/krb5.keytab",
  "/var/lib/docker", "/var/lib/tailscale", "/var/lib/postgresql", "/var/lib/mysql",
];
// Not files on a disk: the processes and the devices of the running system. /proc/<pid>/environ
// and the like are in here.
const LIVE_SYSTEM = ["/proc", "/sys", "/dev", "/run"];
// An .env file of these names holds no secret by its purpose.
const ENV_SAMPLES = new Set([".env.example"]);

// One class of refused paths. `test` gets one real path (the entry or a folder above it).
export type RefusedClass = { id: string; why: WhyId; what: string; test: (p: string, w: Wide) => boolean };

// An .env file in an agent's own copy of a repo: readable, as in the code explorer today.
function inAgentCopy(p: string, w: Wide): boolean {
  return p.split(sep).includes(w.worktreeName) || (w.worktreeRoot !== null && within(p, w.worktreeRoot) && p !== w.worktreeRoot);
}

// SECRET_PATH, less its `.env` clause for a sample file and for an agent's own copy.
function secretPath(p: string, w: Wide): boolean {
  const name = basename(p);
  if (/^\.env($|\.)/.test(name) && (ENV_SAMPLES.has(name) || inAgentCopy(p, w))) {
    return SECRET_PATH.test(join(dirname(p), name.slice(1))); // every other clause still counts
  }
  return SECRET_PATH.test(p);
}

export const CLASSES: RefusedClass[] = [
  {
    id: "console-data", why: "console", what: `${DISPLAY_NAME}'s own data: its records, queue, devices, agent records, widgets' data, session sockets and terminal histories`,
    test: (p, w) => w.consoleDirs.some((d) => within(p, d)),
  },
  {
    id: "code-explorer-list", why: "key", what: `Everything the code explorer refuses today: ${DISPLAY_NAME}'s own .env files, the login and key stores of your server's user (.ssh, .gnupg, .aws, .docker, .netrc, .git-credentials, .npmrc, .pgpass, .claude, .claude.json, .claude-accounts, .codex, .config/gh), Git internals (.git)`,
    test: (p, w) => isRefused(p, w.base),
  },
  { id: "other-user", why: "other-user", what: "The home folder of another user: /root, each home of /etc/passwd and each folder of /home that is not your user's", test: otherUser },
  {
    id: "install-agent-list", why: "key", what: "Every path the install agent may not read: .env files (not in an agent's own copy of a repo, not .env.example), *.pem *.key *.p12 *.pfx *.keystore *.jks, id_rsa and the like, a path with \"keypair\" or \"wallet\" in it, user-token, .azure, .kube, .config/gcloud|op|rclone, /etc/shadow, /etc/gshadow, /etc/sudoers, /etc/ssh/*, /etc/ssl/private",
    test: secretPath,
  },
  {
    id: "more-home-stores", why: "key", what: "More stores under the home folder: Solana keypairs (.config/solana), password stores, the logins of browsers, of cloud tools and of deploy tools, chain wallets",
    test: (p, w) => MORE_HOME_STORES.some((s) => within(p, join(w.home, s))),
  },
  {
    id: "more-names", why: "key", what: "Known names of key and login files anywhere: credentials*, secrets.*, passwords.*, token.json, auth.json, id.json, kubeconfig, .htpasswd, Terraform state and *.tfvars, *.kdbx, *.kdb, *.ovpn, *.keytab, *.env (prod.env), .envrc, mnemonic*, seed.txt, service-account*.json, shell and database histories, the start files of a shell (.bashrc, .profile, .zshrc and the like), .gitconfig, a copy of .git-credentials",
    test: (p) => MORE_NAMES.has(basename(p).toLowerCase()) || MORE_ENDS.test(basename(p)),
  },
  {
    id: "user-units", why: "key", what: "The unit files of your user's service manager and their drop-ins (~/.config/systemd/user): the folders are listed, each file is locked",
    test: (p, w) => { const dir = join(w.home, USER_UNITS); return within(p, dir) && p !== dir && !UNIT_FOLDER.test(basename(p)); },
  },
  {
    id: "system-stores", why: "key", what: "Stores of the system: /etc/ssh, /etc/wireguard, saved network passwords, /etc/letsencrypt, the data of Docker, Tailscale, PostgreSQL and MySQL",
    test: (p) => SYSTEM_STORES.some((d) => within(p, d)),
  },
  {
    id: "live-system", why: "system", what: "The running system: /proc (with /proc/<pid>/environ), /sys, /dev, /run",
    test: (p) => LIVE_SYSTEM.some((d) => within(p, d)),
  },
  { id: "owner-extra", why: "private", what: "The private places that the user adds in the Files tab (kept as FILES_REFUSED_EXTRA in the console's .env)", test: (p, w) => w.extraDirs.some((d) => within(p, d)) },
];

// Another user's home: one of /etc/passwd, or a folder of /home that is not the console user's.
function otherUser(p: string, w: Wide): boolean {
  if (within(p, w.home)) return false;
  if (w.otherHomes.some((h) => within(p, h))) return true;
  return within(p, "/home") && p !== "/home" && !within(w.home, join("/home", p.split(sep)[2]));
}

// The home folders of the people of the server from /etc/passwd (a user id from 1000; not the
// "nobody" user), and /root. A service user's home (/var/lib/…, /bin) is no person's home.
export function passwdHomes(passwd: string): string[] {
  const out = new Set<string>(["/root"]);
  for (const line of passwd.split("\n")) {
    const f = line.split(":");
    const uid = Number(f[2]);
    if (f.length >= 6 && uid >= 1000 && uid < 65534 && isAbsolute(f[5]) && f[5] !== sep) out.add(resolve(f[5]));
  }
  return [...out];
}

export function wideFor(o: { env?: Env; checkout?: string; home?: string; dtachDir?: string; passwd?: string } = {}): Wide {
  const env = o.env ?? process.env;
  const home = real(o.home ?? (env.HOME || homedir()));
  const wt = env.AGENT_WORKTREE_ROOT?.trim() || ".agent-worktrees";
  const extra = (env.FILES_REFUSED_EXTRA ?? "").split(/[:\n]/).map((s) => s.trim()).filter((s) => isAbsolute(s));
  return {
    base: refusalFor({ env, checkout: o.checkout }),
    home,
    consoleDirs: [resolveAppDataDir(env), resolveWidgetsDataDir(env), ...(o.dtachDir ? [o.dtachDir] : [])].map(real),
    otherHomes: passwdHomes(o.passwd ?? readPasswd()).map(real).filter((h) => !within(home, h)),
    extraDirs: [...new Set([...extra.map((p) => resolve(p)), ...extra.map(real)])],
    extraGiven: extra.map((p) => resolve(p)),
    worktreeName: isAbsolute(wt) ? ".agent-worktrees" : basename(wt),
    worktreeRoot: isAbsolute(wt) ? real(wt) : null,
  };
}

/** Why a real absolute path is refused (the entry itself or a folder above it), else null. */
export function whyRefused(p: string, w: Wide): WhyId | null {
  // Each folder above the entry, then the entry: "/a", "/a/b", "/a/b/c".
  const parts = p.split(sep).filter(Boolean);
  let at = "";
  for (const part of parts) {
    at += sep + part;
    for (const c of CLASSES) if (c.test(at, w)) return c.why;
  }
  return null;
}
