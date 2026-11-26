// bin/lib/pair.test.ts — `pair`: the code of the box for the first device of a new install,
// and what the command says on every other console. Temp dirs only.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeviceStore } from "../../server/chief/auth.js";
import { BoxCodes } from "../../server/chief/firstrun.js";
import { chiefPaths } from "../../server/chief/paths.js";
import { NEW_NAMES, OLD_NAMES } from "../../server/names.mjs";
import { cli } from "../../server/setup/steps.js";
import { PAIR_NOT_HUMAN, firstDeviceLines, pairWay, runPair } from "./pair.js";

let repo: string;
let data: string;
let out: string[];
let err: string[];

// The settings `setup --auto` writes on a new install, with the data in a temp dir.
const auto = (): string => `CHIEF_ENABLED=1\nCHIEF_USER_AUTH=log\nCHIEF_CONSOLE_URL=http://127.0.0.1:45999\nCHIEF_DATA_DIR=${data}\n`;
// The shell of a person: no marker of an agent.
const shell = { HOME: "/nonexistent" };
const CODE_RE = /^ {7}([0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4})$/m;

const pair = (o: { names?: { legacy: boolean }; env?: Record<string, string>; tty?: boolean } = {}) =>
  runPair({ repoDir: repo, env: o.env ?? shell, stderrIsTTY: o.tty ?? true, names: o.names ?? NEW_NAMES, out: (s) => out.push(s), err: (s) => err.push(s) });

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "pair-repo-"));
  data = mkdtempSync(join(tmpdir(), "pair-data-"));
  out = [];
  err = [];
  writeFileSync(join(repo, ".env"), auto());
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
});

describe("pair", () => {
  it("a new install with no device: prints a code that the console takes one time", async () => {
    expect(await pair()).toBe(0);
    const code = CODE_RE.exec(out.join("\n"))?.[1];
    expect(code).toBeDefined();
    expect(out.join("\n")).toContain(`For a new one: ${cli("pair")}`);
    expect(readFileSync(chiefPaths(data).pairCode, "utf8")).not.toContain(code!.replace("-", ""));
    const codes = new BoxCodes(chiefPaths(data).pairCode);
    expect(await codes.claim(code!)).toBe("ok");
    expect(await codes.claim(code!)).toBe("gone");
  });

  it("a second run makes a new code, and the first one stops", async () => {
    await pair();
    await pair();
    const [first, second] = out.map((t) => CODE_RE.exec(t)![1]);
    expect(first).not.toBe(second);
    const codes = new BoxCodes(chiefPaths(data).pairCode);
    expect(await codes.claim(first)).toBe("wrong");
    expect(await codes.claim(second)).toBe("ok");
  });

  it("gives no code in the shell of an agent, or with no terminal", async () => {
    for (const o of [{ env: { ...shell, CHOIBOT_AGENT_ID: "a1" } }, { env: { ...shell, CLAUDECODE: "1" } }, { tty: false }]) {
      expect(await pair(o)).toBe(1);
    }
    expect(err).toEqual([PAIR_NOT_HUMAN, PAIR_NOT_HUMAN, PAIR_NOT_HUMAN]);
    expect(out).toEqual([]);
    expect(existsSync(chiefPaths(data).pairCode)).toBe(false);
  });

  it("a device is paired already: no code, the way of today", async () => {
    await new DeviceStore(chiefPaths(data).devices).add("laptop");
    expect(await pair()).toBe(0);
    expect(out.join("\n")).toContain("brain pair <name>");
    expect(existsSync(chiefPaths(data).pairCode)).toBe(false);
  });


  it("a console that pairs through Telegram says so, on a new install too", async () => {
    const tg = { CHIEF_ENABLED: "1", CHIEF_CONSOLE_URL: "http://x", TELEGRAM_BOT_TOKEN: "1:x", TELEGRAM_ISSUES_USER_ID: "7", MASTER_TG_CHAT_ID: "-100", MASTER_TG_THREAD_ID: "2", CHIEF_DATA_DIR: data };
    const way = await pairWay(tg, NEW_NAMES);
    // The Master topic keys of this checkout decide if the mode is complete: either way, no code.
    expect(["telegram", "off"]).toContain(way);
    expect(await pairWay({ ...tg, CHIEF_USER_AUTH: "telegram" }, OLD_NAMES)).toBe(way);
  });

  it("the Queue is off: pairing is off", async () => {
    writeFileSync(join(repo, ".env"), "PORT=45999\n");
    expect(await pair()).toBe(1);
    expect(err).toEqual(["Device pairing is off on this console."]);
  });
});

describe("the end of setup --auto", () => {
  it("prints the code for the first device of a new install", async () => {
    const text = await firstDeviceLines({ repoDir: repo, env: shell, stderrIsTTY: true, names: NEW_NAMES });
    expect(text).toMatch(CODE_RE);
    expect(await new BoxCodes(chiefPaths(data).pairCode).claim(CODE_RE.exec(text!)![1])).toBe("ok");
  });
  it("names the command when no person reads the terminal", async () => {
    expect(await firstDeviceLines({ repoDir: repo, env: { ...shell, CLAUDECODE: "1" }, stderrIsTTY: true, names: NEW_NAMES })).toBe(`To pair your first device, run: ${cli("pair")}`);
    expect(existsSync(chiefPaths(data).pairCode)).toBe(false);
  });
  it("prints nothing when a device is paired", async () => {
    await new DeviceStore(chiefPaths(data).devices).add("laptop");
    expect(await firstDeviceLines({ repoDir: repo, env: shell, stderrIsTTY: true, names: NEW_NAMES })).toBeNull();
  });
});
