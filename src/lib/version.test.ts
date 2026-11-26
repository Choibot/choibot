// src/lib/version.test.ts — Settings, "Version": the status line and the read of GET /api/version.
import { describe, expect, it } from "vitest";
import { fetchVersion, versionName, versionStatus, type VersionInfo } from "./version";

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
