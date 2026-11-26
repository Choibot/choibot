// scripts/release/release.test.ts — the rules of the release builder (release.mjs): the entry rules
// of the tree, app/release.json and index.json (format v1, release-format.md).
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXPIRES_DAYS_MAX, NOTES_SHOWN, ROOT_PARTS, checkFacts, checkIndex, checkNotes, checkRelease, checkTree, cleanNote, expiresAt, expiresRefusal, indexJson, releaseJson, tarName } from "./release.mjs";

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

  it("install.sh's check of an extracted release: the entry rules, release.json, its build, its parts, the pins", () => {
    const pins = { node: "24.22.3", pnpm: "10.34.9", gh: "2.105.0" };
    const make = () => {
      file("app/release.json", JSON.stringify({ v: 1, ...facts }));
      file("app/.next/BUILD_ID", COMMIT);
      file("app/server/index.ts", "// the server");
      file("app/node_modules/.bin/tsx", "#!/bin/sh", 0o755);
      file("gh/bin/gh", "elf", 0o755);
    };
    make();
    expect(checkRelease(stage, pins)).toEqual({ version: 840, commit: COMMIT, channel: "test" });
    expect(() => checkRelease(stage, { ...pins, node: "24.23.0" })).toThrow("the release has node 24.22.3, and this install line pins 24.23.0: they do not belong together");
    file("app/.next/BUILD_ID", "f".repeat(40));
    expect(() => checkRelease(stage, pins)).toThrow("the build of the release is not its commit (app/.next/BUILD_ID)");
    file("app/.next/BUILD_ID", COMMIT);
    rmSync(join(stage, "app/node_modules/.bin/tsx"));
    expect(() => checkRelease(stage, pins)).toThrow("the release has no app/node_modules/.bin/tsx");
    file("app/node_modules/.bin/tsx", "#!/bin/sh", 0o755);
    file("app/release.json", JSON.stringify({ v: 2, ...facts }));
    expect(() => checkRelease(stage, pins)).toThrow("app/release.json is not of format 1");
    file("app/release.json", JSON.stringify({ v: 1, ...facts }));
    // The same entry rules as the builder's: a link out of its top folder.
    symlinkSync("../../etc", join(stage, "app/out"));
    expect(() => checkRelease(stage, pins)).toThrow(/the release breaks the entry rules: app\/out: a link out of app\//);
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

describe("a published release: its end time and its notes for a person", () => {
  const BUILT = "2026-11-26T19:00:00Z";
  it("expires: null for a local release; else after builtAt and at most 400 days after it, in the index's time form", () => {
    expect(expiresRefusal(null, BUILT)).toBeNull();
    expect(expiresAt(BUILT, 90)).toBe("2027-02-24T19:00:00Z");
    expect(expiresRefusal(expiresAt(BUILT, 90), BUILT)).toBeNull();
    expect(expiresRefusal(expiresAt(BUILT, EXPIRES_DAYS_MAX), BUILT)).toBeNull();
    expect(expiresRefusal("2027-12-31T19:00:01Z", BUILT)).toBe("expires is more than 400 days after builtAt");
    expect(expiresRefusal(BUILT, BUILT)).toBe("expires is not after builtAt");
    expect(expiresRefusal("2026-11-25T19:00:00Z", BUILT)).toBe("expires is not after builtAt");
    for (const bad of ["2027-02-24T19:00:00.000Z", "2027-02-24 19:00:00Z", "2027-02-30T19:00:00Z", 90, ""]) expect([bad, expiresRefusal(bad, BUILT)]).toEqual([bad, "expires is not null or a UTC time in seconds"]);
    for (const bad of ["0", "401", "9x", "-1", "1.5"]) expect(() => expiresAt(BUILT, bad)).toThrow(/--expires-days is not a whole number from 1 to 400/);
  });

  it("checkIndex takes an end time in range, and refuses one out of it", () => {
    const i = { v: 1, channel: "test", version: 840, commit: COMMIT, builtAt: BUILT, file: tarName(840, COMMIT), size: 1, sha256: "a".repeat(64), arch: "x86_64", os: "ubuntu-24.04",
      node: "24.22.3", pnpm: "10.34.9", gh: "2.105.0", minFrom: 0, security: false, expires: null as string | null, claude: null,
      rootParts: ROOT_PARTS.map((r) => ({ path: r.path, sha256: "b".repeat(64), from: r.from })), revoke: [], hold: false, notes: ["One line."] };
    expect(checkIndex(i).expires).toBeNull();
    expect(checkIndex({ ...i, expires: "2027-02-24T19:00:00Z" }).expires).toBe("2027-02-24T19:00:00Z");
    expect(() => checkIndex({ ...i, expires: "2028-02-24T19:00:00Z" })).toThrow("expires is more than 400 days after builtAt");
    expect(() => checkIndex({ ...i, expires: "2026-11-26T18:59:59Z" })).toThrow("expires is not after builtAt");
    expect(() => checkFacts({ ...facts, expires: "soon" })).toThrow("expires is not null or a UTC time in seconds");
  });

  it("the notes: 1 to 5 lines of plain text, each at most 200 characters; blank lines are left out", () => {
    expect(checkNotes("ChoiBot updates itself now.\n\nThe Settings page shows the version.\n")).toEqual(["ChoiBot updates itself now.", "The Settings page shows the version."]);
    expect(checkNotes("Fix: the login works again.")).toEqual(["Fix: the login works again."]);
    expect(checkNotes(Array.from({ length: NOTES_SHOWN }, (_, n) => `Line ${n}.`).join("\n"))).toHaveLength(NOTES_SHOWN);
    const no: [string, string][] = [
      ["", "the notes have 0 lines: give 1 to 5"],
      ["\n \n", "the notes have 0 lines: give 1 to 5"],
      [Array.from({ length: 6 }, (_, n) => `Line ${n}.`).join("\n"), "the notes have 6 lines: give 1 to 5"],
      [`One.\n${"x".repeat(201)}`, "notes line 2 is longer than 200 characters"],
      ["One.\r\nTwo.", "notes line 1 holds a control character"],
      ["A bell \u0007 here.", "notes line 1 holds a control character"],
      ["The fix of #153 is in.", 'notes line 1 holds a "#<number>" of the private repo: say what changed in words'],
      ["feat(update): the Update button", 'notes line 1 is a commit subject ("feat(…): …"): write it for a person'],
      ["One.\nfix: a thing", 'notes line 2 is a commit subject ("feat(…): …"): write it for a person'],
      ["  Indented.", "notes line 1 starts or ends with white space"],
    ];
    for (const [text, why] of no) expect(() => checkNotes(text)).toThrow(why);
  });
});
