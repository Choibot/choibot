// server/cron/spool.test.ts — Task 2c-8: in a hardened deployment an agent's
// `choibot cron add|edit|rm|enable|disable|run` is a request in the spool dir;
// the user applies or rejects it in the Cron pane (USER routes) and the
// console writes the spec as its own uid. Every spool file is agent-written
// and so untrusted. No test runs systemd: the cron ctx's run() is a fake.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { chmod, link, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { cronCtx, type CronCtx } from "../../bin/lib/cron.js";
import type { RunResult } from "../../bin/lib/exec.js";
import { AGENT_HEADER, AGENT_TOKEN_HEADER, USER_HEADER, type CallerDeps } from "../chief/auth.js";
import { makeGate } from "../chief/gate.js";
import { EventHub } from "../events.js";
import { registerCronApi } from "./api.js";
import { applySpool, ensureSpoolDir, listSpool, spoolDir, spoolRoutes, type SpoolRequest } from "./spool.js";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
type Env = Record<string, string | undefined>;
const ACTIVE: Env = { CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "http://127.0.0.1:4999" };
const HARD: Env = { ...ACTIVE, CHIEF_AGENT_UID: "1001" };
const NOT_HARD: [string, Env][] = [["flag off", {}], ["no CHIEF_AGENT_UID", ACTIVE], ["invalid uid", { ...ACTIVE, CHIEF_AGENT_UID: "0" }]];

const SPEC = { name: "daily", schedule: "*-*-* 08:00:00", prompt: "summarize the day" };
const OK: RunResult = { code: 0, stdout: "", stderr: "" };
const ID = "1000-0123456789ab";
const ID2 = "2000-ba9876543210";

const tmps: string[] = [];
afterEach(async () => { while (tmps.length) await rm(tmps.pop()!, { recursive: true, force: true }); });
const tmp = async (p: string) => { const d = await mkdtemp(join(tmpdir(), p)); tmps.push(d); return d; };

// A fake host like bin/lib/cron.test.ts: tmp home with the console unit
// present, tmp CRON_DATA_DIR, run() records argvs and never runs systemd.
async function host(onRun?: (cmd: string, args: string[]) => RunResult | undefined, env: Env = {}) {
  const home = await tmp("spool-home-");
  const data = await tmp("spool-data-");
  const unitDir = join(home, ".config", "systemd", "user");
  await mkdir(unitDir, { recursive: true });
  await writeFile(join(unitDir, "choibot.service"), "[Unit]\n");
  const argvs: string[] = [];
  const ctx: CronCtx = cronCtx(REPO, {
    run: async (cmd, args) => { argvs.push([cmd, ...args].join(" ")); return onRun?.(cmd, args) ?? OK; },
    readStdin: async () => { throw new Error("no stdin in the console"); },
    log: () => {},
    now: () => 5_000,
    env: { ...env, CRON_DATA_DIR: data },
    homedir: () => home,
  });
  return { home, data, unitDir, argvs, ctx };
}

// `at` is the id's time prefix, as the CLI writes it.
const req = (o: Partial<SpoolRequest> = {}): SpoolRequest => {
  const id = o.id ?? ID;
  return { id, at: Number(id.split("-")[0]), op: "add", name: "daily", spec: SPEC, by: "cron-master", ...o };
};
async function put(dir: string, body: unknown, file = `${(body as { id?: string }).id}.json`): Promise<string> {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  await writeFile(join(dir, file), text, { mode: 0o660 });
  return text;
}
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe("spoolDir", () => {
  it("is CHOIBOT_CRON_SPOOL when set, else null", () => {
    expect(spoolDir({ CHOIBOT_CRON_SPOOL: "/h/cron-spool" })).toBe("/h/cron-spool");
    expect(spoolDir({})).toBeNull();
    expect(spoolDir({ CHOIBOT_CRON_SPOOL: "" })).toBeNull();
  });
});

