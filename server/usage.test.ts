import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeUsage, mergeUsage, mergeAccounts, getUsage, usageWithin, type UsageWindow } from "./usage.js";

// Mirrors the real /api/oauth/usage payload: the flat *_opus/*_sonnet fields go
// null as models get scoped, and the authoritative data lives in `limits[]`.
const LIVE = {
  five_hour: { utilization: 3.0, resets_at: "2026-07-08T02:39:59Z" },
  seven_day: { utilization: 54.0, resets_at: "2026-07-13T16:59:59Z" },
  seven_day_opus: null,
  seven_day_sonnet: null,
  limits: [
    { kind: "session", group: "session", percent: 3, severity: "normal", resets_at: "2026-07-08T02:39:59Z", scope: null, is_active: false },
    { kind: "weekly_all", group: "weekly", percent: 54, severity: "normal", resets_at: "2026-07-13T16:59:59Z", scope: null, is_active: false },
    { kind: "weekly_scoped", group: "weekly", percent: 93, severity: "critical", resets_at: "2026-07-13T16:59:59Z", scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: true },
  ],
};

describe("normalizeUsage", () => {
  it("maps the live limits array, ordered session → week → scoped", () => {
    const r = normalizeUsage(LIVE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.windows.map((w) => w.label)).toEqual(["Session", "Week", "Week · Fable"]);
    expect(r.windows.map((w) => w.key)).toEqual(["session", "weekly:all", "weekly:Fable"]);
    expect(r.windows.map((w) => w.group)).toEqual(["session", "weekly", "weekly"]);
  });

  it("carries percent, severity, active, and reset through", () => {
    const r = normalizeUsage(LIVE);
    if (!r.ok) throw new Error("expected ok");
    const fable = r.windows.find((w) => w.key === "weekly:Fable")!;
    expect(fable.percent).toBe(93);
    expect(fable.severity).toBe("critical");
    expect(fable.active).toBe(true);
    expect(fable.resetsAt).toBe("2026-07-13T16:59:59Z");
    const session = r.windows.find((w) => w.key === "session")!;
    expect(session.active).toBe(false);
    expect(session.severity).toBe("normal");
  });

  it("orders multiple scoped windows by descending pressure", () => {
    const r = normalizeUsage({
      limits: [
        { kind: "weekly_all", group: "weekly", percent: 10, severity: "normal" },
        { kind: "weekly_scoped", group: "weekly", percent: 40, severity: "normal", scope: { model: { display_name: "Opus" } } },
        { kind: "weekly_scoped", group: "weekly", percent: 88, severity: "warning", scope: { model: { display_name: "Fable" } } },
      ],
    });
    if (!r.ok) throw new Error("expected ok");
    // weekly_all first, then scoped by percent desc (Fable 88 before Opus 40).
    expect(r.windows.map((w) => w.label)).toEqual(["Week", "Week · Fable", "Week · Opus"]);
  });

  it("rounds and clamps percent", () => {
    const r = normalizeUsage({ limits: [{ kind: "session", percent: 3.7 }, { kind: "weekly_all", percent: 250 }] });
    if (!r.ok) throw new Error("expected ok");
    expect(r.windows.find((w) => w.key === "session")!.percent).toBe(4);
    expect(r.windows.find((w) => w.key === "weekly:all")!.percent).toBe(100);
  });

  it("derives severity from percent when the API omits it", () => {
    const r = normalizeUsage({ limits: [{ kind: "session", percent: 95 }, { kind: "weekly_all", percent: 80 }] });
    if (!r.ok) throw new Error("expected ok");
    expect(r.windows.find((w) => w.key === "session")!.severity).toBe("critical");
    expect(r.windows.find((w) => w.key === "weekly:all")!.severity).toBe("warning");
  });

  it("labels a scoped window without a model name", () => {
    const r = normalizeUsage({ limits: [{ kind: "weekly_scoped", percent: 5, scope: { model: {} } }] });
    if (!r.ok) throw new Error("expected ok");
    expect(r.windows[0].label).toBe("Week · scoped");
    expect(r.windows[0].key).toBe("weekly:scoped");
  });

  it("keeps an unknown limit kind rather than dropping it", () => {
    const r = normalizeUsage({ limits: [{ kind: "monthly_special", group: "weekly", percent: 12 }] });
    if (!r.ok) throw new Error("expected ok");
    expect(r.windows[0].label).toBe("Monthly Special");
  });

  it("falls back to the legacy flat fields when limits is absent", () => {
    const r = normalizeUsage({
      five_hour: { utilization: 12, resets_at: "2026-07-08T00:00:00Z" },
      seven_day: { utilization: 34, resets_at: "2026-07-13T00:00:00Z" },
    });
    if (!r.ok) throw new Error("expected ok");
    expect(r.windows.map((w) => w.label)).toEqual(["Session", "Week"]);
    expect(r.windows[0].percent).toBe(12);
  });

  it("returns not-ok for empty or window-less payloads", () => {
    expect(normalizeUsage(null).ok).toBe(false);
    expect(normalizeUsage({}).ok).toBe(false);
    expect(normalizeUsage({ limits: [] }).ok).toBe(false);
  });
});

