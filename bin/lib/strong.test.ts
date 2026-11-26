// bin/lib/strong.test.ts — the plan of `strong-setup`, its checks of the facts, its dry run, and
// its run with a fake exec. Nothing here runs a real command as root: the exec is a fake that
// records each argv and the account it runs as.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SUDO_ENV_KEEP } from "../../server/agents/terminal.js";
import { checkHardened, type HardenedFs } from "../../server/chief/hardened.js";
import { parseEnv } from "./env.js";
import {
  AGENT_UID_MARK, CHANGED_MARK, CHIEF_SAFE_PRUNE, CHIEF_UID_MARK, CONSOLE_GROUP_CHECK, HOMES_FILE_CHECK, RESTART_STEP, STRONG_DEFAULTS, applyPlan, checkFacts, ensureSharedDir, findOldHomes, helperConfText, lookupUser, okPath,
  oldLayoutRefusal, persistentRecords, planText, runStrongSetup, strongPlan, strongRefusal, sudoersText,
  type Action, type DirAction, type Exec, type StrongFacts, type Who,
} from "./strong.js";

// The layout of a hosted server (the image recipe): the code in /opt, the workspace in /srv.
const FACTS: StrongFacts = {
  user: "choibot", uid: 1000, home: "/home/choibot", legacy: false,
  app: "/opt/choibot/app", envFile: "/opt/choibot/app/.env",
  privateDirs: [
    "/home/choibot/.local/share/choibot", "/home/choibot/.local/share/choibot/chief", "/home/choibot/.local/share/choibot/cron",
    "/home/choibot/.local/share/choibot/master", "/home/choibot/.local/share/choibot/issues",
    "/opt/choibot/app/.agent-data", "/opt/choibot/app/.services-data",
  ],
  privateFiles: ["/opt/choibot/install.log"],
  widgetsDir: "/opt/choibot/app/.widgets-data", workspace: "/srv/choibot/workspace", worktreeRoot: null,
  agentDataDir: "/opt/choibot/app/.agent-data", claudeDir: "/home/choibot/.claude",
  nodeDir: "/opt/choibot/node", claude: "/home/choibot/.local/share/claude/versions/2.1.400", gh: "/opt/choibot/gh/bin/gh", dtach: "/usr/bin/dtach",
  unit: "choibot.service", persistent: [],
};
const WHO: Who = { user: "choibot", uid: 1000, home: "/home/choibot" };
const O = STRONG_DEFAULTS;

type Run = Extract<Action, { run: string[] }>;
const all = (steps = strongPlan(FACTS)) => steps.flatMap((s) => s.actions);
const runsOf = (steps = strongPlan(FACTS)): Run[] => all(steps).filter((a): a is Run => "run" in a);
const has = (argv: string[], as?: string, steps = strongPlan(FACTS)) => runsOf(steps).some((r) => JSON.stringify(r.run) === JSON.stringify(argv) && r.as === as);
const action = (id: string, pred: (a: Action) => boolean) => strongPlan(FACTS).find((s) => s.id === id)!.actions.find(pred);

describe("the facts root takes", () => {
  it("a field of another shape is refused, and the refusal names the field", () => {
    const bad: [Partial<Record<keyof StrongFacts, unknown>>, string][] = [
      [{ user: "choibot\nALL ALL=(ALL) NOPASSWD: ALL" }, "user"], [{ user: "Choibot" }, "user"], [{ user: "mallory" }, "user: the facts are of another user than choibot"],
      [{ legacy: "no" }, "legacy"],
      [{ app: "/opt/choibot/../../etc" }, "app"], [{ app: "opt/choibot/app" }, "app"], [{ app: "/opt/choibot/app/" }, "app"], [{ app: "/opt//choibot" }, "app"],
      [{ envFile: "/opt/choibot/app/.env\nDTACH_DIR=/" }, "envFile"], [{ workspace: "/srv/choibot/work space" }, "workspace"], [{ workspace: "/srv/./choibot" }, "workspace"],
      [{ widgetsDir: 5 }, "widgetsDir"], [{ claude: "/tmp/$(id)" }, "claude"], [{ worktreeRoot: "relative" }, "worktreeRoot"],
      [{ privateDirs: [] }, "privateDirs"], [{ privateDirs: ["/home/choibot/../root"] }, "privateDirs"], [{ privateFiles: "/opt/choibot/install.log" }, "privateFiles"],
      [{ agentDataDir: "/" }, "agentDataDir"],
    ];
    for (const [over, why] of bad) expect([over, checkFacts({ ...FACTS, ...over }, WHO)]).toEqual([over, { refused: why }]);
    expect(checkFacts("x", WHO)).toEqual({ refused: "the facts are not an object" });
  });

  it("the uid and the home are root's own lookup, never the ones of the facts", () => {
    const f = checkFacts({ ...FACTS, uid: 0, home: "/" }, WHO) as StrongFacts;
    expect([f.uid, f.home]).toEqual([1000, "/home/choibot"]);
    // The facts say 1000; root's lookup says 0: refused as a console that runs as root.
    expect(strongRefusal(checkFacts(FACTS, { ...WHO, uid: 0 }) as StrongFacts)).toMatch(/not as root/);
  });

  it("root's lookup reads getent, and takes only a plain line of that user", () => {
    const ex = (out: string, code = 0): Exec => () => ({ code, out });
    expect(lookupUser("choibot", ex("choibot:x:1000:1000:,,,:/home/choibot:/bin/bash\n"))).toEqual(WHO);
    expect(lookupUser("choibot", ex("", 2))).toBeNull();
    expect(lookupUser("choibot", ex("mallory:x:1000:1000::/home/m:/bin/sh"))).toBeNull();
    expect(lookupUser("choibot", ex("choibot:x:1000:1000::/home/../root:/bin/sh"))).toBeNull();
  });

  it("a path is plain: absolute, normal, no part . or .., plain characters", () => {
    for (const p of ["/opt/choibot/app", "/home/choibot/.local/share/choibot", "/a/b-c_d.e"]) expect([p, okPath(p)]).toEqual([p, true]);
    for (const p of ["/", "a/b", "/a/../b", "/a/./b", "/a/", "/a//b", "/a b", "/a\nb", "/a'b", "/a$b", ""]) expect([p, okPath(p)]).toEqual([p, false]);
  });
});