describe("listSpool", () => {
  it("lists valid requests oldest first, each with the sha256 of its bytes", async () => {
    const dir = await tmp("spool-");
    const t2 = await put(dir, req({ id: ID2, at: 2_000, op: "rm", spec: undefined }));
    const t1 = await put(dir, req());
    const got = await listSpool(dir);
    expect(got.map((r) => r.id)).toEqual([ID, ID2]);
    expect(got[0]).toEqual({ ...req(), sha256: sha(t1) });
    expect(got[1]).toEqual({ id: ID2, at: 2_000, op: "rm", name: "daily", by: "cron-master", sha256: sha(t2) });
  });

  it("skips and logs anything else: bad names, symlinks, hard links, FIFOs, oversize, bad JSON, schema misses", async () => {
    const dir = await tmp("spool-");
    const outside = await tmp("spool-outside-");
    const good = await put(dir, req());
    await writeFile(join(outside, "secret.json"), JSON.stringify(req({ id: "3000-aaaaaaaaaaaa" })));
    await symlink(join(outside, "secret.json"), join(dir, "3000-aaaaaaaaaaaa.json"));
    await writeFile(join(outside, "linked.json"), JSON.stringify(req({ id: "3001-aaaaaaaaaaaa" })));
    await link(join(outside, "linked.json"), join(dir, "3001-aaaaaaaaaaaa.json"));
    execFileSync("mkfifo", [join(dir, "3002-aaaaaaaaaaaa.json")]);
    await put(dir, req({ id: "3003-aaaaaaaaaaaa", spec: { ...SPEC, prompt: "x".repeat(70_000) } }));
    await put(dir, "{ torn", "3004-aaaaaaaaaaaa.json");
    await put(dir, req({ id: "3005-aaaaaaaaaaaa", op: "exec" as SpoolRequest["op"] }));
    await put(dir, req({ id: "3006-aaaaaaaaaaaa", name: "../escape" }));
    await put(dir, req({ id: "3007-aaaaaaaaaaaa" }), "3007-bbbbbbbbbbbb.json"); // id differs from the file name
    await put(dir, req({ id: "3008-aaaaaaaaaaaa", op: "rm" })); // a spec on a name-only op
    await put(dir, req({ id: "3009-aaaaaaaaaaaa", spec: undefined })); // add with no spec
    await put(dir, { ...req({ id: "3010-aaaaaaaaaaaa" }), "evil\n[chief] forged key": 1 });
    await put(dir, req({ id: "3011-aaaaaaaaaaaa", at: "now" as unknown as number }));
    await put(dir, req({ id: "3013-aaaaaaaaaaaa", by: "x\n[chief] forged log line" }));
    await put(dir, req({ id: "3014-aaaaaaaaaaaa", at: 1 })); // at is not the id's time
    await put(dir, req({ id: "3015-aaaaaaaaaaaa", spec: { ...SPEC, name: "other" } })); // spec names another job
    await put(dir, req({ id: "3016-aaaaaaaaaaaa", op: "edit", spec: [SPEC] }));
    await put(dir, req(), "notes.txt");
    await put(dir, req(), `.${ID}.tmp`);
    await mkdir(join(dir, "3012-aaaaaaaaaaaa.json"));
    const logs: string[] = [];
    const got = await listSpool(dir, (s) => logs.push(s));
    expect(got).toEqual([{ ...req(), sha256: sha(good) }]);
    expect(logs.every((l) => !l.includes("\n"))).toBe(true);
    for (const n of ["3000", "3001", "3002", "3003", "3004", "3005", "3006", "3007", "3008", "3009", "3010", "3011", "3012", "3013", "3014", "3015", "3016"]) {
      expect(logs.some((l) => l.includes(n)), n).toBe(true);
    }
  });

  it("a missing spool dir is empty; a spool dir that is a symlink is never followed", async () => {
    const base = await tmp("spool-base-");
    expect(await listSpool(join(base, "nope"), () => {})).toEqual([]);
    const real = join(base, "real");
    await mkdir(real);
    await put(real, req());
    await symlink(real, join(base, "cron-spool"));
    const logs: string[] = [];
    expect(await listSpool(join(base, "cron-spool"), (s) => logs.push(s))).toEqual([]);
    expect(logs.join("\n")).toMatch(/symlink/);
  });
});

