import { describe, it, expect, afterEach } from "vitest";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm, writeFile, mkdir, stat } from "node:fs/promises";
import {
  validateSpec, jobUnitNames, resolveCronDataDir, cronPaths,
  atomicWriteJson, readJsonSafe, withLock, RESERVED_NAMES, EFFORTS,
} from "./cronspec.js";

const OPTS = { workdirExists: () => true, now: 123 };
const base = { name: "brief", schedule: "*-*-* 08:00:00", prompt: "hi" };
const reject = (patch: Record<string, unknown>, needle: string | RegExp) => {
  const v = validateSpec({ ...base, ...patch }, OPTS);
  expect(v.ok).toBe(false);
  if (!v.ok) expect(v.error).toMatch(needle);
};

const tmps: string[] = [];
const mktmp = async () => {
  const d = await mkdtemp(join(tmpdir(), "cronspec-"));
  tmps.push(d);
  return d;
};
afterEach(async () => {
  while (tmps.length) await rm(tmps.pop()!, { recursive: true, force: true });
});

describe("validateSpec", () => {
  it("fills defaults on the happy path", () => {
    const v = validateSpec({ name: "brief", schedule: "*-*-* 08:00:00", prompt: "hi" },
      { workdirExists: () => true, now: 123 });
    expect(v).toMatchObject({
      ok: true,
      spec: { name: "brief", timeoutMinutes: 30, notify: "always", enabled: true, createdAt: 123 },
    });
  });

  it("keeps the caller's values when they are supplied", () => {
    const v = validateSpec(
      { ...base, workdir: "/srv/app", model: "opus-4.8", effort: "high", timeoutMinutes: 90, notify: "on-failure", enabled: false, createdAt: 7 },
      OPTS,
    );
    expect(v).toMatchObject({
      ok: true,
      spec: { workdir: "/srv/app", model: "opus-4.8", effort: "high", timeoutMinutes: 90, notify: "on-failure", enabled: false, createdAt: 7 },
    });
  });

  it("rejects a non-object spec", () => {
    const v = validateSpec(null, OPTS);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/JSON object/);
  });

  it("rejects a name with a leading dash", () => reject({ name: "-x" }, /invalid name/));
  it("rejects an uppercase name", () => reject({ name: "A" }, /invalid name/));
  it("rejects a name containing a space", () => reject({ name: "a b" }, /invalid name/));
  it("rejects a 42-character name", () => reject({ name: "a".repeat(42) }, /invalid name/));
  it("accepts a 41-character name (the boundary)", () => {
    expect(validateSpec({ ...base, name: "a".repeat(41) }, OPTS).ok).toBe(true);
  });
  it("rejects the reserved name \"console\"", () => reject({ name: "console" }, /reserved/));
  it("rejects every reserved name", () => {
    for (const n of RESERVED_NAMES) reject({ name: n }, /reserved/);
  });

  it("rejects an empty prompt", () => reject({ prompt: "   " }, /prompt is required/));
  it("rejects a prompt starting with a dash (would bind as a claude flag)", () =>
    reject({ prompt: "--help me out" }, /must not start with "-"/));
  it("rejects an empty schedule", () => reject({ schedule: "  " }, /schedule is required/));
  it("rejects a schedule containing a newline (unit-file injection)", () =>
    reject({ schedule: "daily\nExecStart=/bin/evil" }, /control character/));
  it("rejects a schedule containing a carriage return", () =>
    reject({ schedule: "daily\rx" }, /control character/));

  it("rejects a workdir that does not exist", () => {
    const v = validateSpec({ ...base, workdir: "/nope" }, { workdirExists: () => false, now: 1 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/workdir does not exist/);
  });
  it("rejects a relative workdir", () => reject({ workdir: "x/y" }, /absolute path/));

  it("rejects a model with a leading dash", () => reject({ model: "-p" }, /invalid model/));
  it("rejects a model containing a space", () => reject({ model: "bad name" }, /invalid model/));

  it("accepts an account id and omits an empty one", () => {
    const ok = validateSpec({ ...base, account: "office" }, OPTS);
    expect(ok.ok && ok.spec.account).toBe("office");
    const none = validateSpec({ ...base, account: "" }, OPTS);
    expect(none.ok && "account" in none.spec).toBe(false);
  });
  it("rejects an invalid account", () => reject({ account: "../x" }, /invalid account/));
  it("rejects an unknown effort", () => reject({ effort: "turbo" }, /effort must be one of/));
  it("accepts every declared effort", () => {
    for (const e of EFFORTS) expect(validateSpec({ ...base, effort: e }, OPTS).ok).toBe(true);
  });

  it("rejects timeoutMinutes of 0", () => reject({ timeoutMinutes: 0 }, /1\.\.720/));
  it("rejects timeoutMinutes of 1000", () => reject({ timeoutMinutes: 1000 }, /1\.\.720/));
  it("rejects a fractional timeoutMinutes", () => reject({ timeoutMinutes: 1.5 }, /1\.\.720/));

  it("rejects an unknown notify mode", () => reject({ notify: "sometimes" }, /notify must be/));
});