describe("the plan of strong-setup", () => {
  it("has its names from the new names of the product", () => {
    expect(O).toMatchObject({ agentUser: "choibot-agent", group: "choibot-shared", homesRoot: "/srv/choibot/agent-homes", dtachDir: "/run/choibot-dtach", toolsDir: "/usr/local/lib/choibot" });
  });

  it("refuses an old install, a console that runs as root, code or a workspace in the home, and a server with no Claude Code", () => {
    expect(strongRefusal({ ...FACTS, legacy: true })).toMatch(/old install/);
    expect(strongRefusal({ ...FACTS, uid: 0, user: "root" })).toMatch(/not as root/);
    expect(strongRefusal({ ...FACTS, app: "/home/choibot/choibot/app" })).toMatch(/code of ChoiBot .* inside the home of choibot/);
    expect(strongRefusal({ ...FACTS, workspace: "/home/choibot/workspace" })).toMatch(/workspace/);
    expect(strongRefusal({ ...FACTS, widgetsDir: "/home/choibot/w" })).toMatch(/widget folder/);
    expect(strongRefusal({ ...FACTS, claude: null })).toMatch(/Claude Code is not on this server/);
    expect(strongRefusal({ ...FACTS, home: "/home/choibot2" })).toBeNull();
    expect(() => strongPlan({ ...FACTS, legacy: true })).toThrow(/old install/);
    expect(strongRefusal(FACTS)).toBeNull();
  });

  it("root never acts on a path of the console user: each such action runs as that user (a link in a parent folder gives it nothing)", () => {
    const userPaths = [FACTS.home, "/opt/choibot", FACTS.workspace, FACTS.nodeDir, FACTS.claude!, FACTS.gh!, FACTS.dtach!, ...FACTS.privateDirs, ...FACTS.privateFiles];
    const under = (arg: string) => userPaths.some((p) => arg === p || arg.startsWith(`${p}/`));
    for (const r of runsOf()) {
      if (r.as) continue;
      // A copy: the user reads the source (runuser inside), root writes into a root folder.
      if (r.run[0] === "sh" && r.run[2] === 'runuser -u "$1" -- cat -- "$2" > "$3"') { expect(r.run[4]).toBe("choibot"); continue; }
      if (r.run[0] === "bash" && r.run[2]?.startsWith('set -o pipefail; runuser -u "$1" -- tar -C "$2" -cf - . |')) { expect(r.run[4]).toBe("choibot"); continue; }
      // The restart reads the settings file's time as the user (runuser … stat, which follows no link).
      if (r.run[2] === RESTART_STEP) { expect(RESTART_STEP).toContain('runuser -u "$2" -- stat -c %Y -- "$6"'); expect(r.run[5]).toBe("choibot"); continue; }
      expect([r.run, r.run.filter(under)]).toEqual([r.run, []]);
    }
    // The agent's own folders: the agent account acts on them.
    expect(has(["chmod", "0700", "/home/choibot-agent"], "choibot-agent")).toBe(true);
    expect(has(["install", "-d", "-m", "0700", "/home/choibot-agent/.claude"], "choibot-agent")).toBe(true);
  });

  it("starts with the check that the server is new, unless the person accepts a used one", () => {
    const first = strongPlan(FACTS)[0];
    expect(first.id).toBe("fresh");
    expect(first.actions).toEqual([{
      run: ["sh", "-c", expect.stringContaining('ls -A -- "$d"'), "sh", "/opt/choibot/app/.agent-data", "/home/choibot/.claude/projects"],
      as: "choibot", fail: expect.stringContaining("--accept-used-server"),
    }]);
    expect(strongPlan(FACTS, { ...O, acceptUsed: true }).some((s) => s.id === "fresh")).toBe(false);
  });

  it("makes the agent account with no group of root's rights, and the shared group with both accounts in it; each only once", () => {
    expect(action("accounts", (a) => "run" in a && a.run[0] === "groupadd")).toEqual({ run: ["groupadd", "--system", "choibot-shared"], unless: ["getent", "group", "choibot-shared"] });
    expect(action("accounts", (a) => "run" in a && a.run[0] === "useradd")).toEqual({
      run: ["useradd", "--create-home", "--home-dir", "/home/choibot-agent", "--shell", "/bin/bash", "--user-group", "choibot-agent"], unless: ["id", "-u", "choibot-agent"],
    });
    expect(has(["usermod", "-aG", "choibot-shared", "choibot-agent"])).toBe(true);
    expect(has(["usermod", "-aG", "choibot-shared", "choibot"])).toBe(true);
    for (const r of runsOf().filter((r) => r.run[0] === "usermod" || r.run[0] === "useradd")) expect(r.run.join(" ")).not.toMatch(/\b(sudo|admin|wheel|root)\b/);
  });

  it("the tools: the user reads each source, root writes it in its own folder; the Node copy loses setuid bits and refuses device files", () => {
    for (const [src, name] of [[FACTS.claude!, "claude"], [FACTS.dtach!, "dtach"], [FACTS.gh!, "gh"]]) {
      const dest = `/usr/local/lib/choibot/bin/${name}`;
      expect(has(["sh", "-c", 'runuser -u "$1" -- cat -- "$2" > "$3"', "sh", "choibot", src, `${dest}.new`])).toBe(true);
      expect(has(["chown", "root:root", `${dest}.new`])).toBe(true);
      expect(has(["mv", "-f", `${dest}.new`, dest])).toBe(true);
    }
    // The Node folder: root's folder (0700) first, then the user's tar stream that root extracts.
    const r = runsOf().map((x) => `${x.as ?? "root"}: ${x.run.join(" ")}`);
    const tar = "root: bash -c set -o pipefail; runuser -u \"$1\" -- tar -C \"$2\" -cf - . | tar -C \"$3\" -xf - --no-same-owner --no-same-permissions bash choibot /opt/choibot/node /usr/local/lib/choibot/node.new";
    expect(r.indexOf("root: install -d -o root -g root -m 0700 /usr/local/lib/choibot/node.new")).toBeLessThan(r.indexOf(tar));
    expect(r.indexOf(tar)).toBeGreaterThan(-1);
    expect(r.some((x) => x.startsWith("choibot: ") && x.includes("node.new"))).toBe(false);
    expect(has(["chmod", "-R", "u-s,g-s,go-w", "/usr/local/lib/choibot/node.new"])).toBe(true);
    const find = runsOf().find((r) => r.run[2]?.includes("-perm /6000"))!;
    expect(find.run.slice(3)).toEqual(["sh", "/usr/local/lib/choibot/node.new"]);
    expect(find.run[2]).toContain("-type b -o -type c -o -type p -o -type s");
    expect(runsOf(strongPlan({ ...FACTS, gh: null })).some((r) => r.run.includes("/usr/local/lib/choibot/bin/gh.new"))).toBe(false);
  });

  it("closes the console's data and settings to every other account; the user does it", () => {
    for (const d of FACTS.privateDirs) expect(has(["chmod", "0700", d], "choibot")).toBe(true);
    expect(has(["test", "-O", "/opt/choibot/app/.env"], "choibot")).toBe(true);
    expect(has(["chmod", "0600", "/opt/choibot/app/.env"], "choibot")).toBe(true);
    expect(has(["chmod", "0600", "/opt/choibot/install.log"], "choibot")).toBe(true);
  });

  it("the shared folders: root's parent first, then the homes; the user sets its own widget folder and workspace", () => {
    const r = runsOf().map((x) => `${x.as ?? "root"}: ${x.run.join(" ")}`);
    const at = (s: string) => { const i = r.indexOf(s); expect(i, s).toBeGreaterThan(-1); return i; };
    expect(at("root: chown root:root /srv/choibot")).toBeLessThan(at("root: test ! -L /srv/choibot/agent-homes"));
    expect(at("root: test ! -L /srv/choibot/agent-homes")).toBeLessThan(at("root: install -d -o root -g choibot-shared -m 3770 /srv/choibot/agent-homes"));
    at("root: chmod 3770 /srv/choibot/agent-homes");
    // Design B: the agents' clones (root's, sticky) and the console's uploads and hook settings,
    // after the homes' folder is root's and sticky; made with ensureSharedDir, never by a path command.
    const shared = strongPlan(FACTS).find((x) => x.id === "shared")!.actions;
    const homesAt = shared.findIndex((a) => "run" in a && a.run.join(" ") === "chmod 3770 /srv/choibot/agent-homes");
    const dirs = shared.map((a, i) => ({ a, i })).filter((x) => "dir" in x.a);
    expect(dirs.map((x) => x.a)).toEqual([
      { dir: "/srv/choibot/agent-homes/clones", owner: "root", group: "choibot-shared", mode: 0o3770 },
      { dir: "/srv/choibot/agent-homes/uploads", owner: "choibot", group: "choibot-shared", mode: 0o2750 },
      { dir: "/srv/choibot/agent-homes/settings", owner: "choibot", group: "choibot-shared", mode: 0o2750 },
      // The second account's homes: root's, its group, 3770 (the workers cannot enter it).
      { dir: "/srv/choibot/agent-homes/chief", owner: "root", group: "choibot-chief", mode: 0o3770 },
    ]);
    for (const x of dirs) expect(x.i).toBeGreaterThan(homesAt);
    // Its socket folder: the tmpfiles line (each boot) AND made now.
    expect(shared.filter((a) => "write" in a)[1]).toEqual({ write: "/etc/tmpfiles.d/choibot-dtach-chief.conf", text: "d /run/choibot-dtach-chief 3770 choibot choibot-chief -\n", mode: 0o644, owner: "root", group: "root" });
    at("root: systemd-tmpfiles --create /etc/tmpfiles.d/choibot-dtach-chief.conf");
    expect(r.filter((l) => /agent-homes\/(clones|uploads|settings)/.test(l))).toEqual([]);
    expect(action("shared", (a) => "write" in a)).toEqual({ write: "/etc/tmpfiles.d/choibot-dtach.conf", text: "d /run/choibot-dtach 3770 choibot choibot-shared -\n", mode: 0o644, owner: "root", group: "root" });
    at("choibot: setfacl -R -m g:choibot-shared:rwX -m d:g:choibot-shared:rwX /opt/choibot/app/.widgets-data");
    at("choibot: chgrp choibot-shared /srv/choibot/workspace");
    at("choibot: chmod 2750 /srv/choibot/workspace");
  });

  it("installs the helper (read by the user), its config with the values of the settings, and a sudoers file that visudo checks", () => {
    expect(has(["sh", "-c", 'runuser -u "$1" -- cat -- "$2" > "$3"', "sh", "choibot", "/opt/choibot/app/deploy/choibot-agent-exec", "/usr/local/bin/choibot-agent-exec.new"])).toBe(true);
    const conf = action("helper", (a) => "write" in a && a.write === "/etc/choibot-agent-exec.conf") as Extract<Action, { write: string }>;
    expect(conf).toMatchObject({ mode: 0o644, owner: "root", group: "root" });
    const env = (action("settings", (a) => "env" in a) as Extract<Action, { env: Record<string, string> }>).env;
    expect(Object.fromEntries([...parseEnv(conf.text)])).toEqual({
      DTACH_DIR: env.AGENT_DTACH_DIR, DTACH_BIN: env.AGENT_DTACH_BIN, WORKTREE_ROOT: "/srv/choibot/workspace", WORKSPACE_DIR: "/srv/choibot/workspace",
      AGENT_HOME_ROOT: env.AGENT_HOME_ROOT, AGENT_PATH: "/usr/local/lib/choibot/bin:/usr/local/lib/choibot/node/bin:/usr/local/bin:/usr/bin:/bin",
      AGENT_UID: AGENT_UID_MARK, CHIEF_UID: CHIEF_UID_MARK, CHIEF_DTACH_DIR: env.AGENT_CHIEF_DTACH_DIR,
    });
    expect(Object.fromEntries([...parseEnv(helperConfText({ ...FACTS, worktreeRoot: "/srv/wt" }, O))]).WORKTREE_ROOT).toBe("/srv/wt");
    const sudo = action("helper", (a) => "write" in a && a.write === "/etc/sudoers.d/choibot-agent-exec") as Extract<Action, { write: string }>;
    expect(sudo).toMatchObject({ mode: 0o440, owner: "root", group: "root", check: ["visudo", "-cf"] });
    expect(sudo.text).toContain("choibot ALL=(choibot-agent) NOPASSWD: /usr/local/bin/choibot-agent-exec\n");
    expect(sudo.text).toContain("choibot ALL=(choibot-chief) NOPASSWD: /usr/local/bin/choibot-agent-exec\n");
    // Nothing else may run as either account, and no other account is named.
    expect(sudo.text.split("\n").filter((l) => / ALL=\(/.test(l))).toEqual([
      "choibot ALL=(choibot-agent) NOPASSWD: /usr/local/bin/choibot-agent-exec", "choibot ALL=(choibot-chief) NOPASSWD: /usr/local/bin/choibot-agent-exec",
    ]);
  });

  it("the sudoers env_keep list is the one of the example file: every key the console sends, no secret", () => {
    const keep = /env_keep \+= "([^"]+)"/.exec(sudoersText("choibot", O))![1].split(" ");
    const example = /env_keep \+= "([^"]+)"/.exec(readFileSync(join(__dirname, "../../deploy/choibot-agent-exec.sudoers.example"), "utf8"))![1].split(" ");
    expect(new Set(keep)).toEqual(new Set(example));
    for (const k of SUDO_ENV_KEEP) expect(keep).toContain(k);
    expect(keep.join(" ")).not.toMatch(/TOKEN|SECRET|COOKIE|EXEC_CONF/);
  });

  it("writes the console's settings for strong mode as the console user, with the agent's uid filled in when it runs", () => {
    expect(action("settings", (x) => "env" in x)).toEqual({
      env: {
        CHIEF_AGENT_UID: AGENT_UID_MARK, AGENT_HOME_ROOT: "/srv/choibot/agent-homes", AGENT_CLAUDE_CONFIG_DIR: "/home/choibot-agent/.claude",
        AGENT_DTACH_DIR: "/run/choibot-dtach", AGENT_DTACH_BIN: "/usr/local/lib/choibot/bin/dtach", CLAUDE_CODE_EXECUTABLE: "/usr/local/lib/choibot/bin/claude",
        AGENT_EXEC_HELPER: "/usr/local/bin/choibot-agent-exec",
        CHIEF_PERSISTENT_UID: CHIEF_UID_MARK, AGENT_CHIEF_CLAUDE_CONFIG_DIR: "/home/choibot-chief/.claude", AGENT_CHIEF_DTACH_DIR: "/run/choibot-dtach-chief",
      },
      as: "choibot",
    });
  });

  it("sets the agent's git, as the agent, checks hard links first and the helper last", () => {
    const steps = strongPlan(FACTS);
    expect(steps.find((s) => s.id === "agent-git")!.actions.every((a) => "run" in a && a.as === "choibot-agent")).toBe(true);
    expect(steps.at(-1)!.id).toBe("check");
    expect(steps.at(-1)!.actions.slice(0, 2).map((a) => ("run" in a ? [a.as ?? "root", ...a.run] : []))).toEqual([
      ["choibot", "sudo", "-n", "-u", "choibot-agent", "/usr/local/bin/choibot-agent-exec", "probe"],
      ["choibot", "sudo", "-n", "-u", "choibot-chief", "/usr/local/bin/choibot-agent-exec", "probe"],
    ]);
    // Before the copies: hard links are protected.
    expect(steps.find((s) => s.id === "packages")!.actions[0]).toMatchObject({ run: ["sh", "-c", "test \"$(sysctl -n fs.protected_hardlinks)\" = 1"] });
    expect(steps.findIndex((s) => s.id === "packages")).toBeLessThan(steps.findIndex((s) => s.id === "tools"));
  });

  it("the folders it makes pass the strong check of the console (check 1 of hardened.ts)", () => {
    const modes: Record<string, { uid: number; mode: number }> = {
      "/home/choibot/.local/share/choibot/chief": { uid: 1000, mode: 0o40700 }, "/home/choibot/.local/share/choibot/cron": { uid: 1000, mode: 0o40700 },
      "/opt/choibot/app/.env": { uid: 1000, mode: 0o100600 }, "/srv/choibot/agent-homes": { uid: 0, mode: 0o43770 },
    };
    const fs: HardenedFs = {
      ownerUid: (p) => modes[p].uid, linkOwnerUid: (p) => modes[p].uid, mode: (p) => modes[p].mode,
      readdir: () => [], readFile: () => { throw Object.assign(new Error("x"), { code: "ENOENT" }); }, readlink: () => "",
    };
    const r = checkHardened({
      dataDir: "/home/choibot/.local/share/choibot/chief", cronDir: "/home/choibot/.local/share/choibot/cron", envFile: "/opt/choibot/app/.env",
      homeRoot: O.homesRoot, selfUid: 1000, agentUid: 1001, dtachDir: O.dtachDir, procRoot: "/proc-none", agentExec: true, codeRouteGate: true, fs,
    });
    expect(r.reasons).toEqual([]);
    expect(r.strong).toBe(true);
  });
});