describe("listSpool cap", () => {
  it("lists the 100 oldest by at and logs the overflow once per process", async () => {
    const dir = await tmp("spool-");
    const ats = Array.from({ length: 103 }, (_, i) => 10_000 + i);
    for (const at of [...ats].reverse()) await put(dir, req({ id: `${at}-aaaaaaaaaaaa` }));
    const logs: string[] = [];
    const got = await listSpool(dir, (s) => logs.push(s));
    expect(got.map((r) => r.at)).toEqual(ats.slice(0, 100));
    expect(logs.filter((l) => /more than 100/.test(l))).toHaveLength(1);
    await listSpool(dir, (s) => logs.push(s));
    expect(logs.filter((l) => /more than 100/.test(l))).toHaveLength(1);
  });
});

describe("applySpool (the CLI's own write and unit path, as the console uid)", () => {
  it("an invalid spec: an error and no write, no systemd call", async () => {
    const h = await host();
    const r = await applySpool(req({ spec: { ...SPEC, prompt: "-rf" } }), h.ctx);
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/prompt must not start with "-"/) });
    expect(existsSync(join(h.data, "jobs", "daily.json"))).toBe(false);
    expect(existsSync(join(h.unitDir, "choibot-cron-daily.service"))).toBe(false);
    expect(h.argvs).toEqual([]);
  });

  it("a schedule systemd-analyze rejects: an error and no write", async () => {
    const h = await host((cmd) => (cmd === "systemd-analyze" ? { code: 1, stdout: "", stderr: "Failed to parse calendar specification" } : undefined));
    const r = await applySpool(req({ spec: { ...SPEC, schedule: "at teatime" } }), h.ctx);
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/Failed to parse calendar/) });
    expect(existsSync(join(h.data, "jobs", "daily.json"))).toBe(false);
  });

  it("a valid add: the spec written, the units rendered, then reload and enable", async () => {
    const h = await host();
    expect(await applySpool(req(), h.ctx)).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(join(h.data, "jobs", "daily.json"), "utf8"))).toMatchObject({ ...SPEC, enabled: true, createdAt: 5_000 });
    expect(readFileSync(join(h.unitDir, "choibot-cron-daily.service"), "utf8")).toContain(`${REPO}/bin/cron-runner.mjs daily`);
    expect(readFileSync(join(h.unitDir, "choibot-cron-daily.timer"), "utf8")).toContain("OnCalendar=*-*-* 08:00:00");
    expect(h.argvs).toEqual([
      "systemd-analyze calendar *-*-* 08:00:00",
      "systemctl --user daemon-reload",
      "systemctl --user enable --now choibot-cron-daily.timer",
    ]);
  });

  it("refuses an add or edit whose spec names another job (the tab shows both names)", async () => {
    const h = await host();
    for (const op of ["add", "edit"] as const) {
      const r = await applySpool(req({ op, spec: { ...SPEC, name: "other" } }), h.ctx);
      expect(r).toEqual({ ok: false, error: expect.stringMatching(/names job "other"/) });
    }
    expect(existsSync(join(h.data, "jobs"))).toBe(false);
    expect(h.argvs).toEqual([]);
  });

  it("rm, disable and run go through the CLI's commands; an unknown job is an error", async () => {
    const h = await host();
    expect(await applySpool(req(), h.ctx)).toEqual({ ok: true });
    expect(await applySpool(req({ op: "disable", spec: undefined }), h.ctx)).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(join(h.data, "jobs", "daily.json"), "utf8")).enabled).toBe(false);
    expect(await applySpool(req({ op: "run", spec: undefined }), h.ctx)).toEqual({ ok: true });
    expect(h.argvs).toContain("systemctl --user start choibot-cron-daily.service");
    expect(await applySpool(req({ op: "rm", spec: undefined }), h.ctx)).toEqual({ ok: true });
    expect(existsSync(join(h.data, "jobs", "daily.json"))).toBe(false);
    expect(await applySpool(req({ op: "run", spec: undefined }), h.ctx)).toEqual({ ok: false, error: 'no such job "daily"' });
  });

  it("a throw on the way (a write error, the cron lock) is an error result, not a rejection", async () => {
    const h = await host((cmd) => { if (cmd === "systemd-analyze") throw new Error("spawn EACCES"); return undefined; });
    expect(await applySpool(req(), h.ctx)).toEqual({ ok: false, error: "spawn EACCES" });
    expect(existsSync(join(h.data, "jobs", "daily.json"))).toBe(false);
  });

  it("hardened (ruling 2c-8-a): refuses a workdir an agent can write, by its real path", async () => {
    const base = await tmp("spool-wd-");
    const homes = join(base, "homes");
    const wtRoot = join(base, "wt");
    const repoWt = join(base, "repo", ".agent-worktrees", "agent-1");
    const safe = join(base, "safe");
    for (const d of [join(homes, "x"), join(wtRoot, "agent-2"), repoWt, safe]) mkdirSync(d, { recursive: true });
    chmodSync(safe, 0o755); // S3: the console's own, no group write (the test umask may be 002)
    await symlink(join(homes, "x"), join(base, "looks-safe"));
    const env = { ...HARD, AGENT_HOME_ROOT: homes, AGENT_WORKTREE_ROOT: wtRoot, WORKSPACE_DIR: safe };
    const h = await host(undefined, env);
    for (const [wd, why] of [
      [join(homes, "x"), /AGENT_HOME_ROOT/], [join(base, "looks-safe"), /AGENT_HOME_ROOT/],
      [join(wtRoot, "agent-2"), /AGENT_WORKTREE_ROOT/], [repoWt, /\.agent-worktrees/],
    ] as const) {
      for (const op of ["add", "edit"] as const) {
        const r = await applySpool(req({ op, spec: { ...SPEC, workdir: wd } }), h.ctx);
        expect(r, `${op} ${wd}`).toEqual({ ok: false, error: expect.stringMatching(why) });
      }
    }
    expect(existsSync(join(h.data, "jobs"))).toBe(false);
    expect(h.argvs).toEqual([]);
    // No workdir: the runner's cwd is WORKSPACE_DIR, checked the same way.
    const inHome = await host(undefined, { ...env, WORKSPACE_DIR: join(homes, "x") });
    expect((await applySpool(req(), inHome.ctx)).ok).toBe(false);
    // A workdir outside every agent root is applied.
    expect(await applySpool(req({ spec: { ...SPEC, workdir: safe } }), h.ctx)).toEqual({ ok: true });
  });

  // S3: the denylist above is not enough. Hardened, a job's real cwd must be
  // a directory the console uid owns that no group or other can write.
  it("hardened (S3): only a real cwd the console owns and no group can write", async () => {
    const base = await tmp("spool-wd-");
    const own = join(base, "own");
    const shared = join(base, "shared");
    const open = join(base, "open");
    for (const d of [own, shared, open]) mkdirSync(d);
    chmodSync(own, 0o755);
    chmodSync(shared, 0o2775);
    chmodSync(open, 0o757);
    await symlink(shared, join(base, "via-link"));
    const h = await host(undefined, { ...HARD, WORKSPACE_DIR: own });
    const refused = async (wd: string, why: RegExp) => {
      for (const op of ["add", "edit"] as const) {
        const r = await applySpool(req({ op, spec: { ...SPEC, workdir: wd } }), h.ctx);
        expect(r, `${op} ${wd}`).toEqual({ ok: false, error: expect.stringMatching(why) });
      }
    };
    await refused(shared, /mode 2775 lets a group or others write it/);
    await refused(join(base, "via-link"), /mode 2775 lets a group or others write it/);
    await refused(open, /mode 0757 lets a group or others write it/);
    await refused(join(base, "none"), /is not a directory the console can use \(ENOENT\)/);
    await refused("/", /is owned by uid \d+, not the console/);
    expect(h.argvs).toEqual([]);
    expect(await applySpool(req({ spec: { ...SPEC, workdir: own } }), h.ctx)).toEqual({ ok: true });
  });

  it("not hardened (S3): a group-writable workdir is applied as today", async () => {
    const base = await tmp("spool-wd-");
    const shared = join(base, "shared");
    mkdirSync(shared);
    chmodSync(shared, 0o2775);
    const h = await host(undefined, { ...ACTIVE });
    expect(await applySpool(req({ spec: { ...SPEC, workdir: shared } }), h.ctx)).toEqual({ ok: true });
  });

  it("not hardened: a workdir in .agent-worktrees is applied as today", async () => {
    const base = await tmp("spool-wd-");
    const wt = join(base, "repo", ".agent-worktrees", "agent-1");
    mkdirSync(wt, { recursive: true });
    const h = await host(undefined, { ...ACTIVE, AGENT_HOME_ROOT: base });
    expect(await applySpool(req({ spec: { ...SPEC, workdir: wt } }), h.ctx)).toEqual({ ok: true });
  });

  it("refuses a bad name or a missing spec before any write", async () => {
    const h = await host();
    expect((await applySpool(req({ name: "../x" }), h.ctx)).ok).toBe(false);
    expect((await applySpool(req({ spec: undefined }), h.ctx)).ok).toBe(false);
    expect((await applySpool(req({ op: "edit", spec: [1] }), h.ctx)).ok).toBe(false);
    expect(h.argvs).toEqual([]);
  });
});

