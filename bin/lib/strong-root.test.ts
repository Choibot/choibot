// bin/lib/strong-root.test.ts — root's part of strong-setup as ONE file with Node's own modules
// only (bin/lib/strong-root.ts), and its run from a root copy of a release (H4): what it loads, the
// process and the copy it refuses, the facts it refuses and how it reads them, and the plan of a
// root copy (the console stopped; no package, account or group changes; the agents that run stay).
import { spawnSync } from "node:child_process";
import { chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DISPLAY_NAME } from "../../server/brand.js";
import { SUDO_ENV_KEEP } from "../../server/agents/terminal.js";
import { isChiefId } from "../../server/chief/chiefids.js";
import { NEW_NAMES } from "../../server/names.mjs";
import { parseEnv, serializeEnv } from "./env.js";
import { patchEnvText } from "../../server/settings/envfile.js";
import {
  CONSOLE_GROUP_CHECK, CONSOLE_STOPPED_CHECK, COPY_DIRS, COPY_FILES, FIXED_PATH, NAMES, NODE_FROM_COPY, PRODUCT, RESTART_STEP, SUDO_KEEP,
  STDERR_MAX, STRONG_DEFAULTS, applyPlan, checkFacts, chiefId, copyRefusal, ensureSharedDir, helperConfText, sudoersText, factRefusal, factsArgv, pipeRun, planText,
  CGROUP_NAMES_MAX, COPY_ENTRIES_MAX, printable, procOf, processRefusal, readFacts, readSystemdEnv, realExec, runRootCopy, settingsRefusal, settingsText, strongPlan, systemdValues,
  type Action, type CopyFs, type DirFs, type Exec, type Pipe, type Proc, type StrongFacts,
} from "./strong-root.js";

const FILE = fileURLToPath(new URL("./strong-root.ts", import.meta.url));
const COPY = "/var/lib/choibot-update/root-copy/857";
// A hosted server in the release layout (H2): settings and data outside the code folder.
const FACTS: StrongFacts = {
  user: "choibot", uid: 1000, home: "/home/choibot", legacy: false,
  app: "/opt/choibot/app", envFile: "/opt/choibot/console.env",
  privateDirs: ["/home/choibot/.local/share/choibot", "/home/choibot/.local/share/choibot/agents", "/home/choibot/.local/share/choibot/services"],
  privateFiles: ["/opt/choibot/install.log"],
  widgetsDir: "/opt/choibot/widgets", workspace: "/srv/choibot/workspace", worktreeRoot: null,
  agentDataDir: "/home/choibot/.local/share/choibot/agents", claudeDir: "/home/choibot/.claude",
  // The tools of the facts: not used from a root copy (dtach is the system's, in /usr).
  nodeDir: "/opt/choibot/node", claude: "/home/choibot/.local/share/claude/versions/2.1.400", gh: "/opt/choibot/gh/bin/gh", dtach: "/usr/bin/dtach",
  unit: "choibot.service", persistent: [{ id: "lead-console", cwd: "/srv/choibot/agent-homes/chief/leads/console/agent" }],
};
const fromCopy = (f: StrongFacts = FACTS) => strongPlan(f, undefined, undefined, { copy: COPY });
type Run = Extract<Action, { run: string[] }>;
const runs = (steps: ReturnType<typeof strongPlan>): Run[] => steps.flatMap((s) => s.actions).filter((a): a is Run => "run" in a);