describe("the dry run", () => {
  it("prints every step and every command with the account it runs as, and changes nothing", () => {
    const text = planText(strongPlan(FACTS));
    for (const id of ["fresh", "packages", "accounts", "tools", "private", "shared", "helper", "agent-git", "settings", "check"]) expect(text).toContain(`# ${id}: `);
    expect(text).toContain("id -u choibot-agent >/dev/null 2>&1 || useradd --create-home");
    expect(text).toContain("runuser -u choibot -- chmod 0600 /opt/choibot/app/.env");
    expect(text).toContain("runuser -u choibot-agent -- git config --global --replace-all safe.directory '*'");
    expect(text).toContain("write /etc/sudoers.d/choibot-agent-exec (root:root 0440, checked by visudo -cf):");
    expect(text).toContain(`settings, as choibot: CHIEF_AGENT_UID=${AGENT_UID_MARK}`);
  });

  it("from the command: a file of facts for the dry run only; a run that is not root is refused; a user name with a newline is refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "strong-"));
    const noExec: Exec = () => ({ code: 2, out: "" });   // no account choibot here
    try {
      writeFileSync(join(dir, "facts.json"), JSON.stringify(FACTS));
      const out: string[] = [];
      const err: string[] = [];
      const cmd = (o: object) => runStrongSetup({ repoDir: dir, factsFile: join(dir, "facts.json"), user: "choibot", isRoot: false, exec: noExec, out: (s) => out.push(s), err: (s) => err.push(s), ...o });
      expect(await cmd({ dryRun: true })).toBe(0);
      expect(out.join("\n")).toContain("# accounts: ");
      expect(out[0]).toMatch(/no account choibot here/);
      expect(await cmd({})).toBe(2);
      expect(err.at(-1)).toMatch(/for the dry run only/);
      expect(await cmd({ factsFile: undefined })).toBe(1);
      expect(err.at(-1)).toMatch(/run it as root/);
      expect(await cmd({ dryRun: true, user: "choibot\nALL" })).toBe(2);
      expect(err.at(-1)).toMatch(/not a user name/);
      writeFileSync(join(dir, "facts.json"), JSON.stringify({ ...FACTS, legacy: true }));
      expect(await cmd({ dryRun: true })).toBe(1);
      expect(err.at(-1)).toMatch(/old install/);
      writeFileSync(join(dir, "facts.json"), JSON.stringify({ ...FACTS, app: "/opt/choibot/../etc" }));
      expect(await cmd({ dryRun: true })).toBe(1);
      expect(err.at(-1)).toBe("✖ The facts are refused: app.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("root reads the facts as the console user", () => {
  const getent = "choibot:x:1000:1000:,,,:/home/choibot:/bin/bash\n";
  it("runs the same command with --print-facts as that user, from the checkout, with a clean env and root's home of that user", async () => {
    const seen: { argv: string[]; as?: string }[] = [];
    const exec: Exec = (argv, x = {}) => { seen.push({ argv, as: x.as }); return { code: 0, out: argv[0] === "getent" ? getent : JSON.stringify({ ...FACTS, uid: 0, home: "/" }) }; };
    const out: string[] = [];
    expect(await runStrongSetup({ repoDir: "/opt/choibot/app", user: "choibot", dryRun: true, isRoot: true, exec, out: (t) => out.push(t), err: () => {} })).toBe(0);
    expect(seen[0].argv).toEqual(["getent", "passwd", "choibot"]);
    expect(seen[1].as).toBe("choibot");
    expect(seen[1].argv[2]).toContain("node_modules/.bin/tsx bin/choibot.ts strong-setup --print-facts");
    expect(seen[1].argv.slice(4, 6)).toEqual(["/opt/choibot/app", "/home/choibot"]);
    // The facts said uid 0 and home "/": the plan has root's own lookup (1000 is not root: no refusal).
    expect(out.join("\n")).toContain("# accounts: ");
  });
  it("facts of another user than asked are refused", async () => {
    const exec: Exec = (argv) => ({ code: 0, out: argv[0] === "getent" ? getent : JSON.stringify({ ...FACTS, user: "mallory" }) });
    const err: string[] = [];
    expect(await runStrongSetup({ repoDir: "/opt/choibot/app", user: "choibot", dryRun: true, isRoot: true, exec, out: () => {}, err: (t) => err.push(t) })).toBe(1);
    expect(err[0]).toBe("✖ The facts are refused: user: the facts are of another user than choibot.");
  });
});

describe("ensureSharedDir: a folder in the homes' folder, never through a link", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "strong-dir-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const me = { uid: process.getuid!(), gid: process.getgid!() };
  const a = (name: string, mode = 0o2750): DirAction => ({ dir: join(dir, name), owner: "choibot", group: "choibot-shared", mode });

  it("makes a new folder with one mkdir, then its owner and mode on the open folder", () => {
    expect(ensureSharedDir(a("uploads"), me)).toBeNull();
    const st = lstatSync(join(dir, "uploads"));
    expect([st.isDirectory(), st.uid, st.mode & 0o7777]).toEqual([true, me.uid, 0o2750]);
  });

  it("takes an entry that is there only when it is a real folder of root or of the owner to be", () => {
    mkdirSync(join(dir, "settings"), { mode: 0o755 });
    expect(ensureSharedDir(a("settings"), me)).toBeNull();
    expect(lstatSync(join(dir, "settings")).mode & 0o7777).toBe(0o2750);
    // A folder of another account (an agent made it first): refused, nothing changed.
    mkdirSync(join(dir, "clones"), { mode: 0o755 });
    expect(ensureSharedDir({ ...a("clones", 0o3770), owner: "root" }, { uid: me.uid + 1, gid: me.gid })).toMatch(/is there, and it is not a real folder of root\. /);
    expect(lstatSync(join(dir, "clones")).mode & 0o7777).toBe(0o755);
  });

  it("refuses a link (its target keeps its mode) and a file", () => {
    const target = join(dir, "target");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, join(dir, "uploads"));
    expect(ensureSharedDir(a("uploads"), me)).toMatch(/is there, and it is not a real folder of root or choibot/);
    expect(lstatSync(target).mode & 0o7777).toBe(0o700);
    writeFileSync(join(dir, "settings"), "x");
    expect(ensureSharedDir(a("settings"), me)).toMatch(/not a real folder/);
  });
});

describe("the run, with a fake exec", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "strong-")); folders.length = 0; });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const facts = (): StrongFacts => ({ ...FACTS, envFile: join(dir, ".env") });
  // The folders of the homes' folder: a fake (the real one is root's; ensureSharedDir below).
  const folders: string[] = [];
  const folder = (a: DirAction) => { folders.push(a.dir); return null; };
  // A server: the settings file is read and written by the user through this fake.
  function fakeExec(o: { fail?: string; there?: string[] } = {}): { exec: Exec; calls: string[] } {
    const calls: string[] = [];
    const exec: Exec = (argv, x = {}) => {
      const l = `${x.as ? `[${x.as}] ` : ""}${argv.join(" ")}`;
      calls.push(l);
      if (o.there?.some((t) => l.startsWith(t))) return { code: 0, out: "" };
      if (o.fail && l.startsWith(o.fail)) return { code: 1, out: "it failed here" };
      if (argv[0] === "id" && argv[1] === "-u") {
        const made = (u: string) => calls.some((c) => c.startsWith("useradd") && c.endsWith(` ${u}`));
        if (argv[2] === "choibot-agent" && made("choibot-agent")) return { code: 0, out: "1001\n" };
        if (argv[2] === "choibot-chief" && made("choibot-chief")) return { code: 0, out: "1002\n" };
        return { code: 1, out: "no such user" };
      }
      if (argv[0] === "getent" || (argv[0] === "sh" && argv[2]?.startsWith("command -v"))) return { code: 1, out: "" };
      if (argv[0] === "cat" && x.as && argv[2] === join(dir, ".env")) return { code: 0, out: readFileSync(argv[2], "utf8") };
      if (argv[0] === "sh" && argv[2]?.startsWith("umask 077") && x.as) { writeFileSync(argv[4], x.input ?? ""); return { code: 0, out: "" }; }
      return { code: 0, out: "" };
    };
    return { exec, calls };
  }

  it("runs each step in order, fills in the agent's uid, keeps the other settings; the user reads and writes its settings file", () => {
    writeFileSync(join(dir, ".env"), "PORT=3100\nCHIEF_ENABLED=1\nCHIEF_USER_AUTH=log\n");
    const { exec, calls } = fakeExec();
    const written: Record<string, string> = {};
    const log: string[] = [];
    expect(applyPlan(strongPlan(facts()), { exec, dir: folder, envFile: join(dir, ".env"), writeFile: (p, t) => { written[p] = t; }, log: (s) => log.push(s) })).toBe(0);
    const env = Object.fromEntries(parseEnv(readFileSync(join(dir, ".env"), "utf8")));
    expect(env).toMatchObject({
      PORT: "3100", CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_AGENT_UID: "1001", AGENT_CLAUDE_CONFIG_DIR: "/home/choibot-agent/.claude",
      CHIEF_PERSISTENT_UID: "1002", AGENT_CHIEF_CLAUDE_CONFIG_DIR: "/home/choibot-chief/.claude", AGENT_CHIEF_DTACH_DIR: "/run/choibot-dtach-chief",
    });
    // The marks in the helper's config are the uids now.
    expect(Object.fromEntries(parseEnv(written["/etc/choibot-agent-exec.conf.tmp-strong"]))).toMatchObject({ AGENT_UID: "1001", CHIEF_UID: "1002", CHIEF_DTACH_DIR: "/run/choibot-dtach-chief" });
    expect(Object.values(written).join("")).not.toContain("<uid of");
    expect(calls).toContain(`[choibot] cat -- ${join(dir, ".env")}`);
    expect(calls.some((c) => c.startsWith(`[choibot] sh -c umask 077 && cat > "$1.strong-new"`))).toBe(true);
    const at = (s: string) => calls.indexOf(s);
    expect(at("visudo -cf /etc/sudoers.d/choibot-agent-exec.tmp-strong")).toBeGreaterThan(-1);
    expect(at("visudo -cf /etc/sudoers.d/choibot-agent-exec.tmp-strong")).toBeLessThan(at("mv -f /etc/sudoers.d/choibot-agent-exec.tmp-strong /etc/sudoers.d/choibot-agent-exec"));
    expect(calls).toContain("chmod 440 /etc/sudoers.d/choibot-agent-exec.tmp-strong");
    expect(written["/etc/sudoers.d/choibot-agent-exec.tmp-strong"]).toContain("NOPASSWD: /usr/local/bin/choibot-agent-exec");
    // A link as a tool source: the read runs as the user (runuser inside the command).
    expect(calls).toContain(`sh -c runuser -u "$1" -- cat -- "$2" > "$3" sh choibot ${FACTS.claude} /usr/local/lib/choibot/bin/claude.new`);
    expect(folders).toEqual(["clones", "uploads", "settings", "chief"].map((f) => `/srv/choibot/agent-homes/${f}`));
    expect(calls).toContain("[choibot] sudo -n -u choibot-chief /usr/local/bin/choibot-agent-exec probe");
    // The restart, then the check of the state after it; the console's group is the last check.
    expect(calls.findIndex((c) => c.includes('systemctl restart "user@$1.service"'))).toBeLessThan(calls.indexOf("[choibot] sudo -n -u choibot-agent /usr/local/bin/choibot-agent-exec probe"));
    expect(calls.at(-1)).toMatch(/^sh -c systemctl is-active --quiet "user@\$1\.service" \|\|.* sh 1000 choibot\.service choibot-chief \/sys\/fs\/cgroup \/proc$/s);
    expect(log.at(-1)).toMatch(/^✔ Strong protection is set up/);
  });

  it("a second run with nothing changed: no restart, no settings write; a run that adds a group to the console user: a restart", () => {
    writeFileSync(join(dir, ".env"), "PORT=3100\n");
    const restartArg = (calls: string[]) => {
      const c = calls.find((x) => x.startsWith("sh -c if ! systemctl is-active --quiet"));
      return c?.match(/ sh 1000 choibot ([01]) choibot-chief \/proc \S+\/\.env choibot\.service \/sys\/fs\/cgroup$/)?.[1];
    };
    // The first run: the settings change, so the restart step gets "1".
    const first = fakeExec();
    expect(applyPlan(strongPlan(facts(), { ...O, acceptUsed: true }), { exec: first.exec, dir: folder, envFile: join(dir, ".env"), writeFile: () => {}, log: () => {} })).toBe(0);
    expect(restartArg(first.calls)).toBe("1");
    const after = readFileSync(join(dir, ".env"), "utf8");
    // The second run: the accounts are there, the console user is in both groups, the settings are the same.
    const second = fakeExec({ there: ["getent group choibot-shared", "id -u choibot-agent", "id -u choibot-chief", "sh -c command -v", "sh -c id -nG"] });
    const real: Exec = (argv, x) => (argv[0] === "id" && argv[1] === "-u" ? { code: 0, out: argv[2] === "choibot-chief" ? "1002\n" : "1001\n" } : second.exec(argv, x));
    expect(applyPlan(strongPlan(facts(), { ...O, acceptUsed: true }), { exec: real, dir: folder, envFile: join(dir, ".env"), writeFile: () => {}, log: () => {} })).toBe(0);
    expect(restartArg(second.calls)).toBe("0");
    expect(second.calls.some((c) => c.includes("umask 077"))).toBe(false);
    // The console user's groups are not added again (the other accounts' lines change nothing for its process).
    expect(second.calls.filter((c) => /^usermod -aG \S+ choibot$/.test(c))).toEqual([]);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(after);
    // A run where only the console user's group is new: "1".
    const third = fakeExec({ there: ["getent group choibot-shared", "id -u choibot-agent", "id -u choibot-chief", "sh -c command -v"] });
    const fake3: Exec = (argv, x) => {
      if (argv[0] === "sh" && argv[2]?.startsWith("id -nG")) return { code: argv[5] === "choibot-chief" ? 1 : 0, out: "" };
      return argv[0] === "id" && argv[1] === "-u" ? { code: 0, out: argv[2] === "choibot-chief" ? "1002\n" : "1001\n" } : third.exec(argv, x);
    };
    expect(applyPlan(strongPlan(facts(), { ...O, acceptUsed: true }), { exec: fake3, dir: folder, envFile: join(dir, ".env"), writeFile: () => {}, log: () => {} })).toBe(0);
    expect(third.calls.filter((c) => c.startsWith("usermod -aG choibot-chief choibot"))).toHaveLength(1);
    expect(restartArg(third.calls)).toBe("1");
  });

  it("a used server: the first step stops it, in plain words, before any change", () => {
    writeFileSync(join(dir, ".env"), "PORT=3100\n");
    const { exec, calls } = fakeExec({ fail: "[choibot] sh -c for d in" });
    const log: string[] = [];
    expect(applyPlan(strongPlan(facts()), { exec, dir: folder, envFile: join(dir, ".env"), writeFile: () => {}, log: (s) => log.push(s) })).toBe(1);
    expect(log.at(-1)).toMatch(/^✖ fresh: Agents already ran on this server as choibot\. .*--accept-used-server\.\n {4}it failed here$/s);
    expect(calls).toHaveLength(1);
  });

  it("a second run skips what is there (the group, the account, the packages)", () => {
    writeFileSync(join(dir, ".env"), "PORT=3100\n");
    const { exec, calls } = fakeExec({ there: ["getent group choibot-shared", "id -u choibot-agent", "id -u choibot-chief", "sh -c command -v"] });
    const real: Exec = (argv, x) => (argv[0] === "id" && argv[1] === "-u" ? { code: 0, out: argv[2] === "choibot-chief" ? "1002\n" : "1001\n" } : exec(argv, x));
    expect(applyPlan(strongPlan(facts(), { ...O, acceptUsed: true }), { exec: real, dir: folder, envFile: join(dir, ".env"), writeFile: () => {}, log: () => {} })).toBe(0);
    expect(calls.some((c) => c.startsWith("groupadd") || c.startsWith("useradd") || c.startsWith("apt-get"))).toBe(false);
  });

  it("stops at the first failure: names the step and the command, prints its output, and runs nothing after it", () => {
    writeFileSync(join(dir, ".env"), "PORT=3100\n");
    const { exec, calls } = fakeExec({ fail: "visudo -cf" });
    const log: string[] = [];
    expect(applyPlan(strongPlan(facts()), { exec, dir: folder, envFile: join(dir, ".env"), writeFile: () => {}, log: (s) => log.push(s) })).toBe(1);
    expect(log.at(-1)).toMatch(/^✖ helper: visudo -cf \/etc\/sudoers.d\/choibot-agent-exec.tmp-strong\n {4}it failed here$/);
    expect(calls).toContain("rm -f /etc/sudoers.d/choibot-agent-exec.tmp-strong");
    expect(calls.some((c) => c.startsWith("mv -f /etc/sudoers.d/"))).toBe(false);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe("PORT=3100\n");
  });
});

