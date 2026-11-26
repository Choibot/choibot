// The token of the console's own account (consoletoken.ts).
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONSOLE_TOKEN_RE, makeConsoleToken, readConsoleToken } from "./consoletoken.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "console-token-")); dirs.push(d); return d; };

describe("the console token", () => {
  it("is 32 random bytes in a 0600 file; the console keeps only its hash", () => {
    const file = join(tmp(), "chief", "console-token");
    const t = makeConsoleToken(file);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    const text = readFileSync(file, "utf8").trim();
    expect(text).toMatch(CONSOLE_TOKEN_RE);
    expect(t.verify(text)).toBe(true);
    expect(t.verify(`${text.slice(0, 42)}x`)).toBe(false);
    expect(t.verify("")).toBe(false);
    expect(JSON.stringify(t)).not.toContain(text);
  });

  it("is new at each start: the old one stops at once", () => {
    const file = join(tmp(), "console-token");
    makeConsoleToken(file);
    const old = readFileSync(file, "utf8").trim();
    const next = makeConsoleToken(file);
    expect(next.verify(old)).toBe(false);
    expect(next.verify(readFileSync(file, "utf8").trim())).toBe(true);
  });

  it("replaces a planted link by a new file, never writes through it", () => {
    const d = tmp();
    const target = join(d, "elsewhere");
    writeFileSync(target, "keep\n");
    symlinkSync(target, join(d, "console-token"));
    makeConsoleToken(join(d, "console-token"));
    expect(readFileSync(target, "utf8")).toBe("keep\n");
    expect(lstatSync(join(d, "console-token")).isFile()).toBe(true);
  });

  it("the CLI reads it only from a plain file of the right form", () => {
    const d = tmp();
    const file = join(d, "console-token");
    expect(readConsoleToken(file)).toBeUndefined();
    writeFileSync(file, "not a token\n");
    expect(readConsoleToken(file)).toBeUndefined();
    const t = "a".repeat(43);
    writeFileSync(join(d, "real"), `${t}\n`);
    rmSync(file);
    symlinkSync(join(d, "real"), file);
    expect(readConsoleToken(file)).toBeUndefined();
    rmSync(file);
    writeFileSync(file, `${t}\n`, { mode: 0o600 });
    expect(readConsoleToken(file)).toBe(t);
  });
});