describe("mergeUsage", () => {
  it("merges codex windows after the claude ones", async () => {
    const claude = normalizeUsage({ limits: [{ kind: "session", percent: 20 }] });
    expect(claude.ok).toBe(true);
    const merged = mergeUsage(claude, [{
      key: "codex:session", label: "Codex · Session", group: "session",
      percent: 5, severity: "normal", resetsAt: null, active: false,
    }]);
    expect(merged.ok).toBe(true);
    expect((merged as { windows: unknown[] }).windows).toHaveLength(2);
  });

  it("reports ok when only codex has windows", () => {
    const merged = mergeUsage({ ok: false, reason: "no-credentials" }, [{
      key: "codex:session", label: "Codex · Session", group: "session",
      percent: 5, severity: "normal", resetsAt: null, active: false,
    }]);
    expect(merged.ok).toBe(true);
  });

  it("keeps the claude failure reason when neither source has windows", () => {
    const merged = mergeUsage({ ok: false, reason: "no-credentials" }, []);
    expect(merged).toEqual({ ok: false, reason: "no-credentials" });
  });

  it("keeps the claude windows when codex has none", () => {
    const claude = normalizeUsage({ limits: [{ kind: "session", percent: 20 }] });
    expect(mergeUsage(claude, [])).toEqual(claude);
  });
});

// Runs against a box with no credentials and a fake codex, so no network call
// and no real subscription are involved: HOME points at an empty temp dir, which
const ACCT = (id: string, label = id) => ({ id, label, email: null, loggedIn: true, isDefault: id === "default" });
const WIN = (key: string, label: string): UsageWindow =>
  ({ key, label, group: "session", percent: 10, severity: "normal", resetsAt: null, active: false });

describe("mergeAccounts", () => {
  it("leaves a single login's windows untouched — no account tag, same keys", () => {
    const r = mergeAccounts([{ account: ACCT("default"), result: { ok: true, windows: [WIN("session", "Session")] } }]);
    expect(r).toEqual({ ok: true, windows: [WIN("session", "Session")] });
  });
  it("tags and namespaces every window once there are two logins, default first", () => {
    const r = mergeAccounts([
      { account: ACCT("default", "a@x.io"), result: { ok: true, windows: [WIN("session", "Session")] } },
      { account: ACCT("work"), result: { ok: true, windows: [WIN("session", "Session")] } },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.windows.map((w) => [w.key, w.account])).toEqual([
      ["default/session", "a@x.io"], ["work/session", "work"],
    ]);
  });
  it("drops logins that returned nothing (not logged in yet) rather than blanking the strip", () => {
    const r = mergeAccounts([
      { account: ACCT("default"), result: { ok: true, windows: [WIN("session", "Session")] } },
      { account: ACCT("work"), result: { ok: false, reason: "no-credentials" } },
    ]);
    expect(r.ok && r.windows.map((w) => w.key)).toEqual(["default/session"]);
  });
  it("reports the default account's failure when no login produced windows", () => {
    const r = mergeAccounts([
      { account: ACCT("default"), result: { ok: false, reason: "http_401" } },
      { account: ACCT("work"), result: { ok: false, reason: "no-credentials" } },
    ]);
    expect(r).toEqual({ ok: false, reason: "http_401" });
    expect(mergeAccounts([])).toEqual({ ok: false, reason: "no-windows" });
  });
});

// makes the Claude half return no-credentials before it ever reaches fetch().
// The fake codex records each invocation, so "one spawn, not N" is asserted
// directly rather than inferred.
describe("getUsage single-flight", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("coalesces concurrent cold-cache callers into one refresh", async () => {
    const dir = await mkdtemp(join(tmpdir(), "usage-flight-"));
    try {
      const log = join(dir, "spawns");
      const bin = join(dir, "codex");
      await writeFile(bin, `#!/bin/sh\necho spawned >> ${log}\nexit 0\n`, { mode: 0o755 });
      await writeFile(log, "");
      vi.stubEnv("HOME", dir);
      vi.stubEnv("CODEX_EXECUTABLE", bin);

      const results = await Promise.all(Array.from({ length: 5 }, () => getUsage()));

      // Same object for every caller: one refresh was shared, not five run and
      // five discarded. Distinct runs would each build their own result.
      for (const r of results) expect(r).toBe(results[0]);
      expect(results[0]).toEqual({ ok: false, reason: "no-credentials" });

      const spawns = (await readFile(log, "utf8")).trim();
      expect(spawns === "" ? 0 : spawns.split("\n").length).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("usageWithin", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("gives the answer of the read when it comes in time, and never waits longer than the time given", async () => {
    const dir = await mkdtemp(join(tmpdir(), "usage-within-"));
    try {
      vi.stubEnv("HOME", dir);                         // no login there: the read ends before any call
      vi.stubEnv("CODEX_EXECUTABLE", join(dir, "none"));
      const t0 = Date.now();
      expect(await usageWithin(3_000)).toEqual({ ok: false, reason: "no-credentials" });
      expect(Date.now() - t0).toBeLessThan(3_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("usageUrl", () => {
  it("is Anthropic's address on every console but a test instance with a loopback fake", async () => {
    const { usageUrl } = await import("./usage.js");
    const real = "https://api.anthropic.com/api/oauth/usage";
    expect(usageUrl({})).toBe(real);
    expect(usageUrl({ CHIEF_TEST_USAGE_API: "http://127.0.0.1:4999" })).toBe(real);                       // not a test instance
    expect(usageUrl({ CHIEF_TEST: "1", CHIEF_TEST_USAGE_API: "http://127.0.0.1:4999" })).toBe("http://127.0.0.1:4999/api/oauth/usage");
    for (const bad of ["https://evil.test", "http://10.0.0.5:80", "http://127.0.0.1:4999/x", "http://127.0.0.1.evil.test:80"]) {
      expect(usageUrl({ CHIEF_TEST: "1", CHIEF_TEST_USAGE_API: bad }), bad).toBe(real);                  // the token never goes there
    }
  });
});