// The second account (server/chief/chiefaccount.ts): the fleet master, the leads and the
// Coordinator run as choibot-chief, which the workers' account cannot enter.
describe("the second account", () => {
  const stepOf = (id: string, steps = strongPlan(FACTS)) => steps.find((s) => s.id === id)!;
  const line = (a: Action) => ("run" in a ? `${a.as ?? "root"}: ${a.run.join(" ")}` : "");

  it("has its names from the new names of the product", () => {
    expect(O).toMatchObject({ chiefUser: "choibot-chief", chiefDtachDir: "/run/choibot-dtach-chief", chiefTmpfiles: "/etc/tmpfiles.d/choibot-dtach-chief.conf" });
  });

  it("its account once, its own group; it reads what the workers read; the console is in its group; its home and Claude folder are its own, 0700", () => {
    const acc = stepOf("accounts").actions;
    const lines = acc.map(line);
    const at = (s: string) => { const i = lines.indexOf(s); expect(i, s).toBeGreaterThan(-1); return i; };
    expect(acc[at("root: useradd --create-home --home-dir /home/choibot-chief --shell /bin/bash --user-group choibot-chief")]).toMatchObject({ unless: ["id", "-u", "choibot-chief"] });
    at("root: usermod -aG choibot-shared choibot-chief");
    at("root: usermod -aG choibot-chief choibot");
    at("choibot-chief: chmod 0700 /home/choibot-chief");
    at("choibot-chief: install -d -m 0700 /home/choibot-chief/.claude");
    // Never: the workers' account in its group, or the second account in the console's group.
    expect(lines.filter((l) => /usermod -aG choibot-chief choibot-agent|usermod -aG choibot choibot-chief/.test(l))).toEqual([]);
  });

  it("two checks fail the step with the reason: the workers' account in its group, and it in the console's group", () => {
    const acc = stepOf("accounts").actions.filter((a): a is Extract<Action, { run: string[] }> => "run" in a && a.run[0] === "sh");
    expect(acc.map((a) => a.fail)).toEqual([
      expect.stringMatching(/^choibot-agent is in the group choibot-chief: a worker could read the tokens .*gpasswd -d choibot-agent choibot-chief/),
      expect.stringMatching(/^choibot-chief is in the group of choibot: it could read the console's own files/),
    ]);
    // The shell of each, run for real on this machine's own accounts: a member is found, a stranger not.
    const me = execFileSync("id", ["-un"], { encoding: "utf8" }).trim();
    const myGroup = execFileSync("id", ["-gn"], { encoding: "utf8" }).trim();
    const sh = (a: { run: string[] }, args: string[]) => spawnSync(a.run[0], [a.run[1], a.run[2], "sh", ...args]).status;
    expect(sh(acc[0], [me, myGroup])).toBe(1);
    expect(sh(acc[0], [me, "no-such-group-x"])).toBe(0);
    expect(sh(acc[1], [me, me])).toBe(1);
  });

  it("its git: no clean-up; of safe.directory only its own homes' agent folders stay (the console names them one by one); never \"*\"", () => {
    const g = stepOf("chief-git").actions;
    expect(g.every((a) => "run" in a && a.as === "choibot-chief")).toBe(true);
    expect(g.map(line)).toEqual([
      "choibot-chief: git config --global gc.auto 0",
      "choibot-chief: git config --global maintenance.auto false",
      `choibot-chief: sh -c ${CHIEF_SAFE_PRUNE} sh /srv/choibot/agent-homes/chief`,
    ]);
    expect(all().some((a) => "run" in a && a.as === "choibot-chief" && a.run.includes("safe.directory") && a.run.includes("*"))).toBe(false);
  });

  it("the restart comes after the settings, before the check; its text says first that every agent that runs stops", () => {
    const ids = strongPlan(FACTS).map((s) => s.id);
    expect(ids.slice(-3)).toEqual(["settings", "restart", "check"]);
    const step = stepOf("restart");
    expect(step.why).toMatch(/ONLY when this run changed its settings or the groups of choibot, when the user manager of choibot lacks the group choibot-chief .*, when the console does not run, or when the settings file is newer than the console's process.*before it starts again every agent that runs stops/);
    expect(step.actions[0]).toMatchObject({ say: true, run: ["sh", "-c", RESTART_STEP, "sh", "1000", "choibot", CHANGED_MARK, "choibot-chief", "/proc", "/opt/choibot/app/.env", "choibot.service", "/sys/fs/cgroup"] });
    // The console user's groups: added only when it is not in them yet, and that counts as a change.
    const acc = stepOf("accounts").actions.filter((a): a is Extract<Action, { run: string[] }> => "run" in a && a.run[0] === "usermod" && a.run.at(-1) === "choibot");
    expect(acc.map((a) => [a.run.join(" "), a.changes, a.unless?.slice(-2)])).toEqual([
      ["usermod -aG choibot-shared choibot", true, ["choibot", "choibot-shared"]],
      ["usermod -aG choibot-chief choibot", true, ["choibot", "choibot-chief"]],
    ]);
  });

  it("the restart's shell (stubs): a change, a missing group, no console, settings newer than the console: a restart; else none; no manager: none", () => {
    const t = mkdtempSync(join(tmpdir(), "strong-rs-"));
    try {
      const bin = join(t, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "systemctl"), [
        "#!/bin/sh",
        'case "$1" in is-active) [ "$ACTIVE" = 1 ]; exit $? ;; restart) echo "restart $2" >> "$LOG"; exit 0 ;; esac',
        'case "$3" in MainPID) echo 77 ;; ControlGroup) echo /user.slice/u ;; esac', "",
      ].join("\n"), { mode: 0o755 });
      writeFileSync(join(bin, "getent"), '#!/bin/sh\necho "choibot-chief:x:1002:"\n', { mode: 0o755 });
      // ps -o etimes= -p <pid>: the console's age in seconds; runuser -u <who> -- <cmd…>: as this user.
      writeFileSync(join(bin, "ps"), '#!/bin/sh\necho "  $AGE"\n', { mode: 0o755 });
      writeFileSync(join(bin, "runuser"), '#!/bin/sh\nshift 3\nexec "$@"\n', { mode: 0o755 });
      mkdirSync(join(t, "proc", "77"), { recursive: true });
      const unit = join(t, "cg", "user.slice", "u", "app.slice", "choibot.service");
      mkdirSync(unit, { recursive: true });
      const env = join(t, ".env");
      writeFileSync(env, "PORT=3100\n");
      const run = (o: { changed: "0" | "1"; groups?: string; active?: boolean; procs?: string; age?: number; settingsAgo?: number }) => {
        rmSync(join(t, "log"), { force: true });
        writeFileSync(join(t, "proc", "77", "status"), `Name:\tsystemd\nGroups:\t${o.groups ?? "1000 1001 1002"}\n`);
        writeFileSync(join(unit, "cgroup.procs"), o.procs ?? "4242\n");
        const when = new Date(Date.now() - (o.settingsAgo ?? 3600) * 1000);
        utimesSync(env, when, when);
        const r = spawnSync("sh", ["-c", RESTART_STEP, "sh", "1000", "choibot", o.changed, "choibot-chief", join(t, "proc"), env, "choibot.service", join(t, "cg")], {
          encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin`, ACTIVE: o.active === false ? "0" : "1", LOG: join(t, "log"), AGE: String(o.age ?? 600) } as unknown as NodeJS.ProcessEnv,
        });
        return { code: r.status, out: r.stdout.trim(), restarted: existsSync(join(t, "log")) ? readFileSync(join(t, "log"), "utf8").trim() : "" };
      };
      const NO = "The console already runs with these settings and this group: no restart.";
      // A first run: the change mark.
      expect(run({ changed: "1" })).toEqual({ code: 0, out: "A restart: this run changed the settings or the groups of choibot. Every agent that runs stops now, and the console starts it again.\nThe console of choibot started again.", restarted: "restart user@1000.service" });
      // Nothing changed: the manager has the group, the console runs, its settings are older than it (1 h vs 10 min).
      expect(run({ changed: "0" })).toEqual({ code: 0, out: NO, restarted: "" });
      // An earlier run changed the settings and failed before its restart: the file is newer than the console.
      const newer = run({ changed: "0", settingsAgo: 60, age: 600 });
      expect([newer.out.split("\n")[0], newer.restarted]).toEqual(["A restart: the settings file is newer than the console's process. Every agent that runs stops now, and the console starts it again.", "restart user@1000.service"]);
      // The group missing on the manager (also a gid that only starts like it).
      for (const groups of ["1000 1001", "1000 10020"]) expect(run({ changed: "0", groups }).out).toMatch(/^A restart: the user manager of choibot lacks the group choibot-chief\./);
      // The manager runs, the console does not: the restart starts it.
      expect(run({ changed: "0", procs: "" }).out).toMatch(/^A restart: the console does not run\./);
      // No user manager (an image build): nothing.
      expect(run({ changed: "1", active: false })).toEqual({ code: 0, out: expect.stringMatching(/does not run: its first start/), restarted: "" });
    } finally {
      rmSync(t, { recursive: true, force: true });
    }
  });

  it("the safe.directory prune, run with git: its homes' agent folders stay, every other entry goes; none: nothing", () => {
    const t = mkdtempSync(join(tmpdir(), "strong-git-"));
    try {
      const env = { PATH: "/usr/bin:/bin", HOME: t, GIT_CONFIG_NOSYSTEM: "1" } as unknown as NodeJS.ProcessEnv;
      const git = (...a: string[]) => spawnSync("git", a, { encoding: "utf8", env });
      const H = "/srv/choibot/agent-homes/chief";
      const keep = [`${H}/fleet-master/agent`, `${H}/coordinator/agent`, `${H}/leads/app-shop/agent`];
      const drop = ["*", "/srv/choibot/agent-homes/clones/w1", `${H}/leads/Bad_Area/agent`, `${H}/leads/a/b/agent`, `${H}/leads/-x/agent`, `${H}/other/agent`, `${H}/fleet-master/agent/sub`];
      const prune = () => spawnSync("sh", ["-c", CHIEF_SAFE_PRUNE, "sh", H], { encoding: "utf8", env });
      expect(prune().status).toBe(0);
      for (const v of [...keep, ...drop]) git("config", "--global", "--add", "safe.directory", v);
      const r = prune();
      expect(r.status).toBe(0);
      expect(r.stdout.trim().split("\n")).toEqual(drop.map((v) => `removed the safe.directory entry ${v}`));
      expect(git("config", "--global", "--get-all", "safe.directory").stdout.trim().split("\n")).toEqual(keep);
      // A second run: nothing to remove, nothing said.
      expect(prune().stdout).toBe("");
    } finally {
      rmSync(t, { recursive: true, force: true });
    }
  });

  it("the homes file check (a stub runuser): a new file by mktemp, never through an entry that is there; the reasons", () => {
    const t = mkdtempSync(join(tmpdir(), "strong-hf-"));
    try {
      const bin = join(t, "bin");
      mkdirSync(bin);
      // runuser -u <who> -- <cmd…>: as this test user; "agent" may not read (its cat fails).
      writeFileSync(join(bin, "runuser"), '#!/bin/sh\nwho=$2; shift 3\nif [ "$who" = agent ] && [ "$1" = cat ]; then exit 1; fi\nexec "$@"\n', { mode: 0o755 });
      const homes = join(t, "chief");
      mkdirSync(homes);
      const outside = join(t, "outside.txt");
      writeFileSync(outside, "the console's own file\n");
      // Entries that the second account could plant: at the old fixed name and at a guess.
      symlinkSync(outside, join(homes, ".strong-check"));
      symlinkSync(outside, join(homes, ".strong-check.AAAAAA"));
      const run = () => spawnSync("sh", ["-c", HOMES_FILE_CHECK, "sh", homes, "choibot", "chief", "agent"], { encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin` } as unknown as NodeJS.ProcessEnv });
      const ok = run();
      expect([ok.status, ok.stdout.trim()]).toEqual([0, "A file of choibot in its homes: chief reads it, agent does not."]);
      expect(readFileSync(outside, "utf8")).toBe("the console's own file\n");
      // Its file is gone after; the planted entries are left as they are.
      expect(readdirSync(homes).sort()).toEqual([".strong-check", ".strong-check.AAAAAA"]);
      // A folder where it cannot make an entry (its group missing): the step fails with the reason.
      chmodSync(homes, 0o500);
      const no = run();
      chmodSync(homes, 0o700);
      expect([no.status, no.stdout.trim()]).toEqual([1, `choibot cannot make a file in ${homes}: its group chief is missing`]);
      // The workers' account can read it: the step fails with the reason.
      writeFileSync(join(bin, "runuser"), '#!/bin/sh\nshift 3\nexec "$@"\n', { mode: 0o755 });
      const open = run();
      expect([open.status, open.stdout.trim()]).toEqual([1, "agent can read a file of choibot in the homes of chief"]);
    } finally {
      rmSync(t, { recursive: true, force: true });
    }
  });

  it("the check reads the state after the start: both probes, the folders, a file of the console readable by it and not by the workers, the console's group", () => {
    const c = stepOf("check").actions.map(line);
    expect(c).toEqual([
      "choibot: sudo -n -u choibot-agent /usr/local/bin/choibot-agent-exec probe",
      "choibot: sudo -n -u choibot-chief /usr/local/bin/choibot-agent-exec probe",
      `root: sh -c test ! -L "$1" && test "$(stat -c "%U:%G %a" -- "$1")" = "$2" sh /srv/choibot/agent-homes/chief root:choibot-chief 3770`,
      `root: sh -c test ! -L "$1" && test "$(stat -c "%U:%G %a" -- "$1")" = "$2" sh /run/choibot-dtach-chief choibot:choibot-chief 3770`,
      `root: sh -c ${HOMES_FILE_CHECK} sh /srv/choibot/agent-homes/chief choibot choibot-chief choibot-agent`,
      `root: sh -c ${CONSOLE_GROUP_CHECK} sh 1000 choibot.service choibot-chief /sys/fs/cgroup /proc`,
    ]);
  });

  it("the console's group check, its shell run with a stub systemctl: found, missing, no process, no user manager", () => {
    const t = mkdtempSync(join(tmpdir(), "strong-cg-"));
    try {
      const bin = join(t, "bin");
      mkdirSync(bin);
      // systemctl: the user manager is active ($ACTIVE), its cgroup is /user.slice/u.
      writeFileSync(join(bin, "systemctl"), '#!/bin/sh\nif [ "$1" = is-active ]; then [ "$ACTIVE" = 1 ]; exit $?; fi\necho /user.slice/u\n', { mode: 0o755 });
      writeFileSync(join(bin, "getent"), '#!/bin/sh\necho "choibot-chief:x:1002:"\n', { mode: 0o755 });
      const unit = join(t, "cg", "user.slice", "u", "app.slice", "choibot.service");
      mkdirSync(unit, { recursive: true });
      mkdirSync(join(t, "proc", "4242"), { recursive: true });
      const run = (o: { active?: boolean; groups?: string; procs?: string }) => {
        writeFileSync(join(unit, "cgroup.procs"), o.procs ?? "4242\n");
        writeFileSync(join(t, "proc", "4242", "status"), `Name:\tnode\nGroups:\t${o.groups ?? "1000 1001 1002"}\n`);
        const r = spawnSync("sh", ["-c", CONSOLE_GROUP_CHECK.replace("sleep 1", "sleep 0"), "sh", "1000", "choibot.service", "choibot-chief", join(t, "cg"), join(t, "proc")], {
          encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin`, ACTIVE: o.active === false ? "0" : "1" } as unknown as NodeJS.ProcessEnv,
        });
        return [r.status, r.stdout.trim()];
      };
      expect(run({})).toEqual([0, "The console (pid 4242) has the group choibot-chief."]);
      expect(run({ groups: "1000 1001" })).toEqual([1, "The console (pid 4242) does not have the group choibot-chief (gid 1002)."]);
      expect(run({ groups: "1000 10020" })[0]).toBe(1);
      expect(run({ procs: "" })).toEqual([1, "The console (choibot.service) did not start within 60 seconds."]);
      expect(run({ active: false })).toEqual([0, "The console does not run: its first start gets the group."]);
    } finally {
      rmSync(t, { recursive: true, force: true });
    }
  });
});

describe("the old layout: persistent agents that ran as the workers' account (condition 7)", () => {
  const facts = (persistent: StrongFacts["persistent"]): StrongFacts => ({ ...FACTS, persistent });

  it("a record in AGENT_HOME_ROOT but not in its chief folder, or a home folder of the console there: the plan stops before any step", () => {
    const old = facts([{ id: "fleet-master", cwd: "/srv/choibot/agent-homes/fleet-master/agent" }]);
    expect(() => strongPlan(old)).toThrow(/^The fleet master, a lead or the Coordinator ran on this server as the workers' account \(fleet-master in \/srv\/choibot\/agent-homes\/fleet-master\/agent\)\. .*not built yet.*Nothing was changed\.$/);
    expect(() => strongPlan(FACTS, O, { oldHomes: ["/srv/choibot/agent-homes/leads"] })).toThrow(/the folder \/srv\/choibot\/agent-homes\/leads/);
    // The new layout, and the console's own data folder (basic mode: the console moves it), do not stop it.
    expect(oldLayoutRefusal(facts([{ id: "lead-app", cwd: "/srv/choibot/agent-homes/chief/leads/app/agent" }, { id: "coordinator", cwd: "/home/choibot/.local/share/choibot/coordinator/agent" }]), O, { oldHomes: [] })).toBeNull();
  });

  it("root's look: only real folders of the console user count (an agent can make an entry there; it never stops the set-up)", () => {
    const st = (o: { dir?: boolean; link?: boolean; uid: number }) => ({ isDirectory: () => o.dir ?? true, isSymbolicLink: () => o.link ?? false, uid: o.uid }) as unknown as import("node:fs").Stats;
    const table: Record<string, ReturnType<typeof st>> = {
      "/srv/choibot/agent-homes/fleet-master": st({ uid: 1000 }),
      "/srv/choibot/agent-homes/coordinator": st({ uid: 1001 }),
      "/srv/choibot/agent-homes/leads": st({ uid: 1000, link: true, dir: false }),
    };
    const lstat = (p: string) => { const s = table[p]; if (!s) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return s; };
    expect(findOldHomes(O, 1000, lstat)).toEqual(["/srv/choibot/agent-homes/fleet-master"]);
  });

  it("the dry run shows the stop, and nothing runs", async () => {
    const t = mkdtempSync(join(tmpdir(), "strong-old-"));
    try {
      const file = join(t, "facts.json");
      writeFileSync(file, JSON.stringify({ ...FACTS, persistent: [{ id: "lead-app", cwd: "/srv/choibot/agent-homes/leads/app/agent" }] }));
      const calls: string[] = [];
      const exec: Exec = (argv) => { calls.push(argv.join(" ")); return argv[0] === "getent" ? { code: 0, out: "choibot:x:1000:1000::/home/choibot:/bin/bash\n" } : { code: 1, out: "" }; };
      const out: string[] = [];
      const err: string[] = [];
      expect(await runStrongSetup({ repoDir: "/opt/choibot/app", user: "choibot", dryRun: true, factsFile: file, isRoot: true, exec, out: (s) => out.push(s), err: (s) => err.push(s), findOldHomes: () => [] })).toBe(1);
      expect(err.join("\n")).toMatch(/^✖ The fleet master, a lead or the Coordinator ran on this server as the workers' account \(lead-app in /);
      expect(out).toEqual([]);
      expect(calls).toEqual(["getent passwd choibot"]);
    } finally {
      rmSync(t, { recursive: true, force: true });
    }
  });

  it("the facts: the records of the persistent kinds only, with their cwd; refused in another shape", () => {
    const t = mkdtempSync(join(tmpdir(), "strong-rec-"));
    try {
      writeFileSync(join(t, "fleet-master.json"), JSON.stringify({ id: "fleet-master", cwd: "/srv/choibot/agent-homes/fleet-master/agent" }));
      writeFileSync(join(t, "lead-app.json"), JSON.stringify({ cwd: "/x/lead" }));
      writeFileSync(join(t, "0b9c5a4e-7f1d-4c2a-9e3b-1d2c3b4a5f6e.json"), JSON.stringify({ cwd: "/x/worker" }));
      writeFileSync(join(t, "coordinator.json"), "not json");
      expect(persistentRecords(t)).toEqual([{ id: "fleet-master", cwd: "/srv/choibot/agent-homes/fleet-master/agent" }, { id: "lead-app", cwd: "/x/lead" }]);
      expect(persistentRecords(join(t, "none"))).toEqual([]);
    } finally {
      rmSync(t, { recursive: true, force: true });
    }
    for (const [over, why] of [
      [{ unit: "choibot.service; rm -rf /" }, "unit"], [{ unit: 5 }, "unit"],
      [{ persistent: [{ id: "0b9c5a4e-7f1d-4c2a-9e3b-1d2c3b4a5f6e", cwd: "/x" }] }, "persistent"], [{ persistent: [{ id: "fleet-master", cwd: "../x" }] }, "persistent"],
      [{ persistent: "x" }, "persistent"], [{ persistent: Array.from({ length: 65 }, () => ({ id: "coordinator", cwd: "/x" })) }, "persistent"],
    ] as const) expect([over, checkFacts({ ...FACTS, ...over }, WHO)]).toEqual([over, { refused: why }]);
  });
});
