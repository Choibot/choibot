// server/update/status.test.ts — what the console reads of root's updater and the one file it
// makes (server/update/status.ts): the paths (constants on every release or archive install), the
// strict read of the status file, the empty ask file.
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STATUS_MAX, UPDATE_ASK_FILE, UPDATE_STATUS_FILE, askPending, makeAsk, readUpdateStatus, updatePaths } from "./status.js";

const C849 = "b".repeat(40);
const good = {
  v: 1, at: "2026-11-26T15:00:00Z", checkedAt: "2026-11-26T14:00:00Z", mode: "check", result: "available", step: null, why: "log only",
  installed: { version: 848, commit: "a".repeat(40) }, tried: null, signature: "verified",
  available: { version: 849, commit: C849, builtAt: "2026-11-26T13:00:00Z", security: false, notes: ["#153 feat: one"], extra: 1 },
};

describe("the paths", () => {
  it("are the two constants on a release and an archive install, whatever the test seam says", () => {
    for (const kind of ["release", "archive"] as const) {
      expect(updatePaths(kind, "/tmp/x")).toEqual({ status: UPDATE_STATUS_FILE, ask: UPDATE_ASK_FILE, test: false });
      expect(updatePaths(kind, null)).toEqual({ status: UPDATE_STATUS_FILE, ask: UPDATE_ASK_FILE, test: false });
    }
    expect(UPDATE_STATUS_FILE).toBe("/var/lib/choibot-update/status.json");
    expect(UPDATE_ASK_FILE).toBe("/run/choibot-update/ask");
  });

  it("follow the test seam on a git checkout only (an isolated instance)", () => {
    expect(updatePaths("checkout", "/tmp/inst/update")).toEqual({ status: "/tmp/inst/update/status.json", ask: "/tmp/inst/update/ask", test: true });
    expect(updatePaths("checkout", null).test).toBe(false);
  });
});

describe("the status file", () => {
  let dir: string;
  const put = (value: unknown) => { writeFileSync(join(dir, "status.json"), typeof value === "string" ? value : JSON.stringify(value)); };
  const read = () => readUpdateStatus(join(dir, "status.json"), false);
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "update-status-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("reads format 1 and keeps the fields it does not know", () => {
    put(good);
    const r = read();
    expect("status" in r && r.status.available?.version).toBe(849);
    expect("status" in r && (r.status as Record<string, unknown>).mode).toBe("check");
    expect("status" in r && r.status.result).toBe("available");
  });

  it("says when there is none", () => {
    expect(read()).toEqual({ missing: true });
  });

  it("refuses an unknown v, an unknown result and a field of another type", () => {
    for (const bad of [
      { ...good, v: 2 }, { ...good, result: "great" }, { ...good, step: "Swap Now" }, { ...good, checkedAt: 5 },
      { ...good, installed: { version: "848" } }, { ...good, available: { ...good.available, notes: [1] } },
      { ...good, available: { ...good.available, commit: "b" } }, { ...good, available: { ...good.available, security: "no" } },
    ]) {
      put(bad);
      expect(read()).toEqual({ problem: "the status file is not of format 1" });
    }
    put("{nope");
    expect(read()).toEqual({ problem: "the status file is not JSON" });
  });

  it("refuses a file that is too large, a folder, and a link", () => {
    put(" ".repeat(STATUS_MAX + 1));
    expect(read()).toEqual({ problem: "the status file is too large" });
    rmSync(join(dir, "status.json"));
    mkdirSync(join(dir, "status.json"));
    expect(read()).toEqual({ problem: "the status file is not a file" });
    rmSync(join(dir, "status.json"), { recursive: true });
    writeFileSync(join(dir, "real.json"), JSON.stringify(good));
    symlinkSync(join(dir, "real.json"), join(dir, "status.json"));
    expect(read()).toEqual({ problem: "the status file cannot be opened (ELOOP)" });
  });

  it("wants root's file on a real install (this test's file is not root's)", () => {
    put(good);
    expect(readUpdateStatus(join(dir, "status.json"), true)).toEqual({ problem: "the status file is not root's" });
  });
});

describe("the ask file", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "update-ask-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("is one empty file of mode 0600; a second press is the same press", () => {
    const ask = join(dir, "ask");
    expect(askPending(ask)).toBe(false);
    expect(makeAsk(ask)).toEqual({ ok: true, already: false });
    const st = lstatSync(ask);
    expect([st.isFile(), st.size, st.mode & 0o777]).toEqual([true, 0, 0o600]);
    expect(askPending(ask)).toBe(true);
    expect(makeAsk(ask)).toEqual({ ok: true, already: true });
  });

  it("follows no link, and says why when it cannot ask", () => {
    const ask = join(dir, "ask");
    symlinkSync(join(dir, "elsewhere"), ask);
    expect(makeAsk(ask)).toEqual({ ok: true, already: true });
    expect(() => lstatSync(join(dir, "elsewhere"))).toThrow(); // nothing was made through the link
    expect(makeAsk(join(dir, "no-folder", "ask"))).toEqual({ ok: false, why: "the updater of this server is not there" });
    const shut = join(dir, "shut");
    mkdirSync(shut);
    chmodSync(shut, 0o500);
    try {
      expect(makeAsk(join(shut, "ask"))).toEqual({ ok: false, why: "this console may not ask the updater" });
    } finally {
      chmodSync(shut, 0o700);
    }
  });
});
