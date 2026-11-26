// server/gh/appstore.test.ts — the token file: folder 0700 and file 0600 of this user, a whole
// pair or none, and a file that is not that (a link, rights for others, junk) is never used.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TokenFile, parseStored, type StoredTokens } from "./appstore.js";
import { FAKE_ACCESS, FAKE_REFRESH } from "./testkit.js";

const PAIR: StoredTokens = {
  clientId: "Iv23liFAKEclient01", accessToken: FAKE_ACCESS, accessExpiresAt: 1_800_028_800_000,
  refreshToken: FAKE_REFRESH, refreshExpiresAt: 1_815_897_600_000, savedAt: 1_800_000_000_000,
};
let root: string;
let logs: string[];
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "gh-appstore-")); logs = []; });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
const store = (dir = join(root, "github-app")) => new TokenFile(dir, (s) => logs.push(s));

describe("TokenFile", () => {
  it("writes the pair as a 0600 file in a 0700 folder and reads it back", async () => {
    const s = store();
    expect(await s.read()).toBeNull();
    await s.write(PAIR);
    expect(statSync(join(root, "github-app")).mode & 0o777).toBe(0o700);
    expect(statSync(s.path).mode & 0o777).toBe(0o600);
    expect(await s.read()).toEqual(PAIR);
    // No temp file stays.
    expect(readdirSync(join(root, "github-app"))).toEqual(["token.json"]);
  });

  it("replaces the old pair as a whole", async () => {
    const s = store();
    await s.write(PAIR);
    await s.write({ ...PAIR, accessToken: "ghu_FAKEsecond00000000000000000000000", savedAt: PAIR.savedAt + 1 });
    expect((await s.read())?.accessToken).toBe("ghu_FAKEsecond00000000000000000000000");
  });

  it("closes a folder that others can enter", async () => {
    const dir = join(root, "github-app");
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    await store(dir).write(PAIR);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("never uses a file with rights for others, a link or junk", async () => {
    const s = store();
    await s.write(PAIR);
    chmodSync(s.path, 0o644);
    expect(await s.read()).toBeNull();
    expect(logs.at(-1)).toMatch(/not a 0600 file/);

    rmSync(s.path);
    const elsewhere = join(root, "elsewhere.json");
    writeFileSync(elsewhere, JSON.stringify({ v: 1, ...PAIR }), { mode: 0o600 });
    symlinkSync(elsewhere, s.path);
    expect(await s.read()).toBeNull();
    expect(logs.at(-1)).toMatch(/cannot be opened/);

    rmSync(s.path);
    writeFileSync(s.path, "{not json", { mode: 0o600 });
    expect(await s.read()).toBeNull();
    expect(logs.at(-1)).toMatch(/no usable token/);
  });

  it("never uses a folder that is a link", async () => {
    const real = join(root, "real");
    mkdirSync(real, { mode: 0o700 });
    const link = join(root, "github-app");
    symlinkSync(real, link);
    const s = store(link);
    expect(await s.read()).toBeNull();
    await expect(s.write(PAIR)).rejects.toThrow(/not usable/);
    expect(existsSync(join(real, "token.json"))).toBe(false);
  });

  it("refuses to write a pair that is not usable, and no log line holds a token", async () => {
    await expect(store().write({ ...PAIR, accessToken: "has space 0000000000000" })).rejects.toThrow("not a usable token pair");
    expect(logs.join("\n")).not.toMatch(/gh[ur]_/);
  });

  it("remove() deletes the file and is quiet when there is none", async () => {
    const s = store();
    await s.write(PAIR);
    await s.remove();
    await s.remove();
    expect(await s.read()).toBeNull();
  });
});

describe("parseStored", () => {
  it("takes a pair with no ends, refuses a refresh token with no end", () => {
    const none = { v: 1, ...PAIR, accessExpiresAt: null, refreshToken: null, refreshExpiresAt: null };
    expect(parseStored(none)).toEqual({ ...PAIR, accessExpiresAt: null, refreshToken: null, refreshExpiresAt: null });
    expect(parseStored({ v: 1, ...PAIR, refreshExpiresAt: null })).toBeNull();
    expect(parseStored({ v: 2, ...PAIR })).toBeNull();
  });
});
