import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeCodexLimits, readRateLimits, codexUsageWindows } from "./codex-usage.js";

describe("normalizeCodexLimits", () => {
  it("labels codex windows distinctly and prefixes their keys", () => {
    const out = normalizeCodexLimits({
      rate_limits: {
        primary: { used_percent: 42, resets_at: "2026-08-14T00:00:00Z" },
        secondary: { used_percent: 10, resets_at: null },
      },
    });
    expect(out.map((w) => w.key)).toEqual(["codex:session", "codex:weekly"]);
    expect(out[0].label).toBe("Codex · Session");
    expect(out[1].label).toBe("Codex · Week");
    expect(out[0].percent).toBe(42);
    expect(out[0].resetsAt).toBe("2026-08-14T00:00:00Z");
  });

  it("derives severity from percent", () => {
    const [w] = normalizeCodexLimits({ rate_limits: { primary: { used_percent: 95 } } });
    expect(w.severity).toBe("critical");
  });

  it("returns empty for an unrecognized payload rather than throwing", () => {
    expect(normalizeCodexLimits(null)).toEqual([]);
    expect(normalizeCodexLimits({ nope: 1 })).toEqual([]);
  });

  // The live shape, captured from `account/rateLimits/read` on this box: camelCase
  // keys, an integer percent, and an epoch-seconds reset. A Plus account reports
  // one 10080-minute window in `primary` and nothing in `secondary`.
  it("reads the app-server's camelCase snapshot", () => {
    const out = normalizeCodexLimits({
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: 1787245492 },
        secondary: null,
        planType: "plus",
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0].key).toBe("codex:session");
    expect(out[0].percent).toBe(1);
    expect(out[0].resetsAt).toBe("2026-08-20T17:04:52.000Z");
    expect(out[0].label).toBe("Codex · 7d");
  });

  // Positional keys are fixed, but the label follows the window it actually
  // measures: a Plus account's `primary` is a week, not a five-hour session, and
  // calling it "Session" in the meter would be a lie.
  it("labels by window duration when the payload states one", () => {
    const [week] = normalizeCodexLimits({
      rate_limits: { primary: { used_percent: 1, window_minutes: 10080 } },
    });
    expect(week.label).toBe("Codex · 7d");
    expect(week.group).toBe("weekly");
    expect(week.key).toBe("codex:session");

    const [session] = normalizeCodexLimits({
      rate_limits: { primary: { used_percent: 1, window_minutes: 300 } },
    });
    expect(session.label).toBe("Codex · 5h");
    expect(session.group).toBe("session");
  });

  it("keeps partial hours and days in duration labels", () => {
    const labels = [61, 90, 1439, 1500].map((window_minutes) =>
      normalizeCodexLimits({
        rate_limits: { primary: { used_percent: 1, window_minutes } },
      })[0].label,
    );
    expect(labels).toEqual([
      "Codex · 1h 1m",
      "Codex · 1h 30m",
      "Codex · 23h 59m",
      "Codex · 1d 1h",
    ]);
  });

  // 43200 minutes is not hypothetical: it is what this box's own rollout at
  // ~/.codex/sessions/2026/07/09/rollout-*.jsonl reports for a free account. A
  // bucket list that stopped at "week" would have labelled a month "Codex · Week".
  it("does not call a 30-day window a week", () => {
    const [w] = normalizeCodexLimits({
      rate_limits: {
        limit_id: "codex", plan_type: "free",
        primary: { used_percent: 5.0, window_minutes: 43200, resets_at: 1786212412 },
        secondary: null,
      },
    });
    expect(w.label).toBe("Codex · 30d");
    expect(w.group).toBe("weekly");
    expect(w.percent).toBe(5);
  });

  it("ignores a zero or negative window duration and keeps the positional name", () => {
    const [zero] = normalizeCodexLimits({
      rate_limits: { primary: { used_percent: 1, window_minutes: 0 } },
    });
    expect(zero.label).toBe("Codex · Session");
    const [neg] = normalizeCodexLimits({
      rate_limits: { secondary: { used_percent: 1, window_minutes: -5 } },
    });
    expect(neg.label).toBe("Codex · Week");
  });

  it("clamps and rounds a fractional percent", () => {
    const [w] = normalizeCodexLimits({ rate_limits: { primary: { used_percent: 5.4 } } });
    expect(w.percent).toBe(5);
    const [hi] = normalizeCodexLimits({ rate_limits: { primary: { used_percent: 420 } } });
    expect(hi.percent).toBe(100);
  });

  it("drops a window with no usable percent", () => {
    expect(normalizeCodexLimits({ rate_limits: { primary: { used_percent: null } } })).toEqual([]);
    expect(normalizeCodexLimits({ rate_limits: { primary: "nope" } })).toEqual([]);
  });
});