describe("ensureSpoolDir (ruling P11)", () => {
  it("makes <root>/cron-spool console-owned 2770, and puts a changed mode back", async () => {
    const root = await tmp("spool-root-");
    const dir = await ensureSpoolDir(root);
    expect(dir).toBe(join(root, "cron-spool"));
    expect(statSync(dir).mode & 0o7777).toBe(0o2770);
    expect(statSync(dir).uid).toBe(process.getuid!());
    await chmod(dir, 0o755);
    await ensureSpoolDir(root);
    expect(statSync(dir).mode & 0o7777).toBe(0o2770);
  });

  it("refuses a cron-spool that is a symlink, and a missing root", async () => {
    const root = await tmp("spool-root-");
    const elsewhere = await tmp("spool-elsewhere-");
    await symlink(elsewhere, join(root, "cron-spool"));
    await expect(ensureSpoolDir(root)).rejects.toThrow(/symlink/);
    expect(statSync(elsewhere).mode & 0o7777).not.toBe(0o2770);
    await expect(ensureSpoolDir(join(root, "missing"))).rejects.toThrow(/does not exist/);
  });
});

// ---- the routes ---------------------------------------------------------------

const USER_TOKEN = "u".repeat(43);
const PAIR = { error: "pair-required", userAuth: "log" };