describe("ONE file with Node's own modules only", () => {
  it("its imports are node: modules, static; no require, no dynamic import", () => {
    const src = readFileSync(FILE, "utf8");
    const from = [...src.matchAll(/^import [^;]*? from "([^"]+)";$/gms)].map((m) => m[1]);
    expect(from).toEqual(["node:child_process", "node:fs", "node:path", "node:url"]);
    expect(src).not.toMatch(/\brequire\(|\bimport\(|createRequire|process\.binding|node:(net|http|https|dns|tls|dgram|http2|worker_threads|vm)\b/);
  });

  it("plain Node runs it (no tsx, no loader), and it loads exactly these modules: the list fails the test when it grows", () => {
    const t = mkdtempSync(join(tmpdir(), "strong-root-mods-"));
    try {
      // A resolve hook that writes each module that the run loads.
      writeFileSync(join(t, "hook.mjs"), [
        'import { registerHooks } from "node:module";',
        'import { appendFileSync } from "node:fs";',
        'registerHooks({ resolve(s, c, next) { const r = next(s, c); appendFileSync(process.env.MODS, r.url + "\\n"); return r; } });',
      ].join("\n"));
      const mods = join(t, "mods.txt");
      const r = spawnSync(process.execPath, ["--import", pathToFileURL(join(t, "hook.mjs")).href, FILE, "--help"], {
        encoding: "utf8", env: { PATH: FIXED_PATH, MODS: mods } as unknown as NodeJS.ProcessEnv,
      });
      expect([r.status, r.stdout]).toEqual([0, expect.stringContaining("--user <console user> --app")]);
      const loaded = [...new Set(readFileSync(mods, "utf8").trim().split("\n"))].sort();
      expect(loaded).toEqual([pathToFileURL(FILE).href, "node:child_process", "node:fs", "node:path", "node:url"].sort());
      // With no option at all: its own run, which refuses a process that is not root's.
      const plain = spawnSync(process.execPath, [FILE, "--user", "choibot", "--app", "/opt/choibot/app"], { encoding: "utf8", env: { PATH: FIXED_PATH } as unknown as NodeJS.ProcessEnv });
      if (process.getuid?.() !== 0) expect([plain.status, plain.stderr.trim().split("\n").at(-1)]).toEqual([1, "✖ The set-up from a root copy changes root's files: run it as root."]);
    } finally {
      rmSync(t, { recursive: true, force: true });
    }
  });

  it("its names are the product's (a new install)", () => {
    expect(PRODUCT).toBe(DISPLAY_NAME);
    expect(NAMES).toEqual({ dataDir: NEW_NAMES.dataDir, dtachDir: NEW_NAMES.dtachDir, cliEntry: NEW_NAMES.cliEntry, unit: NEW_NAMES.unit });
    // SUDO_ENV_KEEP of a new install (the tests run as an old one: its keys are spelled CHOIBOT_*), then the old spelling.
    const base = SUDO_ENV_KEEP.map((k) => k.replace(/^CHOIBOT_/, "CHOIBOT_"));
    expect(SUDO_KEEP).toEqual([...new Set([...base, ...base.map((k) => k.replace(/^CHOIBOT_/, "CHOIBOT_"))])]);
    for (const id of ["fleet-master", "coordinator", "lead-console", "lead-a", `lead-${"a".repeat(32)}`, `lead-${"a".repeat(33)}`, "lead-", "lead--x", "lead-A", "worker", "b7c1e0f2-1111-4222-8333-944455556666", "coordinator2", ""]) {
      expect([id, chiefId(id)]).toEqual([id, isChiefId(id)]);
    }
  });
});

describe("the process of a root copy run", () => {
  it("procOf: root's umask is fixed (022), and the paths of Node and of this file are real paths", () => {
    const t = mkdtempSync(join(tmpdir(), "strong-root-proc-"));
    try {
      symlinkSync(process.execPath, join(t, "node"));
      symlinkSync(FILE, join(t, "self.ts"));
      const masks: number[] = [];
      const p = procOf({ env: { PATH: FIXED_PATH } as unknown as NodeJS.ProcessEnv, execArgv: [], execPath: join(t, "node"), cwd: () => "/x", getuid: () => 0, umask: ((m: number) => { masks.push(m); return 0o077; }) as NodeJS.Process["umask"] }, join(t, "self.ts"));
      expect(masks).toEqual([0o022]);
      expect(p).toEqual({ env: { PATH: FIXED_PATH }, execArgv: [], execPath: realpathSync(process.execPath), cwd: "/x", uid: 0, self: realpathSync(FILE) });
    } finally {
      rmSync(t, { recursive: true, force: true });
    }
  });

  const ok: Proc = { env: { PATH: FIXED_PATH }, execArgv: [], execPath: `${COPY}/node/bin/node`, cwd: COPY, uid: 0, self: `${COPY}/app/bin/lib/strong-root.ts` };
  it("is root, with exactly PATH in its env, Node with no option, the copy's Node, this file of the copy, a working folder in the copy", () => {
    expect(processRefusal(ok, COPY)).toBeNull();
    expect(processRefusal({ ...ok, cwd: `${COPY}/app` }, COPY)).toBeNull();
    expect(processRefusal({ ...ok, uid: 1000 }, COPY)).toMatch(/run it as root/);
    expect(processRefusal({ ...ok, env: { PATH: FIXED_PATH, NODE_OPTIONS: "--require /tmp/x.js" } }, COPY)).toMatch(/no NODE_OPTIONS/);
    expect(processRefusal({ ...ok, env: { PATH: FIXED_PATH, HOME: "/root" } }, COPY)).toMatch(/nothing else/);
    expect(processRefusal({ ...ok, env: { PATH: `/home/choibot/bin:${FIXED_PATH}` } }, COPY)).toMatch(/nothing else/);
    expect(processRefusal({ ...ok, execArgv: ["--import", "x"] }, COPY)).toMatch(/with options/);
    expect(processRefusal({ ...ok, execPath: "/opt/choibot/node/bin/node" }, COPY)).toMatch(/the copy's own/);
    expect(processRefusal({ ...ok, self: "/opt/choibot/app/bin/lib/strong-root.ts" }, COPY)).toMatch(/not in the app folder of a copy/);
    expect(processRefusal({ ...ok, cwd: "/opt/choibot" }, COPY)).toMatch(/working folder/);
    expect(processRefusal({ ...ok, cwd: `${COPY}-x` }, COPY)).toMatch(/working folder/);
  });
});

// An in-memory copy for copyRefusal: each path, its kind, owner and mode; a folder lists its entries.
type Entry = { kind: "dir" | "file" | "link" | "fifo"; uid?: number; mode?: number };
function copyTree(more: Record<string, Entry> = {}, drop: string[] = []): CopyFs & { seen: string[] } {
  const all: Record<string, Entry> = {};
  for (let d = COPY; ; d = dirname(d)) { all[d] = { kind: "dir" }; if (d === "/") break; }
  for (const x of COPY_DIRS) all[`${COPY}/${x}`] = { kind: "dir" };
  for (const x of COPY_FILES) all[`${COPY}/${x}`] = { kind: "file", mode: 0o755 };
  Object.assign(all, {
    [`${COPY}/node/lib`]: { kind: "dir" }, [`${COPY}/node/lib/npm.js`]: { kind: "file" },
    [`${COPY}/node/bin/npm`]: { kind: "link", mode: 0o777 }, [`${COPY}/app/package.json`]: { kind: "file" },
  }, more);
  for (const k of drop) delete all[k];
  const type = { dir: 0o040000, file: 0o100000, link: 0o120000, fifo: 0o010000 };
  const seen: string[] = [];
  return {
    seen,
    lstat: (p) => {
      seen.push(p);
      const e = all[p];
      if (!e) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { isSymbolicLink: () => e.kind === "link", isDirectory: () => e.kind === "dir", isFile: () => e.kind === "file", uid: e.uid ?? 0, mode: type[e.kind] | (e.mode ?? (e.kind === "dir" ? 0o755 : 0o644)) } as unknown as Stats;
    },
    readdir: (p) => Object.keys(all).filter((k) => k.startsWith(`${COPY}/`) && dirname(k) === p).map((k) => k.slice(p.length + 1)),
  };
}

describe("the copy", () => {
  it("every folder up to /, and every entry of the copy (links not followed): root's, and only root can write it", () => {
    const t = copyTree();
    expect(copyRefusal(COPY, t)).toBeNull();
    expect(t.seen.slice(0, 6)).toEqual([COPY, "/var/lib/choibot-update/root-copy", "/var/lib/choibot-update", "/var/lib", "/var", "/"]);
    // The whole tree, not only what root runs: a file deep in Node's folder is looked at.
    expect(t.seen).toEqual(expect.arrayContaining([`${COPY}/node/lib/npm.js`, `${COPY}/app/package.json`, ...COPY_FILES.map((x) => `${COPY}/${x}`)]));
  });
  it("refuses: another owner up the way; group write; other write; a link; setuid; setgid; a missing file; a path that is not plain", () => {
    const no = (more: Record<string, Entry>, drop: string[] = []) => copyRefusal(COPY, copyTree(more, drop));
    expect(no({ "/var/lib/choibot-update/root-copy": { kind: "dir", uid: 1000 } })).toBe("/var/lib/choibot-update/root-copy is not a folder of root that only root can write");
    expect(no({ "/var": { kind: "dir", mode: 0o775 } })).toBe("/var is not a folder of root that only root can write");
    expect(no({ "/var": { kind: "dir", mode: 0o757 } })).toBe("/var is not a folder of root that only root can write");
    expect(no({ [`${COPY}/app/deploy`]: { kind: "link" } })).toMatch(/app\/deploy is not a folder of root/);
    expect(no({ [`${COPY}/gh/bin/gh`]: { kind: "file", mode: 0o4755 } })).toMatch(/gh\/bin\/gh is not a file of root/);
    expect(no({ [`${COPY}/gh/bin/gh`]: { kind: "file", mode: 0o2755 } })).toMatch(/gh\/bin\/gh is not a file of root/);
    expect(no({ [`${COPY}/app/deploy/choibot-agent-exec`]: { kind: "file", mode: 0o775 } })).toMatch(/choibot-agent-exec is not a file of root/);
    expect(no({ [`${COPY}/app/deploy/choibot-agent-exec`]: { kind: "file", mode: 0o757 } })).toMatch(/choibot-agent-exec is not a file of root/);
    expect(no({ [`${COPY}/app/bin/lib/strong-root.ts`]: { kind: "file", uid: 1000 } })).toMatch(/strong-root\.ts is not a file of root/);
    expect(no({}, [`${COPY}/app/bin/lib/strong-root.ts`])).toBe(`${COPY}/app/bin/lib/strong-root.ts is not there`);
    expect(no({}, [`${COPY}/node/bin/node`])).toBe(`${COPY}/node/bin/node is not there`);
    expect(copyRefusal("/var/lib/choibot-update/../x", copyTree())).toMatch(/not a plain full path/);
  });
  it("a cap on the entries: the release format's number", () => {
    expect(copyRefusal(COPY, copyTree(), 3)).toBe(`${COPY} holds more than 3 entries`);
    expect(COPY_ENTRIES_MAX).toBe(Number(/\[ "\$ENTRIES" -le (\d+) \]/.exec(readFileSync(fileURLToPath(new URL("../../scripts/release/build.sh", import.meta.url)), "utf8"))![1]));
  });
  it("refuses an entry anywhere in the copy: a file others can write, a folder of another owner, a link of another owner, a pipe", () => {
    const no = (more: Record<string, Entry>) => copyRefusal(COPY, copyTree(more));
    expect(no({ [`${COPY}/node/lib/npm.js`]: { kind: "file", mode: 0o666 } })).toBe(`${COPY}/node/lib/npm.js is not a file of root that only root can write`);
    expect(no({ [`${COPY}/node/lib`]: { kind: "dir", uid: 1000 } })).toBe(`${COPY}/node/lib is not a folder of root that only root can write`);
    expect(no({ [`${COPY}/node/bin/npm`]: { kind: "link", uid: 1000 } })).toBe(`${COPY}/node/bin/npm is a link that is not root's`);
    expect(no({ [`${COPY}/app/fifo`]: { kind: "fifo" } })).toBe(`${COPY}/app/fifo is not a file, a folder or a link`);
  });
});

describe("the facts of a root copy run", () => {
  it("a fact that the plan uses may not point into the copy, a folder of the system, /run, /var, the homes of other accounts, or a folder above one", () => {
    const no = (f: Partial<StrongFacts>) => factRefusal({ ...FACTS, ...f }, COPY);
    expect(factRefusal(FACTS, COPY)).toBeNull();
    expect(no({ workspace: "/etc/choibot" })).toBe("workspace: in /etc");
    expect(no({ widgetsDir: "/usr/local/lib/choibot" })).toBe("widgetsDir: in /usr");
    expect(no({ envFile: `${COPY}/console.env` })).toBe("envFile: in the root copy of the release");
    expect(no({ privateDirs: [...FACTS.privateDirs, "/var/lib/choibot-update"] })).toBe("privateDirs: in /var");
    expect(no({ privateFiles: ["/root/.ssh/authorized_keys"] })).toBe("privateFiles: in /root");
    expect(no({ worktreeRoot: "/proc/1" })).toBe("worktreeRoot: in /proc");
    expect(no({ workspace: "/" })).toBe("workspace: the root folder");
    // Each folder of the system, and each used fact.
    for (const d of ["/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/boot", "/dev", "/sys", "/run", "/var"]) expect([d, no({ workspace: `${d}/x` })]).toEqual([d, `workspace: in ${d}`]);
    expect(no({ app: "/bin/app" })).toBe("app: in /bin");
    expect(no({ agentDataDir: "/var/spool/a" })).toBe("agentDataDir: in /var");
    expect(no({ claudeDir: "/home/choibot-agent/.claude" })).toBe("claudeDir: in /home/choibot-agent");
    expect(no({ privateDirs: ["/var/spool/cron"] })).toBe("privateDirs: in /var");
    expect(no({ widgetsDir: "/run/user/1000/w" })).toBe("widgetsDir: in /run");
    // A folder above one of them; the homes of other accounts.
    expect(no({ workspace: "/srv/choibot" })).toBe("workspace: a folder above /srv/choibot/agent-homes");
    expect(no({ workspace: "/srv/choibot/agent-homes/x" })).toBe("workspace: in /srv/choibot/agent-homes");
    expect(no({ worktreeRoot: "/home" })).toBe("worktreeRoot: a folder above /home/choibot-agent");
    expect(no({ worktreeRoot: "/home/someone/wt" })).toBe("worktreeRoot: in /home, outside the home of choibot");
    expect(no({ claudeDir: "/home/choibot-chief/.claude" })).toBe("claudeDir: in /home/choibot-chief");
    // The console user's own home is allowed; a name that only starts like a closed folder is not in it.
    expect(no({ workspace: "/etcetera/w", widgetsDir: "/usr2/w", claudeDir: "/home/choibot/.claude" })).toBeNull();
    // The records of the persistent agents are only compared: in the agents' homes folder they pass; elsewhere the same rules.
    expect(no({ persistent: [{ id: "coordinator", cwd: "/srv/choibot/agent-homes/chief/coordinator/agent" }] })).toBeNull();
    expect(no({ persistent: [{ id: "coordinator", cwd: "/sys/fs" }] })).toBe("persistent: in /sys");
    // The unit: root's fixed name only.
    expect(no({ unit: "nothing.service" })).toBe("unit: not choibot.service");
    // The plan of a root copy is never made from such facts.
    expect(() => fromCopy({ ...FACTS, workspace: "/etc/x" })).toThrow("The facts are refused: workspace: in /etc.");
    expect(() => fromCopy({ ...FACTS, unit: "nothing.service" })).toThrow("The facts are refused: unit: not choibot.service.");
  });

  it("the list cap of the facts: more than 32 folders are refused", () => {
    const who = { user: "choibot", uid: 1000, home: "/home/choibot" };
    expect("refused" in checkFacts({ ...FACTS, privateDirs: Array.from({ length: 32 }, (_, n) => `/d/${n}`) }, who)).toBe(false);
    expect(checkFacts({ ...FACTS, privateDirs: Array.from({ length: 33 }, (_, n) => `/d/${n}`) }, who)).toEqual({ refused: "privateDirs" });
  });

  it("are read as the console user from its running code, with its own time limit, through a pipe with a cap", async () => {
    const argv = factsArgv("/opt/choibot/app", "/home/choibot", "/opt/choibot/node/bin:/usr/bin:/bin");
    expect(argv[2]).toBe('cd "$1" && exec timeout -s KILL 90 env -i HOME="$2" PATH="$3" node_modules/.bin/tsx bin/choibot.ts strong-setup --print-facts');
    expect(argv.slice(4)).toEqual(["/opt/choibot/app", "/home/choibot", "/opt/choibot/node/bin:/usr/bin:/bin"]);
    const seen: { as: string; max: number; ms: number }[] = [];
    const pipe = (r: Awaited<ReturnType<Pipe>>): Pipe => async (_a, o) => { seen.push(o); return r; };
    expect(await readFacts(pipe({ code: 0, out: '{"a":1}' }), "choibot", "/home/choibot", "/opt/choibot/app", "/x")).toEqual({ a: 1 });
    expect(seen[0]).toEqual({ as: "choibot", max: 64 * 1024, ms: 95_000 });
    await expect(readFacts(pipe({ why: "more than 65536 bytes" }), "choibot", "/h", "/a", "/x")).rejects.toThrow("The facts of choibot could not be read: more than 65536 bytes.");
    await expect(readFacts(pipe({ code: 0, out: "{" }), "choibot", "/h", "/a", "/x")).rejects.toThrow("not readable");
    await expect(readFacts(pipe({ code: 2, out: "boom" }), "choibot", "/h", "/a", "/x")).rejects.toThrow(/could not be read:\nboom/);
    // The account's output as root prints it: printable characters only.
    await expect(readFacts(pipe({ code: 2, out: "\u001b[2K\u001b[1A✔ Strong protection is set up\r" }), "choibot", "/h", "/a", "/x")).rejects.toThrow("could not be read:\n?[2K?[1A? Strong protection is set up");
    expect(printable("a\u0007b\nc\u009bd")).toBe("a?b\nc?d");
  });

  it("the pipe: the output; a cap; a time limit; a child that keeps the pipe open holds root no longer than the limit", async () => {
    expect(await pipeRun(["sh", "-c", "printf '{}'"], 100, 5000)).toEqual({ code: 0, out: "{}" });
    expect(await pipeRun(["sh", "-c", "echo out; echo err >&2; exit 3"], 100, 5000)).toEqual({ code: 3, out: "out\nerr\n" });
    expect(await pipeRun(["sh", "-c", "head -c 5000 /dev/zero"], 1000, 5000)).toEqual({ why: "more than 1000 bytes" });
    const t0 = Date.now();
    expect(await pipeRun(["sh", "-c", "sleep 5"], 100, 300)).toEqual({ why: "no answer within 0 s" });
    // It left its group (setsid) and holds the pipe: root stops at the limit all the same.
    expect(await pipeRun(["sh", "-c", "setsid sleep 5 & echo partial"], 100, 400)).toEqual({ why: "no answer within 0 s" });
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  // Alive: its /proc entry is there and it is not a zombie (kill(pid, 0) is true for a zombie).
  const alive = (pid: number) => { try { return !/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { return false; } };
  const waitDead = async (pid: number) => { for (let i = 0; i < 40 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50)); return !alive(pid); };

  it("the limit while the command runs: its whole process group is killed (it runs in a group of its own)", async () => {
    const t = mkdtempSync(join(tmpdir(), "strong-root-pipe-"));
    try {
      expect(await pipeRun(["sh", "-c", `sleep 30 & echo $! > ${t}/pid; sleep 30`], 100, 400)).toEqual({ why: "no answer within 0 s" });
      expect(await waitDead(Number(readFileSync(join(t, "pid"), "utf8")))).toBe(true);
    } finally {
      rmSync(t, { recursive: true, force: true });
    }
  });

  it("after the command's exit no group is killed (its id can be another one's then): root only stops reading", async () => {
    const t = mkdtempSync(join(tmpdir(), "strong-root-pipe-"));
    let pid = 0;
    try {
      // It exits at once; its child keeps the pipe open, in the same group.
      expect(await pipeRun(["sh", "-c", `sleep 30 & echo $! > ${t}/pid`], 100, 400)).toEqual({ why: "no answer within 0 s" });
      pid = Number(readFileSync(join(t, "pid"), "utf8"));
      expect(alive(pid)).toBe(true);
    } finally {
      if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
      rmSync(t, { recursive: true, force: true });
    }
  });

  it("the error output is capped", async () => {
    const r = await pipeRun(["sh", "-c", "head -c 100000 /dev/zero | tr '\\0' e >&2; exit 1"], 100, 5000);
    expect("code" in r && r.code === 1 && r.out.length === STDERR_MAX).toBe(true);
  });

  it("root's commands get root's fixed env, never the env of the process that runs it", () => {
    const r = realExec(["env"]);
    expect([r.code, r.out.trim().split("\n").sort()]).toEqual([0, ["DEBIAN_FRONTEND=noninteractive", "LANG=C.UTF-8", `PATH=${FIXED_PATH}`]]);
  });
});

describe("the plan of a root copy (H4: the update of the root parts)", () => {
  it("the console stopped first; no fresh check, no restart; then the same steps as a first set-up", () => {
    expect(fromCopy().map((s) => s.id)).toEqual(["stopped", "settings-check", "packages", "accounts", "tools", "private", "shared", "helper", "agent-git", "chief-git", "settings", "check"]);
    const stopped = fromCopy()[0].actions[0] as Run;
    expect(stopped.run).toEqual(["bash", "-c", CONSOLE_STOPPED_CHECK, "bash", "1000", NAMES.unit, "/sys/fs/cgroup"]);
    expect(stopped.fail).toBe("The console (choibot.service) runs. The update stops it before this set-up.");
  });

  it("installs no package and changes no account and no group: it checks them (no network, and no group that needs a restart)", () => {
    const text = planText(fromCopy());
    expect(text).not.toMatch(/apt-get|useradd|groupadd|usermod|gpasswd/);
    const acc = runs(fromCopy().filter((s) => s.id === "accounts"));
    expect(acc.map((a) => a.run.slice(0, 2))).toEqual([["getent", "group"], ["id", "-u"], ["id", "-u"], ["sh", "-c"], ["sh", "-c"], ["sh", "-c"], ["sh", "-c"], ["sh", "-c"], ["sh", "-c"]]);
    expect(acc.every((a) => !a.unless && !a.changes && a.fail)).toBe(true);
    expect(acc[1].fail).toBe("The account choibot-agent is not as the first set-up made it. An update changes no account and no group.");
  });

  it("Node, gh and the helper come from the copy: root reads root's files, no read as the console user; Claude Code and dtach stay", () => {
    const r = runs(fromCopy());
    // No source read as the console user (a first set-up's copyAsUser and its Node tar stream).
    expect(r.filter((a) => a.run[2] === 'runuser -u "$1" -- cat -- "$2" > "$3"' || a.run[2]?.includes('runuser -u "$1" -- tar'))).toEqual([]);
    expect(runs(strongPlan(FACTS)).filter((a) => a.run[2] === 'runuser -u "$1" -- cat -- "$2" > "$3"')).toHaveLength(4);
    expect(r).toContainEqual({ run: ["bash", "-c", NODE_FROM_COPY, "bash", `${COPY}/node`, "/usr/local/lib/choibot/node"], fail: "The Node folder of the release could not be put in /usr/local/lib/choibot/node.", say: true });
    for (const [src, dest] of [[`${COPY}/gh/bin/gh`, "/usr/local/lib/choibot/bin/gh"], [`${COPY}/app/deploy/choibot-agent-exec`, "/usr/local/bin/choibot-agent-exec"]]) {
      const same = ["sh", "-c", 'test -f "$2" && test ! -L "$2" && cmp -s -- "$1" "$2"', "sh", src, dest];
      expect(r).toContainEqual({ run: ["install", "-o", "root", "-g", "root", "-m", "0755", "-T", "--", src, `${dest}.new`], unless: same });
      expect(r).toContainEqual({ run: ["mv", "-f", "-T", "--", `${dest}.new`, dest], unless: same });
      // The same bytes are not enough: the owner and the mode are set each time (no `unless`).
      expect(r).toContainEqual({ run: ["chown", "root:root", "--", dest] });
      expect(r).toContainEqual({ run: ["chmod", "0755", "--", dest] });
    }
    expect(r).toContainEqual({ run: ["test", "-x", "/usr/local/lib/choibot/bin/claude"], fail: expect.stringMatching(/first set-up puts it there/) });
    expect(r).toContainEqual({ run: ["test", "-x", "/usr/local/lib/choibot/bin/dtach"], fail: expect.stringMatching(/first set-up puts it there/) });
    // The tools of the facts are not used (the user's Claude Code, its dtach in /usr).
    expect(planText(fromCopy())).not.toMatch(/\/home\/choibot\/\.local\/share\/claude|\/usr\/bin\/dtach|\/opt\/choibot\/gh|\/opt\/choibot\/node/);
  });

  it("the sudoers file, the helper's config and the settings are the same as a first set-up's", () => {
    const writes = (steps: ReturnType<typeof strongPlan>) => steps.flatMap((s) => s.actions).filter((a) => "write" in a || "env" in a);
    expect(writes(fromCopy())).toEqual(writes(strongPlan(FACTS)));
  });

  it("AGENTS ALIVE: no step stops or restarts the console, its user manager or an agent; nothing of the sessions or the homes is removed; each root file changes by a rename", () => {
    const steps = fromCopy();
    const lines = runs(steps).map((a) => a.run.join(" "));
    expect(lines.some((l) => l.includes(RESTART_STEP) || l.includes(CONSOLE_GROUP_CHECK))).toBe(false);
    for (const l of lines) {
      expect(l).not.toMatch(/systemctl (restart|stop|kill|try-restart|reload-or-restart)|\bkill(all)?\b|\bpkill\b|loginctl|terminate-user|dtach -/);
      // The only removals: the new and old names of a swap of the tools, and the check's own temp file.
      for (const m of l.matchAll(/rm -(?:rf|f) -- ([^\n;|&]+)/g)) expect(m[1].trim()).toMatch(/^("\$2\.new" "\$2\.old"|"\$2\.old"|"\$2\.new"|"\$f")$/);
      expect(l).not.toMatch(/^rm /);
    }
    // The socket folders and the homes: made or checked, never emptied (systemd-tmpfiles --create keeps what is in a folder).
    expect(lines.filter((l) => l.includes("/run/choibot-dtach"))).toEqual(lines.filter((l) => /^(test|sh -c test ! -L)/.test(l) && l.includes("/run/choibot-dtach")));
    // Each root file: written under a new name, renamed into place.
    expect(lines.filter((l) => /^mv /.test(l))).toEqual([
      "mv -f -T -- /usr/local/lib/choibot/bin/gh.new /usr/local/lib/choibot/bin/gh",
      "mv -f -T -- /usr/local/bin/choibot-agent-exec.new /usr/local/bin/choibot-agent-exec",
    ]);
  });
});

describe("the run of a root copy plan, with a fake exec", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "strong-root-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const facts = (): StrongFacts => ({ ...FACTS, envFile: join(dir, "console.env") });
  function fakeExec(o: { stopped?: boolean } = {}): { exec: Exec; calls: string[] } {
    const calls: string[] = [];
    const exec: Exec = (argv, x = {}) => {
      calls.push(`${x.as ? `[${x.as}] ` : ""}${argv.join(" ")}`);
      if (argv[2] === CONSOLE_STOPPED_CHECK) return o.stopped === false ? { code: 1, out: "The console (choibot.service) runs.\n" } : { code: 0, out: "The console does not run.\n" };
      if (argv[0] === "id" && argv[1] === "-u") return { code: 0, out: argv.at(-1) === "choibot-chief" ? "1002\n" : "1001\n" };
      if (argv[0] === "timeout" && x.as) return { code: 0, out: readFileSync(argv.at(-1)!, "utf8") };
      if (argv[0] === "sh" && argv[2]?.startsWith("umask 077") && x.as) { writeFileSync(argv[4], x.input ?? ""); return { code: 0, out: "" }; }
      return { code: 0, out: "" };
    };
    return { exec, calls };
  }

  it("runs with the console stopped; the settings keep their order and comments; no restart", () => {
    writeFileSync(join(dir, "console.env"), "# mine\nPORT=3100\nAGENT_EXEC_HELPER=/old\nCHIEF_ENABLED=1\n");
    const { exec, calls } = fakeExec();
    const log: string[] = [];
    expect(applyPlan(fromCopy(facts()), { exec, dir: () => null, envFile: join(dir, "console.env"), writeFile: () => {}, log: (s) => log.push(s) })).toBe(0);
    expect(calls[0]).toMatch(/^bash -c systemctl is-active --quiet "user@\$1\.service" \|\| \{ echo "The user manager does not run/);
    const text = readFileSync(join(dir, "console.env"), "utf8");
    expect(text.split("\n").slice(0, 4)).toEqual(["# mine", "PORT=3100", "AGENT_EXEC_HELPER=/usr/local/bin/choibot-agent-exec", "CHIEF_ENABLED=1"]);
    expect(Object.fromEntries(systemdValues(text))).toMatchObject({ CHIEF_AGENT_UID: "1001", CHIEF_PERSISTENT_UID: "1002", AGENT_DTACH_DIR: "/run/choibot-dtach" });
    expect(calls.some((c) => c.includes("systemctl restart"))).toBe(false);
    expect(log.at(-1)).toMatch(/^✔ Strong protection is set up/);
  });

  const run = (text: string, exec = fakeExec().exec) => {
    writeFileSync(join(dir, "console.env"), text);
    const log: string[] = [];
    const code = applyPlan(fromCopy(facts()), { exec, dir: () => null, envFile: join(dir, "console.env"), writeFile: () => {}, log: (x) => log.push(x) });
    return { code, log: log.join("\n"), text: readFileSync(join(dir, "console.env"), "utf8") };
  };
  const NEW = { AGENT_EXEC_HELPER: "/usr/local/bin/choibot-agent-exec", CHIEF_AGENT_UID: "1001", AGENT_DTACH_DIR: "/run/choibot-dtach" };

  it("the settings check is the second step: a file that root cannot write so that systemd reads it stops the run before any change", () => {
    const cases: [string, string][] = [
      // U+00A0 is no white space for systemd: `#x="` is a key whose quote swallows the rest.
      ["\u00a0#x=\"\nAGENT_EXEC_HELPER=/old\n", "the quoted value of line 1 does not end"],
      ["PORT=1\nNOTE='abc\n", "the quoted value of line 2 does not end"],
      ["PORT=1\n# a comment \\\nAGENT_EXEC_HELPER=/old\n", "line 2 is a comment that ends with a backslash"],
      ["PORT=1\nNOTE=x\\", "the last line ends with a backslash"],
      ["PORT=1\u0000\nX=2\n", "line 1 holds a NUL character"],
      // Bytes that are not UTF-8 reach root as U+FFFD: refused, also in a comment, also a real U+FFFD.
      ["PORT=\ufffd\n", "line 1 holds bytes that are not UTF-8, or the character U+FFFD (root cannot tell them apart)"],
      ["PORT=1\n# caf\ufffd\n", "line 2 holds bytes that are not UTF-8, or the character U+FFFD (root cannot tell them apart)"],
    ];
    for (const [text, why] of cases) {
      const calls: string[] = [];
      const f = fakeExec();
      const r = run(text, (argv, x) => { calls.push(argv.join(" ")); return f.exec(argv, x); });
      expect([why, r.code]).toEqual([why, 1]);
      expect(r.log).toContain(`✖ settings-check: ${join(dir, "console.env")}: ${why}. Change that, then run the set-up again.`);
      // Only the stopped check and the read ran: no change.
      expect(calls).toHaveLength(2);
      expect(r.text).toBe(text);
    }
  });

  it("every form that systemd reads is written correctly: CRLF, KEY = v, quotes, export, a backslash at a line end, U+00A0 with a closed quote", () => {
    const ok = (text: string) => {
      const r = run(text);
      expect([text, r.code]).toEqual([text, 0]);
      expect(Object.fromEntries([...systemdValues(r.text)].filter(([k]) => k in NEW))).toEqual(NEW);
      return r.text;
    };
    // CRLF stays CRLF.
    expect(ok("PORT=1\r\nAGENT_EXEC_HELPER=/old\r\n").startsWith("PORT=1\r\nAGENT_EXEC_HELPER=/usr/local/bin/choibot-agent-exec\r\n")).toBe(true);
    // "KEY = v" is KEY for systemd: that assignment takes the value.
    expect(ok("AGENT_EXEC_HELPER = /old\nPORT=1\n").startsWith("AGENT_EXEC_HELPER=/usr/local/bin/choibot-agent-exec\nPORT=1\n")).toBe(true);
    // A quoted value that spans lines: the key in it is not a key; the new one comes at the end.
    expect(ok('NOTE="a\nAGENT_EXEC_HELPER=/old\nb"\nPORT=1\n').startsWith('NOTE="a\nAGENT_EXEC_HELPER=/old\nb"\nPORT=1\n')).toBe(true);
    expect(ok("\u00a0#x=\"\nAGENT_EXEC_HELPER=/old\n\"\nPORT=1\n")).toMatch(/\nAGENT_EXEC_HELPER=\/usr\/local\/bin\/choibot-agent-exec\n/);
    // A backslash at a line end joins the next line; a backslash with a space after it does not.
    expect(ok("NOTE=x\\\nAGENT_EXEC_HELPER=/old\n").startsWith("NOTE=x\\\nAGENT_EXEC_HELPER=/old\n")).toBe(true);
    expect(ok("NOTE=x\\ \nAGENT_EXEC_HELPER=/old\n").startsWith("NOTE=x\\ \nAGENT_EXEC_HELPER=/usr/local/bin/choibot-agent-exec\n")).toBe(true);
    ok("export X=1\nAGENT_EXEC_HELPER=/old\n");
    ok("X=1\rAGENT_EXEC_HELPER=/evil\n");
    // No line end at the end: one is added before the new keys.
    expect(ok("PORT=1")).toMatch(/^PORT=1\nCHIEF_AGENT_UID=1001\n/);
  });

  it("a CRLF file whose keys are all right: no write, success", () => {
    const keys = (strongPlan(FACTS).find((x) => x.id === "settings")!.actions[0] as Extract<Action, { env: Record<string, string> }>).env;
    const text = Object.entries(keys).map(([k, v]) => `${k}=${v.replace("<uid of the agent account>", "1001").replace("<uid of the second account>", "1002")}\r\n`).join("");
    const calls: string[] = [];
    const f = fakeExec();
    const r = run(text, (argv, x) => { calls.push(argv.join(" ")); return f.exec(argv, x); });
    expect(r.code).toBe(0);
    expect(calls.some((c) => c.includes("umask 077"))).toBe(false);
    expect(r.text).toBe(text);
  });

  it("the texts that the product writes pass: the set-up and the first start (serializeEnv), the Settings page (patchEnvText)", () => {
    const setup = serializeEnv(new Map([["PORT", "3100"], ["CHIEF_ENABLED", "1"], ["CONSOLE_COOKIE_SECRET", "abc_DEF-123"]]));
    const page = patchEnvText("# mine\r\nPORT = 3100\r\nNOTE=\"a b\"\r\nexport Y=1\r\nTELEGRAM_MASTER_CHAT_ID=1\r\n", { TELEGRAM_MASTER_CHAT_ID: "-100123", TELEGRAM_BOT_TOKEN: "123:abc" });
    for (const t of [setup, page]) {
      expect(settingsRefusal(t)).toBeNull();
      const r = run(t);
      expect([t, r.code]).toEqual([t, 0]);
      const want = new Map([...systemdValues(t), ...Object.entries(NEW)]);
      for (const [k, v] of want) if (!(k in NEW) || NEW[k as keyof typeof NEW] === v) expect([k, systemdValues(r.text).get(k)]).toEqual([k, v]);
    }
  });

  it("success only when the file holds the new values after the write (read back by systemd's rules); never a line of the file in the output", () => {
    // The write lands, but not as root wrote it: a secret, and a quote that swallows the keys.
    const f = fakeExec();
    const bad: Exec = (argv, x = {}) => {
      if (argv[0] === "sh" && argv[2]?.startsWith("umask 077") && x.as) { writeFileSync(argv[4], `TELEGRAM_BOT_TOKEN=s3cr3t-value\nNOTE="\n${x.input ?? ""}`); return { code: 0, out: "" }; }
      return f.exec(argv, x);
    };
    const r = run("PORT=1\n", bad);
    expect(r.code).toBe(1);
    expect(r.log).toContain("does not hold the new settings after the write");
    expect(r.log).not.toContain("s3cr3t");
    // The values are there, but after a NUL: systemd stops reading at the NUL, so the read-back's
    // refusal check (not its values) must catch it.
    const nul: Exec = (argv, x = {}) => {
      if (argv[0] === "sh" && argv[2]?.startsWith("umask 077") && x.as) { writeFileSync(argv[4], `X=1\u0000\n${x.input ?? ""}`); return { code: 0, out: "" }; }
      return f.exec(argv, x);
    };
    const r2 = run("PORT=1\n", nul);
    expect([r2.code, r2.log.includes("does not hold the new settings after the write")]).toEqual([1, true]);
    // No write at all: the same.
    const noWrite: Exec = (argv, x = {}) => (argv[0] === "sh" && argv[2]?.startsWith("umask 077") ? { code: 0, out: "" } : f.exec(argv, x));
    expect(run("TELEGRAM_BOT_TOKEN=s3cr3t-value\n", noWrite).log).not.toContain("s3cr3t");
    // A read that fails says nothing of the file either.
    const failRead: Exec = (argv, x = {}) => (argv[0] === "timeout" ? { code: 1, out: "TELEGRAM_BOT_TOKEN=s3cr3t-value" } : f.exec(argv, x));
    const r3 = run("PORT=1\n", failRead);
    expect([r3.code, r3.log.includes("s3cr3t")]).toEqual([1, false]);
  });

  it("values that are right in a refused file are not 'the same': the first set-up (no early check) refuses it at its settings step", () => {
    const keys = (strongPlan(FACTS).find((x) => x.id === "settings")!.actions[0] as Extract<Action, { env: Record<string, string> }>).env;
    const right = Object.entries(keys).map(([k, v]) => `${k}=${v.replace("<uid of the agent account>", "1001").replace("<uid of the second account>", "1002")}\n`).join("");
    const text = `${right}NOTE="open\n`;
    writeFileSync(join(dir, "console.env"), text);
    const log: string[] = [];
    expect(applyPlan(strongPlan(facts(), { ...STRONG_DEFAULTS, acceptUsed: true }), { exec: fakeExec().exec, dir: () => null, envFile: join(dir, "console.env"), writeFile: () => {}, log: (x) => log.push(x) })).toBe(1);
    expect(log.join("\n")).toContain(`✖ settings: ${join(dir, "console.env")}: the quoted value of line ${Object.keys(keys).length + 1} does not end.`);
    expect(readFileSync(join(dir, "console.env"), "utf8")).toBe(text);
  });

  it("the output of a failed write is never printed (it can hold the file's text)", () => {
    const f = fakeExec();
    const failWrite: Exec = (argv, x = {}) => (argv[0] === "sh" && argv[2]?.startsWith("umask 077") ? { code: 1, out: "TELEGRAM_BOT_TOKEN=s3cr3t-value" } : f.exec(argv, x));
    const r = run("PORT=1\n", failWrite);
    expect([r.code, r.log.includes("cannot write"), r.log.includes("s3cr3t")]).toEqual([1, true, false]);
  });

  it("a file over the size limit is refused", () => {
    expect(run(`PAD=${"x".repeat(256 * 1024)}\n`).log).toContain("is larger than 262144 bytes");
  });

  it("a value that is not plain is never written", () => {
    expect(settingsText("A=1\n", { B: "a b" })).toEqual({ refused: "the value of B is not plain" });
    expect(settingsText("A=1\n", { B: 'x"' })).toEqual({ refused: "the value of B is not plain" });
    writeFileSync(join(dir, "console.env"), "A=1\n");
    const log: string[] = [];
    const steps = [{ id: "settings", why: "w", actions: [{ env: { B: "a\\b" }, as: "choibot" }] }];
    expect(applyPlan(steps, { exec: fakeExec().exec, envFile: join(dir, "console.env"), log: (x) => log.push(x) })).toBe(1);
    expect(log.join("\n")).toContain("the value of B is not plain");
  });

  it("the output of a command, in a failure and in a step that says it: printable characters only", () => {
    const steps = [
      { id: "say", why: "w", actions: [{ run: ["say"], say: true as const }] },
      { id: "fails", why: "w", actions: [{ run: ["fails"] }] },
    ];
    const exec: Exec = (argv) => (argv[0] === "say" ? { code: 0, out: "ok \u001b[2Kfine\n" } : { code: 1, out: "\u001b[1A✔ all good\r" });
    const log: string[] = [];
    expect(applyPlan(steps, { exec, envFile: "/x", log: (x) => log.push(x) })).toBe(1);
    expect(log.join("\n")).toContain("    ok ?[2Kfine");
    expect(log.join("\n")).toContain("    ?[1A? all good");
    expect(log.join("\n")).not.toMatch(/\u001b|\r/);
  });

  it("an account whose uid is 0 never fills a mark", () => {
    writeFileSync(join(dir, "console.env"), "PORT=1\n");
    const { exec } = fakeExec();
    const zero: Exec = (argv, x = {}) => (argv[0] === "id" && argv[1] === "-u" && argv.at(-1) === "choibot-agent" ? { code: 0, out: "0\n" } : exec(argv, x));
    const log: string[] = [];
    expect(applyPlan(fromCopy(facts()), { exec: zero, dir: () => null, envFile: join(dir, "console.env"), writeFile: () => {}, log: (x) => log.push(x) })).toBe(1);
    expect(log.join("\n")).toContain("the uid of choibot-agent");
  });

  it("the console runs: it stops at the first step, before any change", () => {
    const { exec, calls } = fakeExec({ stopped: false });
    const log: string[] = [];
    expect(applyPlan(fromCopy(facts()), { exec, dir: () => null, envFile: join(dir, "console.env"), writeFile: () => {}, log: (s) => log.push(s) })).toBe(1);
    expect(calls).toHaveLength(1);
    expect(log.join("\n")).toContain("✖ stopped: The console (choibot.service) runs. The update stops it before this set-up.");
  });

  it("the whole run from the command: the copy and the process checked, the facts read as the user and checked, the plan printed", async () => {
    const proc: Proc = { env: { PATH: FIXED_PATH }, execArgv: [], execPath: `${COPY}/node/bin/node`, cwd: COPY, uid: 0, self: `${COPY}/app/bin/lib/strong-root.ts` };
    const exec: Exec = (argv) => ({ code: 0, out: argv[0] === "getent" ? "choibot:x:1000:1000:,,,:/home/choibot:/bin/bash\n" : "" });
    const piped: string[][] = [];
    const pipe = (f: unknown): Pipe => async (argv, o) => { piped.push([o.as, ...argv]); return { code: 0, out: JSON.stringify(f) }; };
    const out: string[] = [];
    const err: string[] = [];
    const run = (f: unknown, args = ["--user", "choibot", "--app", "/opt/choibot/app", "--dry-run"]) =>
      runRootCopy(args, { proc, copyFs: copyTree(), exec, pipe: pipe(f), findOldHomes: () => [], out: (s) => out.push(s), err: (s) => err.push(s) });
    expect(await run(FACTS)).toBe(0);
    expect(out.join("\n")).toContain("# stopped: ");
    expect(out.join("\n")).toContain(`bash -c `);
    expect(piped[0].slice(0, 2)).toEqual(["choibot", "sh"]);
    expect(piped[0].slice(-3)).toEqual(["/opt/choibot/app", "/home/choibot", "/opt/choibot/node/bin:/usr/bin:/bin"]);
    expect(await run({ ...FACTS, workspace: "/etc/w" })).toBe(1);
    expect(err.at(-1)).toBe("✖ The facts are refused: workspace: in /etc.");
    expect(await run({ ...FACTS, app: "/srv/other/app" })).toBe(1);
    expect(err.at(-1)).toBe("✖ The facts are refused: app: the facts are of another code folder.");
    expect(await run({ ...FACTS, user: "mallory" })).toBe(1);
    expect(err.at(-1)).toBe("✖ The facts are refused: user: the facts are of another user than choibot.");
    expect(await run(FACTS, ["--user", "choibot", "--app", "opt/choibot/app"])).toBe(2);
    expect(await runRootCopy(["--user", "choibot", "--app", "/opt/choibot/app"], { proc: { ...proc, env: { ...proc.env, NODE_OPTIONS: "x" } }, copyFs: copyTree(), exec, pipe: pipe(FACTS), out: () => {}, err: (s) => err.push(s) })).toBe(1);
    expect(err.at(-1)).toMatch(/no NODE_OPTIONS/);
    // The copy is checked before anything else runs.
    piped.length = 0;
    expect(await runRootCopy(["--user", "choibot", "--app", "/opt/choibot/app"], { proc, copyFs: copyTree({ [`${COPY}/node/lib/npm.js`]: { kind: "file", uid: 1000 } }), exec, pipe: pipe(FACTS), out: () => {}, err: (s) => err.push(s) })).toBe(1);
    expect(err.at(-1)).toBe(`✖ ${COPY}/node/lib/npm.js is not a file of root that only root can write`);
    expect(piped).toEqual([]);
  });
});

// The rules of systemd's reading (src/basic/env-file.c, systemd 255), one case each: text → values.
const SYSTEMD_TABLE: [string, Record<string, string>][] = [
  // A comment that holds "=": no key.
  ["; B=2\nA=1\n", { A: "1" }],
  ["# B=2\n;C=3\nA=1\n", { A: "1" }],
  ['A="x\\x"\n', { A: "x\\x" }],
  ['A="\\$x\\"\\\\\\`"\n', { A: '$x"\\`' }],
  ["A='a'b\n", { A: "ab" }],
  ["A='a' 'b'\n", { A: "ab" }],
  ['A="a"b c\n', { A: "ab c" }],
  ["# c \\\nB=2\n", { B: "2" }],
  ["A=x\\\ny\n", { A: "xy" }],
  ["A=x\\ \nB=2\n", { A: "x ", B: "2" }],
  ["  A =  v  \n", { A: "v" }],
  ["A=1\rB=2\r\n", { A: "1", B: "2" }],
  ["B=1 # no comment\n", { B: "1 # no comment" }],
  ["A=\nB=''\n", { A: "", B: "" }],
  ["A=1\nA=2", { A: "2" }],
];

describe("the settings file, as systemd reads it", () => {
  it("the rules, one case each (a table)", () => {
    for (const [text, want] of SYSTEMD_TABLE) expect([text, Object.fromEntries(systemdValues(text))]).toEqual([text, want]);
  });

  // The same table through the real systemd of this machine (a transient user unit that prints its
  // environment). Where `systemd-run --user` does not work, the case is skipped, and its name says so.
  const uid = process.getuid?.() ?? -1;
  const sdEnv = { PATH: "/usr/bin:/bin", XDG_RUNTIME_DIR: `/run/user/${uid}` } as unknown as NodeJS.ProcessEnv;
  const haveSystemd = spawnSync("systemd-run", ["--user", "--wait", "--pipe", "-q", "/bin/true"], { env: sdEnv, timeout: 20_000 }).status === 0;
  it.skipIf(!haveSystemd)(haveSystemd ? "the table gives the same values with the real systemd (systemd-run --user)" : "SKIPPED: no systemd-run --user here", () => {
    const t = mkdtempSync(join(tmpdir(), "strong-root-sd-"));
    try {
      SYSTEMD_TABLE.forEach(([text, want], i) => {
        const f = join(t, `t${i}.env`);
        writeFileSync(f, text);
        const r = spawnSync("systemd-run", ["--user", "--wait", "--pipe", "-q", "-p", `EnvironmentFile=${f}`, "/usr/bin/env", "-0"], { env: sdEnv, encoding: "utf8", timeout: 20_000 });
        const real = Object.fromEntries(r.stdout.split("\0").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
        expect([text, Object.fromEntries(Object.keys(want).map((k) => [k, real[k]]))]).toEqual([text, want]);
        expect([text, Object.fromEntries(systemdValues(text))]).toEqual([text, want]);
      });
    } finally {
      rmSync(t, { recursive: true, force: true });
    }
  }, 120_000);

  it("the writer's result is checked by systemd's reading: a key that is no key is refused", () => {
    expect(settingsText("X=1\n", { "A=B": "1" })).toEqual({ refused: "the keys cannot be set so that systemd reads them" });
    expect(settingsText("X=1\n", { "#K": "1" })).toEqual({ refused: "the keys cannot be set so that systemd reads them" });
  });

  it("the assignments and their ranges; the last one of a key wins", () => {
    const t = "# c\nA=1\n  B = 2 \nA='x y'\nC=a\\\nb\n";
    expect(readSystemdEnv(t).assigns.map((a) => [a.key, a.value, t.slice(a.start, a.stop)])).toEqual([
      ["A", "1", "A=1"], ["B", "2", "B = 2 "], ["A", "x y", "A='x y'"], ["C", "ab", "C=a\\\nb"],
    ]);
    expect(Object.fromEntries(systemdValues(t))).toEqual({ A: "x y", B: "2", C: "ab" });
  });
  it("a key's first assignment takes the value, its other ones go, a new key at the end; every other character stays", () => {
    expect(settingsText("# c\nA=1\nB=2\nA=3\n\nC=4", { A: "9", D: "5" })).toBe("# c\nA=9\nB=2\n\nC=4\nD=5\n");
    expect(settingsText("", { A: "1" })).toBe("A=1\n");
    expect(settingsText("A=1\r\n", { B: "2" })).toBe("A=1\r\nB=2\r\n");
  });
});

describe("the shells of a root copy run (stubs)", () => {
  let t: string;
  beforeEach(() => { t = mkdtempSync(join(tmpdir(), "strong-root-sh-")); });
  afterEach(() => { spawnSync("chmod", ["-R", "u+w", t]); rmSync(t, { recursive: true, force: true }); });

  it("the console stopped: each folder of the unit's name is tested, whatever the order (a decoy does not hide the real one); a process below it counts; a cap on their count", () => {
    const bin = join(t, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "systemctl"), '#!/bin/sh\nif [ "$1" = is-active ]; then [ "$ACTIVE" = 1 ]; exit $?; fi\necho /user.slice/u\n', { mode: 0o755 });
    const cg = join(t, "cg");
    const events = (d: string, populated: 0 | 1) => { mkdirSync(d, { recursive: true }); writeFileSync(join(d, "cgroup.events"), `populated ${populated}\nfrozen 0\n`); };
    const run = (active = true) => {
      const r = spawnSync("bash", ["-c", CONSOLE_STOPPED_CHECK, "bash", "1000", "choibot.service", cg], {
        encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin`, ACTIVE: active ? "1" : "0" } as unknown as NodeJS.ProcessEnv,
      });
      return [r.status, r.stdout.trim()];
    };
    // Two places; the real unit in one, a decoy (empty) in the other, then the other way round:
    // a check that tests only the first folder that `find` gives fails one of the two.
    const x = join(cg, "user.slice", "u", "app.slice", "choibot.service");
    const y = join(cg, "user.slice", "u", "a", "choibot.service");
    for (const [real, decoy] of [[x, y], [y, x]]) {
      events(decoy, 0);
      events(real, 1);
      expect(run()).toEqual([1, "The console (choibot.service) runs."]);
    }
    // A process only in a folder below the unit's: "populated 1" holds for the unit too.
    events(x, 0);
    events(y, 0);
    events(join(x, "sub"), 1);
    writeFileSync(join(x, "cgroup.events"), "populated 1\n");
    expect(run()).toEqual([1, "The console (choibot.service) runs."]);
    events(x, 0);
    rmSync(join(x, "sub"), { recursive: true });
    expect(run()).toEqual([0, "The console does not run."]);
    rmSync(x, { recursive: true });
    expect(run()).toEqual([0, "The console does not run."]);
    // More folders of that name than the cap: refused.
    for (let n = 0; n < CGROUP_NAMES_MAX; n++) events(join(cg, "user.slice", "u", `d${n}`, "choibot.service"), 0);
    expect(run()).toEqual([1, `More than ${CGROUP_NAMES_MAX} folders named choibot.service in the cgroup tree of the user manager of 1000.`]);
    expect(run(false)).toEqual([0, "The user manager does not run: the console does not run."]);
    rmSync(cg, { recursive: true });
    expect(run()).toEqual([1, "The cgroup of the user manager of 1000 is not there."]);
  });

  it("the console stopped: a folder that goes away during the walk passes; the time limit, and a find that cannot run, refuse", () => {
    const bin = join(t, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "systemctl"), '#!/bin/sh\nif [ "$1" = is-active ]; then exit 0; fi\necho /user.slice/u\n', { mode: 0o755 });
    // timeout: writes its arguments, then runs the command, or exits with $TIMEOUT_RC.
    writeFileSync(join(bin, "timeout"), `#!/bin/sh\necho "$1 $2 $3" > ${t}/timeout.args\n[ -n "$TIMEOUT_RC" ] && exit "$TIMEOUT_RC"\nshift 3\nexec "$@"\n`, { mode: 0o755 });
    // find: the folders it found before one went away ("No such file or directory"): exit $FIND_RC.
    writeFileSync(join(bin, "find"), `#!/bin/sh\ncat ${t}/found\necho "find: a folder: No such file or directory" >&2\nexit "$FIND_RC"\n`, { mode: 0o755 });
    const unit = join(t, "cg", "user.slice", "u", "app.slice", "choibot.service");
    mkdirSync(unit, { recursive: true });
    writeFileSync(join(t, "found"), `${unit}\n`);
    const run = (populated: 0 | 1, more: Record<string, string>) => {
      writeFileSync(join(unit, "cgroup.events"), `populated ${populated}\n`);
      const r = spawnSync("bash", ["-c", CONSOLE_STOPPED_CHECK, "bash", "1000", "choibot.service", join(t, "cg")], {
        encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin`, ...more } as unknown as NodeJS.ProcessEnv,
      });
      return [r.status, r.stdout.trim()];
    };
    expect(run(0, { FIND_RC: "1" })).toEqual([0, "The console does not run."]);
    expect(run(1, { FIND_RC: "1" })).toEqual([1, "The console (choibot.service) runs."]);
    expect(readFileSync(join(t, "timeout.args"), "utf8").trim()).toBe("-s KILL 20");
    for (const rc of ["124", "137"]) expect(run(0, { FIND_RC: "0", TIMEOUT_RC: rc })).toEqual([1, "The cgroup tree of the user manager of 1000 could not be read within 20 seconds."]);
    expect(run(0, { FIND_RC: "127" })).toEqual([1, "The cgroup tree of the user manager of 1000 could not be read (find: 127)."]);
  });

  it("Node from the copy under root's umask 077: the folder and its files are readable and runnable by every account", () => {
    const bin = join(t, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "install"), '#!/bin/sh\nfor a; do d=$a; done\nmkdir -m 0700 -- "$d"\n', { mode: 0o755 });
    const src = join(t, "copy-node"), dest = join(t, "tools", "node");
    mkdirSync(join(src, "bin"), { recursive: true });
    mkdirSync(join(t, "tools"));
    writeFileSync(join(src, "bin", "node"), "new", { mode: 0o755 });
    writeFileSync(join(src, "README"), "r", { mode: 0o644 });
    const r = spawnSync("bash", ["-c", `umask 077\n${NODE_FROM_COPY}`, "bash", src, dest], { encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin` } as unknown as NodeJS.ProcessEnv });
    expect([r.status, r.stdout.trim()]).toEqual([0, "Node is the release's now."]);
    const mode = (p: string) => statSync(p).mode & 0o7777;
    expect([mode(dest), mode(join(dest, "bin")), mode(join(dest, "bin", "node")), mode(join(dest, "README"))]).toEqual([0o755, 0o755, 0o755, 0o644]);
  });

  it("Node from the copy, the same files: no copy, but the owner and the modes are set again (a 0777 file, a 0700 folder)", () => {
    const bin = join(t, "bin");
    mkdirSync(bin);
    // chown to root as this test's user: a stub that writes its call.
    writeFileSync(join(bin, "chown"), `#!/bin/sh\necho "$*" >> ${t}/chown.log\n`, { mode: 0o755 });
    const src = join(t, "copy-node"), dest = join(t, "tools", "node");
    for (const d of [src, dest]) { mkdirSync(join(d, "bin"), { recursive: true }); writeFileSync(join(d, "bin", "node"), "same", { mode: 0o755 }); }
    chmodSync(join(dest, "bin", "node"), 0o777);
    chmodSync(join(dest, "bin"), 0o700);
    const r = spawnSync("bash", ["-c", NODE_FROM_COPY, "bash", src, dest], { encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin` } as unknown as NodeJS.ProcessEnv });
    expect([r.status, r.stdout.trim()]).toEqual([0, "Node is the release's already: its owner and modes are set, no other change."]);
    expect([statSync(join(dest, "bin")).mode & 0o7777, statSync(join(dest, "bin", "node")).mode & 0o7777]).toEqual([0o755, 0o755]);
    expect(readFileSync(join(t, "chown.log"), "utf8")).toBe(`-R -h root:root -- ${dest}\n`);
  });

  it("Node from the copy: the same is no change; a new one replaces the folder by two renames; a pipe in it stops the step and the old folder stays", () => {
    // `install -d -o root -g root` as this test's user: a stub that makes the folder only.
    const bin = join(t, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "install"), '#!/bin/sh\nfor a; do d=$a; done\nmkdir -m 0700 -- "$d"\n', { mode: 0o755 });
    writeFileSync(join(bin, "chown"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const src = join(t, "copy-node"), dest = join(t, "tools", "node");
    mkdirSync(join(src, "bin"), { recursive: true });
    mkdirSync(join(dest, "bin"), { recursive: true });
    writeFileSync(join(src, "bin", "node"), "new", { mode: 0o755 });
    writeFileSync(join(dest, "bin", "node"), "old", { mode: 0o755 });
    const run = () => {
      const r = spawnSync("bash", ["-c", NODE_FROM_COPY, "bash", src, dest], { encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin` } as unknown as NodeJS.ProcessEnv });
      return [r.status, r.stdout.trim()];
    };
    expect(run()).toEqual([0, "Node is the release's now."]);
    expect(readFileSync(join(dest, "bin", "node"), "utf8")).toBe("new");
    expect(readdirSync(join(t, "tools"))).toEqual(["node"]);
    expect(run()).toEqual([0, "Node is the release's already: its owner and modes are set, no other change."]);
    writeFileSync(join(src, "bin", "node"), "newer", { mode: 0o755 });
    spawnSync("mkfifo", [join(src, "bin", "fifo")]);
    expect(run()).toEqual([1, "The Node folder of the release holds a device, a pipe, a socket or a setuid file."]);
    expect(readFileSync(join(dest, "bin", "node"), "utf8")).toBe("new");
    expect(existsSync(`${dest}.new`)).toBe(false);
    chmodSync(src, 0o755);
  });
});

// main's output (strong.ts at 75f8f39, before this file existed), rendered with tsx for the facts
// of testdata/strong-root/facts.json: once as a new install (an empty HOME), once as an old one
// (CHOIBOT_AGENT_ID set: server/names.mjs). Kept as they are: a change of a text fails here.
describe("main's texts, kept as fixtures, for both name sets", () => {
  const FIX = fileURLToPath(new URL("./testdata/strong-root/", import.meta.url));
  const facts = JSON.parse(readFileSync(join(FIX, "facts.json"), "utf8")) as StrongFacts;
  const NAMES_FILES = ["plan.txt", "plan-used.txt", "sudoers.txt", "helper-conf.txt", "refusal-old-install.txt"];
  const mine = (): Record<string, string> => {
    let refusal = "";
    try { strongPlan({ ...facts, legacy: true }); } catch (e) { refusal = `${(e as Error).message}\n`; }
    return {
      "plan.txt": planText(strongPlan(facts)), "plan-used.txt": planText(strongPlan(facts, { ...STRONG_DEFAULTS, acceptUsed: true })),
      "sudoers.txt": sudoersText(facts.user, STRONG_DEFAULTS), "helper-conf.txt": helperConfText(facts, STRONG_DEFAULTS), "refusal-old-install.txt": refusal,
    };
  };
  const fixtures = (set: string) => Object.fromEntries(NAMES_FILES.map((n) => [n, readFileSync(join(FIX, set, n), "utf8")]));
  const keepKeys = (l: string) => /env_keep \+= "([^"]+)"/.exec(l)?.[1].split(" ") ?? [];

  it("a new install: the same bytes, each text", () => {
    expect(mine()).toEqual(fixtures("main-new-names"));
  });

  it("an old install (the owner's console): strong-setup refuses it, with the same words; the helper's config is the same; the sudoers line keeps the same 15 keys", () => {
    const m = mine();
    const f = fixtures("main-old-names");
    expect(m["refusal-old-install.txt"]).toBe(f["refusal-old-install.txt"]);
    expect(m["refusal-old-install.txt"]).toMatch(/^This ChoiBot keeps the names of an old install\./);
    expect(m["helper-conf.txt"]).toBe(f["helper-conf.txt"]);
    for (const n of ["sudoers.txt", "plan.txt", "plan-used.txt"]) {
      const a = m[n].split("\n");
      const b = f[n].split("\n");
      expect([n, a.length]).toEqual([n, b.length]);
      // Only the env_keep line differs: main took the order of the names of the process that
      // rendered it (old: CHOIBOT_* first); this file has one order. sudo reads it as a set of names.
      const diff = a.map((l, i) => [l, b[i]]).filter(([x, y]) => x !== y);
      expect([n, diff.length]).toEqual([n, 1]);
      expect(diff[0][0].replace(/"[^"]+"/, "")).toBe(diff[0][1].replace(/"[^"]+"/, ""));
      expect(keepKeys(diff[0][0])).toHaveLength(15);
      expect([...keepKeys(diff[0][0])].sort()).toEqual([...keepKeys(diff[0][1])].sort());
    }
  });

  it("its texts do not depend on the names of the process: plain Node renders the same bytes as an old and as a new install", () => {
    const code = [
      "const m = await import(process.env.F); const fs = await import('node:fs');",
      "const f = JSON.parse(fs.readFileSync(process.env.FACTS, 'utf8')); const O = m.STRONG_DEFAULTS;",
      "process.stdout.write([m.planText(m.strongPlan(f)), m.sudoersText(f.user, O), m.helperConfText(f, O)].join('\\n=====\\n'));",
    ].join(" ");
    const home = mkdtempSync(join(tmpdir(), "strong-root-names-"));
    try {
      const env = { PATH: FIXED_PATH, HOME: home, F: pathToFileURL(FILE).href, FACTS: join(FIX, "facts.json") };
      const render = (more: Record<string, string>) => spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", env: { ...env, ...more } as unknown as NodeJS.ProcessEnv });
      const asNew = render({});
      const asOld = render({ CHOIBOT_AGENT_ID: "x" });
      expect([asNew.status, asOld.status]).toEqual([0, 0]);
      const m = mine();
      expect(asNew.stdout).toBe([m["plan.txt"], m["sudoers.txt"], m["helper-conf.txt"]].join("\n=====\n"));
      expect(asOld.stdout).toBe(asNew.stdout);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("the settings write against main's (bin/lib/env.ts parseEnv and serializeEnv, as main's applyPlan used them)", () => {
  // The keys of the settings step, with the uids filled in as a run fills them.
  const action = strongPlan(FACTS).find((x) => x.id === "settings")!.actions[0] as Extract<Action, { env: Record<string, string> }>;
  const SET = Object.fromEntries(Object.entries(action.env).map(([k, v]) => [k, v.replace("<uid of the agent account>", "1001").replace("<uid of the second account>", "1002")]));
  const main = (text: string) => {
    const values = parseEnv(text);
    for (const [k, v] of Object.entries(SET)) values.set(k, v);
    return { text: serializeEnv(values), same: serializeEnv(values) === serializeEnv(parseEnv(text)) };
  };
  const TEXTS = [
    // An old install's settings (the owner's console): its own keys, comments, a blank line.
    "# the console of the owner\nPORT=3100\nCHOIBOT_USER_TOKEN=t0k\nCHIEF_ENABLED=1\n\nAGENT_ENV_PASS=\n",
    // A key twice (the last one wins), spaces, CRLF, a value with "=", a strong key with another value.
    "PORT=3100\r\n  CHIEF_AGENT_UID=999 \n# c\nAGENT_HOME_ROOT=/a\nAGENT_HOME_ROOT=/b\nX=a=b\n=nokey\nexport Y=1\n",
    "", "\n\n# comments only\n",
    // Every strong key there already, with its value: no write in both.
    `PORT=1\n${Object.entries(SET).map(([k, v]) => `${k}=${v}`).join("\n")}\n`,
  ];

  it("the same keys and values as main's write, and the same 'no write' decision (order and comments may differ)", () => {
    for (const t of TEXTS) {
      const m = main(t);
      const mineText = settingsText(t, SET);
      if (typeof mineText !== "string") throw new Error(mineText.refused);
      expect(Object.fromEntries(parseEnv(mineText))).toEqual(Object.fromEntries(parseEnv(m.text)));
      const now = systemdValues(t);
      expect([t, Object.entries(SET).every(([k, v]) => now.get(k) === v)]).toEqual([t, m.same]);
    }
    expect(main(TEXTS[4]).same).toBe(true);
  });

  it("a run on an owner's settings file leaves the keys and values that main's code would write", () => {
    const dir = mkdtempSync(join(tmpdir(), "strong-root-env-"));
    try {
      const file = join(dir, ".env");
      writeFileSync(file, TEXTS[0]);
      const exec: Exec = (argv, x = {}) => {
        if (argv[0] === "id" && argv[1] === "-u") return { code: 0, out: argv.at(-1) === "choibot-chief" ? "1002\n" : "1001\n" };
        if (argv[0] === "timeout" && x.as) return { code: 0, out: readFileSync(argv.at(-1)!, "utf8") };
        if (argv[0] === "sh" && argv[2]?.startsWith("umask 077") && x.as) { writeFileSync(argv[4], x.input ?? ""); return { code: 0, out: "" }; }
        return { code: 0, out: "" };
      };
      expect(applyPlan(strongPlan({ ...FACTS, envFile: file }, { ...STRONG_DEFAULTS, acceptUsed: true }), { exec, dir: () => null, envFile: file, writeFile: () => {}, log: () => {} })).toBe(0);
      expect(Object.fromEntries(parseEnv(readFileSync(file, "utf8")))).toEqual(Object.fromEntries(parseEnv(main(TEXTS[0]).text)));
      expect(readFileSync(file, "utf8").startsWith("# the console of the owner\nPORT=3100\nCHOIBOT_USER_TOKEN=t0k\n")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ensureSharedDir: the folder is opened with O_NOFOLLOW, and its owner checked again on the open folder", () => {
  const dirStat = (uid: number) => ({ isSymbolicLink: () => false, isDirectory: () => true, uid }) as unknown as Stats;
  const fake = (o: { fstatUid: number }): DirFs & { flags: number[]; owned: number[] } => {
    const flags: number[] = [];
    const owned: number[] = [];
    return {
      flags, owned,
      mkdir: () => { throw Object.assign(new Error("EEXIST"), { code: "EEXIST" }); },
      lstat: () => dirStat(0), open: (_p, f) => { flags.push(f); return 7; }, fstat: () => dirStat(o.fstatUid),
      fchown: (_fd, uid) => { owned.push(uid); }, fchmod: () => {}, close: () => {},
    };
  };
  const A = { dir: "/srv/choibot/agent-homes/uploads", owner: "choibot", group: "choibot-shared", mode: 0o2750 };
  it("O_NOFOLLOW and O_DIRECTORY on the open", () => {
    const f = fake({ fstatUid: 0 });
    expect(ensureSharedDir(A, { uid: 1000, gid: 1001 }, f)).toBeNull();
    expect(f.flags[0] & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
    expect(f.flags[0] & constants.O_DIRECTORY).toBe(constants.O_DIRECTORY);
    expect(f.owned).toEqual([1000]);
  });
  it("the open folder of another owner (it changed after the first look): refused, nothing changed", () => {
    const f = fake({ fstatUid: 1002 });
    expect(ensureSharedDir(A, { uid: 1000, gid: 1001 }, f)).toBe(`${A.dir} changed while the set-up ran. Run it again.`);
    expect(f.owned).toEqual([]);
  });
});