// The child-process half. A fake `codex` stands in for the app-server so the
// contract that matters — "every failure degrades to empty, nothing is left
// running" — is pinned without a network call or a real login. The seam is the
// binary path, the same one server/agents/api.test.ts already stubs.
describe("readRateLimits", () => {
  let dir: string;

  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), "codex-usage-")); });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
  afterEach(() => { vi.unstubAllEnvs(); });

  // Each fake ignores its argv and speaks whatever the case under test needs.
  async function fake(name: string, body: string): Promise<string> {
    const p = join(dir, name);
    await writeFile(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return p;
  }

  const REPLY = {
    rateLimits: {
      limitId: "codex", planType: "plus",
      primary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: 1787245492 },
      secondary: null,
    },
  };

  it("matches the reply by request id, not by arrival order", async () => {
    // Notification first, then a decoy result for the handshake's id 1, then the
    // real id 2 — which is exactly how the live server interleaves them.
    const bin = await fake("ordered", [
      `echo '{"method":"configWarning","params":{"summary":"no bubblewrap"}}'`,
      `echo '{"id":1,"result":{"userAgent":"x"}}'`,
      `echo '{"id":2,"result":${JSON.stringify(REPLY)}}'`,
      "exec sleep 30",
    ].join("\n"));
    const out = await readRateLimits(bin, 2000);
    expect(normalizeCodexLimits(out).map((w) => w.label)).toEqual(["Codex · 7d"]);
  });

  // A child that answers and exits in the same breath closes its stdin while we
  // are still writing the handshake, so an EPIPE and a valid reply arrive
  // together. Settling on the write failure would race the read and throw the
  // answer away; the loop makes that race show up rather than pass four times
  // in five.
  it("keeps the answer from a child that replies and exits at once", async () => {
    const bin = await fake("quick", `echo '{"id":2,"result":${JSON.stringify(REPLY)}}'`);
    for (let i = 0; i < 8; i++) {
      expect(normalizeCodexLimits(await readRateLimits(bin, 2000))).toHaveLength(1);
    }
  });

  it("returns null when the binary does not exist", async () => {
    expect(await readRateLimits(join(dir, "no-such-codex"), 2000)).toBeNull();
  });

  it("returns null when the binary exits immediately", async () => {
    // Also covers the EPIPE path: the handshake is written to a pipe whose
    // reader is already gone, and a stream 'error' would otherwise be uncaught.
    expect(await readRateLimits(await fake("instant", "exit 0"), 2000)).toBeNull();
  });

  it("returns null when the binary exits nonzero", async () => {
    expect(await readRateLimits(await fake("boom", "exit 7"), 2000)).toBeNull();
  });

  it("times out when the server never answers the request id", async () => {
    const bin = await fake("mute", [
      `echo '{"id":1,"result":{}}'`,
      `echo '{"method":"remoteControl/status/changed","params":{}}'`,
      "exec sleep 30",
    ].join("\n"));
    const t0 = Date.now();
    expect(await readRateLimits(bin, 300)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("gives up on a single unterminated line past the cap", async () => {
    // 2 MB with no newline: the parser can never complete a line, so the cap —
    // not the timeout — must end it. A short timeout would pass either way, so
    // this uses a long one and asserts it returned well before it.
    const bin = await fake("flood", [
      "head -c 2000000 /dev/zero | tr '\\0' 'x'",
      "exec sleep 30",
    ].join("\n"));
    const t0 = Date.now();
    expect(await readRateLimits(bin, 10000)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("leaves no child running once it has resolved", async () => {
    const pidFile = join(dir, "pid");
    // `exec` so the pid recorded IS the process we kill, not a shell wrapping it.
    const bin = await fake("lingerer", [
      `echo $$ > ${pidFile}`,
      `echo '{"id":2,"result":${JSON.stringify(REPLY)}}'`,
      "exec sleep 30",
    ].join("\n"));
    expect(await readRateLimits(bin, 2000)).not.toBeNull();

    const pid = Number((await readFile(pidFile, "utf8")).trim());
    expect(Number.isFinite(pid)).toBe(true);
    let alive = true;
    for (let i = 0; i < 50 && alive; i++) {
      try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 20)); }
      catch { alive = false; }
    }
    expect(alive).toBe(false);
  });

  it("codexUsageWindows degrades to [] when CODEX_EXECUTABLE points nowhere", async () => {
    vi.stubEnv("CODEX_EXECUTABLE", join(dir, "no-such-codex"));
    expect(await codexUsageWindows()).toEqual([]);
  });

  it("codexUsageWindows reads windows through the stubbed binary", async () => {
    const bin = await fake("good", `echo '{"id":2,"result":${JSON.stringify(REPLY)}}'`);
    vi.stubEnv("CODEX_EXECUTABLE", bin);
    const out = await codexUsageWindows();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ key: "codex:session", percent: 1, group: "weekly" });
  });
});