async function routes(env: Env, o: { onRun?: (cmd: string, args: string[]) => RunResult | undefined } = {}) {
  const root = await tmp("spool-root-");
  const h = await host(o.onRun);
  const deps: CallerDeps = {
    devices: { verify: async (t: string) => (t === USER_TOKEN ? { label: "laptop", createdAt: 1, lastUsedAt: 1 } : null) },
    agents: { load: async (id: string) => (id === "cron-master" ? { id, hookToken: "hook", kind: "cron-master" } as never : null) },
  };
  const gate = makeGate({ misconfigured: null, userAuth: "log", deps });
  const spool = spoolRoutes(gate, { ...env, AGENT_HOME_ROOT: root });
  const dir = join(root, "cron-spool");
  if (spool) await ensureSpoolDir(root);
  const app: FastifyInstance = Fastify();
  registerCronApi(app, {
    hub: new EventHub(), cronDataDir: h.data, listTimers: async () => [],
    spool: spool ? { ...spool, ctx: () => h.ctx } : undefined,
  });
  tmps.push(h.data); // registerCronApi writes its notify token there
  return { app, dir, h, spool };
}
const AS_USER = { [USER_HEADER]: USER_TOKEN };
const AS_AGENT = { [AGENT_HEADER]: "cron-master", [AGENT_TOKEN_HEADER]: "hook" };

