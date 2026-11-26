// server/release.test.ts — which version runs and how the console was installed (server/release.ts):
// a git checkout, a release (release.json), or an archive; GET /api/version.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RELEASE_FILE, installKind, readRelease, registerVersionApi, versionInfo } from "./release.js";

const COMMIT = "33c531a" + "0".repeat(33);
const release = { v: 1, version: 840, commit: COMMIT, channel: "test", builtAt: "2026-11-26T19:00:00Z", node: "24.22.3", pnpm: "10.34.9", gh: "2.105.0" };

describe("release", () => {
  let dir: string;
  const put = (name: string, text: string) => {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  };
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "release-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("knows the three kinds of install", () => {
    expect(installKind(dir)).toBe("archive");
    mkdirSync(join(dir, ".git"));
    expect(installKind(dir)).toBe("checkout");
    rmSync(join(dir, ".git"), { recursive: true });
    put(".git", "gitdir: /elsewhere/.git/worktrees/x\n"); // a worktree
    expect(installKind(dir)).toBe("checkout");
    put(RELEASE_FILE, JSON.stringify(release));
    expect(installKind(dir)).toBe("release"); // release.json wins, even next to a .git
  });

  it("reads release.json of format 1 only, strictly", () => {
    expect(readRelease(dir)).toEqual({ release: null });
    put(RELEASE_FILE, JSON.stringify(release));
    expect(readRelease(dir)).toEqual({ release });
    for (const bad of [
      { ...release, v: 2 }, { ...release, version: 0 }, { ...release, version: 8.5 }, { ...release, commit: "33c531a" },
      { ...release, builtAt: "2026-11-26" }, { ...release, extra: 1 }, { ...release, node: "v24.22.3" },
    ]) {
      put(RELEASE_FILE, JSON.stringify(bad));
      expect(readRelease(dir)).toEqual({ release: null, problem: "release.json is not of format 1" });
    }
    put(RELEASE_FILE, "{not json");
    expect(readRelease(dir).problem).toBe("release.json is not JSON");
  });

  it("gives a release's number and commit", () => {
    put(RELEASE_FILE, JSON.stringify(release));
    put(".next/BUILD_ID", COMMIT);
    expect(versionInfo(dir)).toEqual({ kind: "release", version: 840, commit: COMMIT, buildId: COMMIT, channel: "test", builtAt: "2026-11-26T19:00:00Z" });
  });

  it("says so when the build is not the release's", () => {
    put(RELEASE_FILE, JSON.stringify(release));
    put(".next/BUILD_ID", "f".repeat(40));
    expect(versionInfo(dir).problem).toBe("the build is not the release's (the build records fffffff, the release 33c531a)");
    put(".next/BUILD_ID", "Xy7_random");
    expect(versionInfo(dir).problem).toBe("the build is not the release's (the build records no commit, the release 33c531a)");
  });

  it("says so when release.json does not parse, and keeps the build's commit", () => {
    put(RELEASE_FILE, "{}");
    put(".next/BUILD_ID", COMMIT);
    expect(versionInfo(dir)).toEqual({ kind: "release", version: null, commit: COMMIT, buildId: COMMIT, channel: null, builtAt: null, problem: "release.json is not of format 1" });
  });

  it("gives a git checkout's or an archive's commit from the build, and none for Next's own id", () => {
    mkdirSync(join(dir, ".git"));
    put(".next/BUILD_ID", COMMIT);
    expect(versionInfo(dir)).toEqual({ kind: "checkout", version: null, commit: COMMIT, buildId: COMMIT, channel: null, builtAt: null });
    rmSync(join(dir, ".git"), { recursive: true });
    put(".next/BUILD_ID", "Xy7_random\n");
    expect(versionInfo(dir)).toEqual({ kind: "archive", version: null, commit: null, buildId: "Xy7_random", channel: null, builtAt: null });
    rmSync(join(dir, ".next"), { recursive: true });
    expect(versionInfo(dir).buildId).toBeNull();
  });

  it("answers GET /api/version with what it read at boot", async () => {
    put(RELEASE_FILE, JSON.stringify(release));
    put(".next/BUILD_ID", COMMIT);
    const app = Fastify();
    registerVersionApi(app, versionInfo(dir));
    put(".next/BUILD_ID", "f".repeat(40)); // a change on disk after the boot is not this server's build
    const res = await app.inject({ method: "GET", url: "/api/version" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ kind: "release", version: 840, commit: COMMIT, buildId: COMMIT });
    await app.close();
  });
});
