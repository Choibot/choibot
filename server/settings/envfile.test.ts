// server/settings/envfile.test.ts — the one server-side writer of the console's .env: only the
// given keys change, every other byte stays, the write is atomic with one backup, the mode stays,
// a symlink is never followed. Temp dirs only; made-up values.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvWriteError, patchEnvText, readEnvKeys, writeEnvFile, envFileWritable, envWriteBusy } from "./envfile.js";

const TOKEN = "123456789:AAH-made-up-token-for-tests-ONLY_x";
const NEW_TOKEN = "987654321:BBH-another-made-up-token-for-tests_y";

const SAMPLE = [
  "# Console",
  "CONSOLE_COOKIE_SECRET=not-a-real-secret-0123456789abcdef",
  "PORT=3100",
  "",
  "# Telegram",
  `TELEGRAM_BOT_TOKEN=${TOKEN}`,
  "# TELEGRAM_MASTER_CHAT_ID=-1001",
  "TELEGRAM_MASTER_CHAT_ID=-1001234567890",
  "AGENT_ENV_PASS=",
  "TELEGRAM_MASTER_THREAD_ID=2",
  "",
].join("\n");

describe("patchEnvText", () => {
  it("changes only the given keys; comments, blank lines and other keys stay byte for byte", () => {
    const out = patchEnvText(SAMPLE, { TELEGRAM_MASTER_THREAD_ID: "5" });
    expect(out).toBe(SAMPLE.replace("TELEGRAM_MASTER_THREAD_ID=2", "TELEGRAM_MASTER_THREAD_ID=5"));
  });
  it("adds a new key at the end, removes a key, keeps a commented line and the empty AGENT_ENV_PASS line", () => {
    const out = patchEnvText(SAMPLE, { TELEGRAM_CRON_CHAT_ID: "-1009", TELEGRAM_MASTER_CHAT_ID: null });
    expect(out).toContain("# TELEGRAM_MASTER_CHAT_ID=-1001\n");
    expect(out).not.toMatch(/^TELEGRAM_MASTER_CHAT_ID=/m);
    expect(out).toContain("\nAGENT_ENV_PASS=\n");
    expect(out.endsWith("TELEGRAM_CRON_CHAT_ID=-1009\n")).toBe(true);
  });
  it("drops later duplicates of a set key (systemd reads the last one)", () => {
    const out = patchEnvText("A=1\nTELEGRAM_CHAT_ID=1\nB=2\nTELEGRAM_CHAT_ID=2\n" as string, { TELEGRAM_CRON_THREAD_ID: "3" });
    expect(out).toBe("A=1\nTELEGRAM_CHAT_ID=1\nB=2\nTELEGRAM_CHAT_ID=2\nTELEGRAM_CRON_THREAD_ID=3\n");
    const dup = patchEnvText("TELEGRAM_CRON_THREAD_ID=1\nX=1\nTELEGRAM_CRON_THREAD_ID=2\n", { TELEGRAM_CRON_THREAD_ID: "9" });
    expect(dup).toBe("TELEGRAM_CRON_THREAD_ID=9\nX=1\n");
  });
  it("keeps CRLF line ends and a file with no last newline", () => {
    expect(patchEnvText("A=1\r\nTELEGRAM_CRON_THREAD_ID=1\r\n", { TELEGRAM_CRON_THREAD_ID: "2" })).toBe("A=1\r\nTELEGRAM_CRON_THREAD_ID=2\r\n");
    expect(patchEnvText("A=1", { TELEGRAM_CRON_THREAD_ID: "2" })).toBe("A=1\nTELEGRAM_CRON_THREAD_ID=2\n");
  });
  it("refuses a key outside the allow-list and a value with an unsafe character, naming no value", () => {
    expect(() => patchEnvText(SAMPLE, { PORT: "1" } as never)).toThrow(EnvWriteError);
    try { patchEnvText(SAMPLE, { TELEGRAM_CHAT_ID: "1" } as never); } catch (e) { expect(String(e)).toContain("TELEGRAM_CHAT_ID"); }
    for (const bad of ["a b", "x\nPORT=1", "$(id)", "a\"b", ""]) {
      let msg = "";
      try { patchEnvText(SAMPLE, { TELEGRAM_BOT_TOKEN: bad }); } catch (e) { msg = String(e); }
      expect(msg).toContain("TELEGRAM_BOT_TOKEN");
      if (bad) expect(msg).not.toContain(bad);
    }
  });
  it("readEnvKeys: the writable keys only, the last line wins", () => {
    expect(readEnvKeys(SAMPLE)).toEqual({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_MASTER_CHAT_ID: "-1001234567890", TELEGRAM_MASTER_THREAD_ID: "2" });
  });
});