describe("spool routes, not hardened", () => {
  it.each(NOT_HARD)("%s: no spool routes (404), the agent env gets no spool", async (_n, env) => {
    const r = await routes(env);
    expect(r.spool).toBeUndefined();
    for (const [method, url] of [["GET", "/api/cron/spool"], ["POST", `/api/cron/spool/${ID}/apply`], ["POST", `/api/cron/spool/${ID}/reject`]] as const) {
      const res = await r.app.inject({ method, url, headers: AS_USER, ...(method === "POST" ? { payload: {} } : {}) });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    expect(existsSync(r.dir)).toBe(false);
    await r.app.close();
  });
});

describe("spool routes, hardened", () => {
  it("GET /api/cron/spool lists the requests for any caller", async () => {
    const r = await routes(HARD);
    const text = await put(r.dir, req());
    for (const headers of [{}, AS_AGENT, AS_USER]) {
      const res = await r.app.inject({ method: "GET", url: "/api/cron/spool", headers });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ requests: [{ ...req(), sha256: sha(text), cwd: REPO }] });
    }
    await r.app.close();
  });

  it("apply refuses a headerless caller and an agent with 403; the request stays, nothing is written", async () => {
    const r = await routes(HARD);
    const text = await put(r.dir, req());
    for (const headers of [{}, AS_AGENT]) {
      const res = await r.app.inject({ method: "POST", url: `/api/cron/spool/${ID}/apply`, headers, payload: { sha256: sha(text) } });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual(PAIR);
    }
    expect(readdirSync(r.dir)).toEqual([`${ID}.json`]);
    expect(existsSync(join(r.h.data, "jobs", "daily.json"))).toBe(false);
    expect(r.h.argvs).toEqual([]);
    await r.app.close();
  });

  it("USER apply writes the spec as the console uid and deletes the request", async () => {
    const r = await routes(HARD);
    const text = await put(r.dir, req());
    const res = await r.app.inject({ method: "POST", url: `/api/cron/spool/${ID}/apply`, headers: AS_USER, payload: { sha256: sha(text) } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(join(r.h.data, "jobs", "daily.json"), "utf8"))).toMatchObject(SPEC);
    expect(statSync(join(r.h.data, "jobs", "daily.json")).uid).toBe(process.getuid!());
    expect(r.h.argvs).toContain("systemctl --user enable --now choibot-cron-daily.timer");
    expect(await readdir(r.dir)).toEqual([]);
    // Applied once: a second apply finds nothing.
    const again = await r.app.inject({ method: "POST", url: `/api/cron/spool/${ID}/apply`, headers: AS_USER, payload: { sha256: sha(text) } });
    expect(again.statusCode).toBe(404);
    await r.app.close();
  });

  it("apply of a request that changed since it was shown: 409, nothing applied, the request stays", async () => {
    const r = await routes(HARD);
    const shown = await put(r.dir, req());
    await put(r.dir, req({ spec: { ...SPEC, prompt: "something else" } }));
    const res = await r.app.inject({ method: "POST", url: `/api/cron/spool/${ID}/apply`, headers: AS_USER, payload: { sha256: sha(shown) } });
    expect(res.statusCode).toBe(409);
    const none = await r.app.inject({ method: "POST", url: `/api/cron/spool/${ID}/apply`, headers: AS_USER, payload: {} });
    expect(none.statusCode).toBe(400);
    expect(readdirSync(r.dir)).toEqual([`${ID}.json`]);
    expect(existsSync(join(r.h.data, "jobs", "daily.json"))).toBe(false);
    await r.app.close();
  });

  it("a rewrite between two GETs is shown as changed and is never appliable (finding 1)", async () => {
    const r = await routes(HARD);
    const first = await put(r.dir, req());
    expect((await r.app.inject({ method: "GET", url: "/api/cron/spool" })).json().requests[0].changed).toBeUndefined();
    const second = await put(r.dir, req({ spec: { ...SPEC, prompt: "something else" } }));
    const listed = (await r.app.inject({ method: "GET", url: "/api/cron/spool" })).json().requests;
    expect(listed).toEqual([{ ...req({ spec: { ...SPEC, prompt: "something else" } }), sha256: sha(second), cwd: REPO, changed: true }]);
    for (const shown of [second, first]) {
      const res = await r.app.inject({ method: "POST", url: `/api/cron/spool/${ID}/apply`, headers: AS_USER, payload: { sha256: sha(shown) } });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/changed after it was shown/);
    }
    // Written back to the first bytes: still changed (sticky), still not appliable.
    await put(r.dir, req());
    expect((await r.app.inject({ method: "GET", url: "/api/cron/spool" })).json().requests[0].changed).toBe(true);
    const back = await r.app.inject({ method: "POST", url: `/api/cron/spool/${ID}/apply`, headers: AS_USER, payload: { sha256: sha(first) } });
    expect(back.statusCode).toBe(409);
    expect(existsSync(join(r.h.data, "jobs", "daily.json"))).toBe(false);
    // Reject still removes it.
    expect((await r.app.inject({ method: "POST", url: `/api/cron/spool/${ID}/reject`, headers: AS_USER })).statusCode).toBe(200);
    expect(await readdir(r.dir)).toEqual([]);
    await r.app.close();
  });

  it("apply of an invalid spec: 422 with the reason, no write, the request deleted", async () => {
    const r = await routes(HARD);
    const text = await put(r.dir, req({ spec: { ...SPEC, timeoutMinutes: 9999 } }));
    const res = await r.app.inject({ method: "POST", url: `/api/cron/spool/${ID}/apply`, headers: AS_USER, payload: { sha256: sha(text) } });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ ok: false, error: expect.stringMatching(/timeoutMinutes/) });
    expect(existsSync(join(r.h.data, "jobs", "daily.json"))).toBe(false);
    expect(await readdir(r.dir)).toEqual([]);
    await r.app.close();
  });

  it("reject: 403 without a user token; as USER it deletes the request and writes nothing", async () => {
    const r = await routes(HARD);
    await put(r.dir, req());
    await put(r.dir, req({ id: ID2, op: "run", spec: undefined }));
    const refused = await r.app.inject({ method: "POST", url: `/api/cron/spool/${ID}/reject`, headers: AS_AGENT });
    expect(refused.statusCode).toBe(403);
    expect(readdirSync(r.dir).sort()).toEqual([`${ID}.json`, `${ID2}.json`]);
    const res = await r.app.inject({ method: "POST", url: `/api/cron/spool/${ID}/reject`, headers: AS_USER });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(readdirSync(r.dir)).toEqual([`${ID2}.json`]);
    expect(existsSync(join(r.h.data, "jobs"))).toBe(false);
    expect(r.h.argvs).toEqual([]);
    await r.app.close();
  });

  it("a missing request is 404, a malformed id 400 (never a path)", async () => {
    const r = await routes(HARD);
    for (const op of ["apply", "reject"]) {
      const missing = await r.app.inject({ method: "POST", url: `/api/cron/spool/${ID}/${op}`, headers: AS_USER, payload: { sha256: "x" } });
      expect(missing.statusCode).toBe(404);
      const bad = await r.app.inject({ method: "POST", url: `/api/cron/spool/..%2Fx/${op}`, headers: AS_USER, payload: { sha256: "x" } });
      expect(bad.statusCode).toBe(400);
    }
    await r.app.close();
  });

  it("hardened with no AGENT_HOME_ROOT: the routes answer, with nothing to list or apply", async () => {
    const gate = makeGate({ misconfigured: null, userAuth: "log", deps: { devices: { verify: async () => null }, agents: { load: async () => null } } });
    expect(spoolRoutes(gate, HARD)).toEqual({ gate, dir: null });
    expect(spoolRoutes(undefined, HARD)).toBeUndefined();
  });
});
