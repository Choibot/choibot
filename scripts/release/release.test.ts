// scripts/release/release.test.ts — the rules of the release builder (release.mjs): the entry rules
// of the tree, app/release.json and index.json (format v1, release-format.md).
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ROOT_PARTS, checkFacts, checkIndex, checkTree, cleanNote, indexJson, releaseJson, tarName } from "./release.mjs";

const COMMIT = "33c531a" + "1".repeat(33);
const facts = { version: 840, commit: COMMIT, channel: "test", builtAt: "2026-11-26T19:00:00Z", node: "24.22.3", pnpm: "10.34.9", gh: "2.105.0" };

describe("the release tree", () => {
  let stage: string;
  // Folders as the builder leaves them (0755), whatever the umask of the test is.
  const dirs = (p: string) => {
    mkdirSync(join(stage, p), { recursive: true });
    for (let d = p; d !== "." && d !== ""; d = join(d, "..")) chmodSync(join(stage, d), 0o755);
  };
  const file = (p: string, text = "x", mode = 0o644) => {
    dirs(join(p, ".."));
    writeFileSync(join(stage, p), text);
    chmodSync(join(stage, p), mode);
  };
  beforeEach(() => {
    stage = mkdtempSync(join(tmpdir(), "release-tree-"));
    chmodSync(stage, 0o755);
    for (const top of ["app", "node", "gh"]) dirs(top);
    file("app/package.json");
    file("node/bin/node", "elf", 0o755);
    dirs("app/node_modules/.pnpm/a@1/node_modules/a");
    symlinkSync(".pnpm/a@1/node_modules/a", join(stage, "app/node_modules/a"));
    symlinkSync("../lib/node_modules/pnpm/bin/pnpm.cjs", join(stage, "node/bin/pnpm")); // dangling, but inside
  });
  afterEach(() => { rmSync(stage, { recursive: true, force: true }); });

  it("passes a good tree", () => {
    expect(checkTree(stage)).toEqual([]);
  });

  it("refuses a link that is absolute or goes out of its top folder", () => {
    symlinkSync("/etc/shadow", join(stage, "app/abs"));
    symlinkSync("../node/bin/node", join(stage, "app/out"));
    symlinkSync("../../../../etc", join(stage, "app/node_modules/up"));
    expect(checkTree(stage)).toEqual([
      "app/abs: a link to an absolute path",
      "app/node_modules/up: a link out of app/ (../../../../etc)",
      "app/out: a link out of app/ (../node/bin/node)",
    ]);
  });

  it("refuses a setuid bit, a wrong mode, a fifo, a folder of another mode", () => {
    file("gh/bin/gh", "elf", 0o4755);
    file("app/secret", "x", 0o600);
    execFileSync("mkfifo", [join(stage, "app/pipe")]);
    mkdirSync(join(stage, "app/open"), { mode: 0o777 });
    chmodSync(join(stage, "app/open"), 0o777);
    const p = checkTree(stage);
    expect(p).toContain("gh/bin/gh: a setuid, setgid or sticky bit");
    expect(p).toContain("app/secret: a file of mode 600, not 644 or 755");
    expect(p).toContain("app/pipe: not a file, a folder or a link (a device, a fifo or a socket)");
    expect(p).toContain("app/open: a folder of mode 777, not 755");
  });

  it("refuses another top folder and what must never be in a release", () => {
    dirs("data");
    file("app/.env", "CONSOLE_COOKIE_SECRET=x");
    dirs("app/.agent-data");
    dirs("app/.next/cache");
    const p = checkTree(stage);
    expect(p).toContain("the top folders are app, data, gh, node, not app, node, gh");
    expect(p).toContain("app/.env: it must not be in a release");
    expect(p).toContain("app/.agent-data: it must not be in a release");
    expect(p).toContain("app/.next/cache: it must not be in a release");
  });

  it("writes release.json and index.json of format 1", () => {
    for (const { from } of ROOT_PARTS) if (from) file(from, `text of ${from}`);
    const out = mkdtempSync(join(tmpdir(), "release-out-"));
    try {
      const name = tarName(840, COMMIT);
      expect(name).toBe("choibot-840-33c531a11111-linux-x64.tar.gz");
      writeFileSync(join(out, name), "the tar's bytes");
      const f = { ...facts, file: name, sudoers: "choibot ALL=(choibot-agent) NOPASSWD: /usr/local/bin/choibot-agent-exec\n", notes: ["#144 feat: one", "two\u0007\nlines", "", "x".repeat(250)] };
      expect(releaseJson(f)).toEqual({ v: 1, ...facts });
      const i = checkIndex(indexJson(f, join(out, name), stage));
      expect(Object.keys(i)).toEqual(["v", "channel", "version", "commit", "builtAt", "file", "size", "sha256", "arch", "os", "node", "pnpm", "gh", "minFrom", "security", "expires", "claude", "rootParts", "revoke", "hold", "notes"]);
      expect(i).toMatchObject({ v: 1, channel: "test", version: 840, commit: COMMIT, file: name, size: 15, arch: "x86_64", os: "ubuntu-24.04", minFrom: 0, security: false, expires: null, claude: null, revoke: [], hold: false });
      expect(i.sha256).toBe(execFileSync("sha256sum", [join(out, name)], { encoding: "utf8" }).slice(0, 64));
      expect(i.rootParts.map((r: { path: string }) => r.path)).toEqual(ROOT_PARTS.map((r) => r.path));
      expect(i.rootParts[0].sha256).toBe(execFileSync("sha256sum", [join(stage, "app/deploy/choibot-agent-exec")], { encoding: "utf8" }).slice(0, 64));
      expect(i.notes).toEqual(["#144 feat: one", "two lines", `${"x".repeat(199)}…`]);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("refuses wrong facts and an index of another shape", () => {
    expect(() => checkFacts({ ...facts, version: 0 })).toThrow(/version/);
    expect(() => checkFacts({ ...facts, commit: "33c531a" })).toThrow(/commit/);
    expect(() => checkFacts({ ...facts, channel: "beta" })).toThrow(/channel/);
    expect(() => checkFacts({ ...facts, node: "v24" })).toThrow(/node/);
    expect(() => checkFacts({ ...facts, file: "other.tar.gz" }, ["file"])).toThrow(/file/);
    expect(() => checkIndex({ v: 1 })).toThrow(/the index has the fields/);
    expect(cleanNote("  a\tb  ")).toBe("a b");
  });
});