describe("paths and unit names", () => {
  it("derives systemd unit names from the job name", () => {
    expect(jobUnitNames("brief")).toEqual({
      service: "choibot-cron-brief.service", timer: "choibot-cron-brief.timer",
    });
  });

  it("defaults the data dir under the home directory", () => {
    expect(resolveCronDataDir({})).toBe(join(homedir(), ".local", "share", "choibot", "cron"));
  });
  it("honors XDG_DATA_HOME", () => {
    expect(resolveCronDataDir({ XDG_DATA_HOME: "/x" })).toBe(join("/x", "choibot", "cron"));
  });
  it("honors an explicit CRON_DATA_DIR", () => {
    expect(resolveCronDataDir({ CRON_DATA_DIR: "/d" })).toBe("/d");
  });

  it("lays out every cron path under the data dir", () => {
    expect(cronPaths("/d")).toEqual({
      jobsDir: "/d/jobs", runsDir: "/d/runs", memoryDir: "/d/memory",
      agentDir: "/d/agent", tokenFile: "/d/notify-token", lockDir: "/d/.lock",
    });
  });
});

describe("atomic JSON IO", () => {
  it("round-trips a value through atomicWriteJson and readJsonSafe", async () => {
    const dir = await mktmp();
    const file = join(dir, "nested", "job.json");
    const value = { name: "brief", timeoutMinutes: 30, tags: ["a", "b"] };
    await atomicWriteJson(file, value);
    expect(await readJsonSafe(file)).toEqual(value);
    // Specs can carry prompts with secrets in them — owner-only, and the mode
    // must survive the tmp-file rename.
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("returns null for a missing file", async () => {
    const dir = await mktmp();
    expect(await readJsonSafe(join(dir, "absent.json"))).toBeNull();
  });

  it("returns null for a file containing malformed JSON", async () => {
    const dir = await mktmp();
    const file = join(dir, "bad.json");
    await writeFile(file, "{ tor");
    expect(await readJsonSafe(file)).toBeNull();
  });
});

describe("withLock", () => {
  it("serializes two concurrent holders", async () => {
    const dir = await mktmp();
    const marks: string[] = [];
    const body = async () => {
      marks.push("start");
      await new Promise((r) => setTimeout(r, 50));
      marks.push("end");
    };
    await Promise.all([withLock(dir, body), withLock(dir, body)]);
    expect(marks).toEqual(["start", "end", "start", "end"]);
  });

  it("releases the lock when the body throws", async () => {
    const dir = await mktmp();
    await expect(withLock(dir, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await withLock(dir, async () => "second")).toBe("second");
  });

  it("breaks a stale lock left behind by a crashed process", async () => {
    const dir = await mktmp();
    const { lockDir } = cronPaths(dir);
    await mkdir(lockDir, { recursive: true });
    const old = new Date(Date.now() - 120_000);
    const { utimes } = await import("node:fs/promises");
    await utimes(lockDir, old, old);
    expect(await withLock(dir, async () => "ran")).toBe("ran");
  });
});