describe("writeEnvFile", () => {
  let dir: string;
  let env: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "envfile-"));
    env = join(dir, ".env");
    await writeFile(env, SAMPLE, { mode: 0o600 });
    await chmod(env, 0o600);
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("writes the change, keeps the mode, keeps one backup with the old text and the same mode, leaves no temp file", async () => {
    await writeEnvFile(env, { TELEGRAM_BOT_TOKEN: NEW_TOKEN });
    expect(await readFile(env, "utf8")).toBe(SAMPLE.replace(TOKEN, NEW_TOKEN));
    expect((await stat(env)).mode & 0o777).toBe(0o600);
    expect(await readFile(`${env}.bak`, "utf8")).toBe(SAMPLE);
    expect((await stat(`${env}.bak`)).mode & 0o777).toBe(0o600);
    await writeEnvFile(env, { TELEGRAM_MASTER_THREAD_ID: "7" });
    // One backup, overwritten: it holds the text before the last write.
    expect(await readFile(`${env}.bak`, "utf8")).toBe(SAMPLE.replace(TOKEN, NEW_TOKEN));
    expect((await readdir(dir)).sort()).toEqual([".env", ".env.bak"]);
  });
  it("keeps a stricter mode as it is", async () => {
    await chmod(env, 0o400 | 0o200);
    await writeEnvFile(env, { TELEGRAM_MASTER_THREAD_ID: "7" });
    expect((await stat(env)).mode & 0o777).toBe(0o600);
  });
  it("never writes through a symlink: refused, the target unchanged", async () => {
    const real = join(dir, "real.env");
    await writeFile(real, SAMPLE, { mode: 0o600 });
    const link = join(dir, "link.env");
    await symlink(real, link);
    await expect(writeEnvFile(link, { TELEGRAM_MASTER_THREAD_ID: "7" })).rejects.toThrow(/symlink/);
    expect(await readFile(real, "utf8")).toBe(SAMPLE);
    expect(await envFileWritable(link)).toEqual({ ok: false, why: "the settings file is a symlink" });
  });
  it("refuses a file of another owner and a missing file; nothing is written", async () => {
    await expect(writeEnvFile(env, { TELEGRAM_MASTER_THREAD_ID: "7" }, { uid: 424242 })).rejects.toThrow(/another user/);
    expect(await readFile(env, "utf8")).toBe(SAMPLE);
    await expect(writeEnvFile(join(dir, "none"), { TELEGRAM_MASTER_THREAD_ID: "7" })).rejects.toThrow(/no .env file/);
    expect((await readdir(dir)).sort()).toEqual([".env"]);
  });
  it("a bad value is refused before any write (no backup either)", async () => {
    await expect(writeEnvFile(env, { TELEGRAM_BOT_TOKEN: "bad value" })).rejects.toThrow(EnvWriteError);
    expect(await readFile(env, "utf8")).toBe(SAMPLE);
    expect((await readdir(dir)).sort()).toEqual([".env"]);
  });
  it("two writes never interleave: both land, in order", async () => {
    const a = writeEnvFile(env, { TELEGRAM_MASTER_THREAD_ID: "7" });
    expect(envWriteBusy()).toBe(true);
    const b = writeEnvFile(env, { TELEGRAM_CRON_THREAD_ID: "4" });
    await Promise.all([a, b]);
    const text = await readFile(env, "utf8");
    expect(text).toContain("TELEGRAM_MASTER_THREAD_ID=7\n");
    expect(text).toContain("TELEGRAM_CRON_THREAD_ID=4\n");
    expect(envWriteBusy()).toBe(false);
  });
  it("an error text never holds a value of the file", async () => {
    let msg = "";
    try { await writeEnvFile(env, { TELEGRAM_MASTER_THREAD_ID: "7" }, { uid: 1 }); } catch (e) { msg = String(e); }
    expect(msg).not.toContain(TOKEN);
    expect(msg).not.toContain("not-a-real-secret");
  });
});
