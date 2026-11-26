// src/lib/version.test.ts — Settings, "Version": the status line and the read of GET /api/version.
import { describe, expect, it } from "vitest";
import { fetchUpdateView, fetchVersion, updateWords, versionName, versionStatus, type VersionInfo, type UpdateView } from "./version";

const COMMIT = "33c531a" + "0".repeat(33);
const base: VersionInfo = { kind: "checkout", version: null, commit: COMMIT, buildId: COMMIT, channel: null, builtAt: null };

describe("version words", () => {
  it("names a release by its number and a checkout or an archive by its commit", () => {
    expect(versionName({ ...base, kind: "release", version: 840, channel: "test", builtAt: "2026-11-26T19:00:00Z" })).toBe("Version 840 (33c531a)");
    expect(versionName(base)).toBe("Commit 33c531a");
    expect(versionName({ ...base, kind: "archive" })).toBe("Commit 33c531a");
    expect(versionName({ ...base, kind: "archive", commit: null, buildId: "Xy7" })).toBeNull();
  });

  it("gives the status line of each case", () => {
    expect(versionStatus(null)).toEqual({ tone: "load", text: "Checking…" });
    expect(versionStatus({ error: "the console did not answer" })).toEqual({ tone: "err", text: "Cannot read the version: the console did not answer" });
    expect(versionStatus({ ...base, kind: "release", version: 840 })).toEqual({ tone: "ok", text: "Version 840 (33c531a)" });
    expect(versionStatus({ ...base, kind: "archive", commit: null })).toEqual({ tone: "off", text: "Version not known: this build recorded no commit" });
    expect(versionStatus({ ...base, kind: "release", problem: "release.json is not of format 1" })).toEqual({ tone: "warn", text: "Commit 33c531a: release.json is not of format 1" });
    expect(versionStatus({ ...base, kind: "release", commit: null, problem: "release.json is missing" })).toEqual({ tone: "warn", text: "Version not known: release.json is missing" });
  });

  it("reads GET /api/version, and says why when it cannot", async () => {
    const answer = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });
    expect(await fetchVersion({ fetch: answer(200, base) })).toEqual(base);
    expect(await fetchVersion({ fetch: answer(401, { error: "unauthorized" }) })).toEqual({ error: "the console answered HTTP 401" });
    expect(await fetchVersion({ fetch: answer(200, { nope: 1 }) })).toEqual({ error: "the answer is not a version" });
    expect(await fetchVersion({ fetch: async () => { throw new Error("down"); } })).toEqual({ error: "the console did not answer" });
  });
});

describe("the update line of Settings (a hosted console)", () => {
  const NOW = Date.parse("2026-11-26T16:00:00Z");
  const view = (o: Partial<UpdateView>): UpdateView => ({ on: true, running: 848, checkedAt: null, result: null, tried: null, installed: null, step: null, ...o });
  it("says the version and when root last checked; nothing where there is no updater", () => {
    expect(updateWords(null, NOW)).toBeNull();
    expect(updateWords(view({ on: false }), NOW)).toBeNull();
    expect(updateWords(view({}), NOW)).toBe("Version 848, not checked yet");
    expect(updateWords(view({ checkedAt: "2026-11-26T14:00:00Z", result: "current" }), NOW)).toBe("Version 848, checked 2 h ago");
    expect(updateWords(view({ checkedAt: "2026-11-26T14:00:00Z", result: "unreachable" }), NOW)).toBe("Version 848, checked 2 h ago");
  });
  it("says how an update ended; 'back on' only when the way back passed", () => {
    expect(updateWords(view({ result: "failed-back", tried: 849, installed: 848 }), NOW)).toBe("Update to 849 failed. Back on 848.");
    expect(updateWords(view({ result: "failed-stuck", tried: 849, installed: 848 }), NOW)).toBe("Update to 849 failed. The console needs help.");
  });
  it("reads the view from GET /api/deploy, and nothing from a git console's answer", async () => {
    const answer = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200 });
    expect(await fetchUpdateView({ fetch: answer({ armed: true, update: view({}) }) })).toEqual(view({}));
    expect(await fetchUpdateView({ fetch: answer({ armed: true, unit: "choibot.service" }) })).toBeNull();
    expect(await fetchUpdateView({ fetch: async () => { throw new Error("down"); } })).toBeNull();
  });
});
