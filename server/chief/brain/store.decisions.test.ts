import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DECISION_TEXT_MAX, DecisionLog, redactSecrets, type DecisionLine } from "./store.js";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chief-decisions-"));
  file = join(dir, "brain", "decisions.jsonl");
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const base = { via: "composer", by: "user", correction: null } as const;

function fileLines(): DecisionLine[] {
  return readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as DecisionLine);
}

async function stored(text: string): Promise<string> {
  const log = new DecisionLog(file, { now: () => 1000 });
  const line = await log.append({ ...base, text });
  return line.text;
}

describe("DecisionLog redaction (spec §6.2)", () => {
  it("redacts an sk- key in place and keeps the metric fields", async () => {
    const log = new DecisionLog(file, { now: () => 1000 });
    await log.append({
      via: "queue-tab", by: "user", text: "key sk-abcdefghijklmnop",
      value: "B", correction: true, reason: "differs-from-recommend", itemId: "q12345678",
    });
    const [line] = fileLines();
    expect(line).toMatchObject({
      at: 1000, via: "queue-tab", by: "user", value: "B", correction: true,
      reason: "differs-from-recommend", itemId: "q12345678",
    });
    expect(line.text).toBe("key [redacted]");
    expect(log.redactions()).toBe(1);
  });

  it("keeps an absolute path unchanged", async () => {
    const text = "see /home/dev/workspace/choibot/server";
    expect(await stored(text)).toBe(text);
    const long = "edit /home/dev/workspace/choibot/console/server/chief/brain/store/Decisions2";
    expect(await stored(long)).toBe(long);
  });

  it("keeps a 40-hex git SHA unchanged", async () => {
    const text = "fix 0123456789abcdef0123456789abcdef01234567";
    expect(await stored(text)).toBe(text);
  });

  it("redacts a 32-hex run", async () => {
    expect(await stored("token 0123456789abcdef0123456789abcdef ok")).toBe("token [redacted] ok");
  });

  it("redacts a hex run of 41 characters (not a SHA)", async () => {
    expect(await stored("x 0123456789abcdef0123456789abcdef012345678 y")).toBe("x [redacted] y");
  });

  it("redacts a Telegram bot token", async () => {
    expect(await stored("bot 123456789:AAH-abcdefghijklmnopqrstuvwxyz0123 end")).toBe("bot [redacted] end");
  });

  it("redacts a private-key header", async () => {
    expect(await stored("-----BEGIN OPENSSH PRIVATE KEY-----")).toBe("[redacted]");
  });

  it("redacts a 44-char mixed-case base64 run", async () => {
    expect(await stored("tok dGhpc0lzQVNlY3JldFRva2VuMTIzNDU2Nzg5MEFCQ0RF")).toBe("tok [redacted]");
  });

  it("redacts a base64 run that holds / and =", async () => {
    // "/" splits the [A-Za-z0-9+_-]{40,} pattern, so only the base64 rule matches.
    expect(await stored("b dGhpc0lzQVNlY3Jl/dFRva2VuMTIz+NDU2Nzg5MEFCQ0RF== e")).toBe("b [redacted] e");
  });

  it("keeps a base64-class run without a digit", async () => {
    const text = "p abcdefghijklmnopqrst/ABCDEFGHIJKLMNOPQRST";
    expect(await stored(text)).toBe(text);
  });

  it("redacts a long [A-Za-z0-9+_-] run", async () => {
    expect(await stored("id abcdefghij_abcdefghij-abcdefghij_abcdefghij z")).toBe("id [redacted] z");
  });

  it("redacts postgres and postgresql URLs", async () => {
    expect(await stored("postgres://u:p@h/db")).toBe("[redacted]");
    expect(await stored("db postgresql://u:p@h:5432/db?x=1 now")).toBe("db [redacted] now");
  });

  it("redacts the userinfo of an http(s) URL", async () => {
    expect(await stored("https://u:p@host/")).toBe("[redacted]host/");
    expect(await stored("http://user:pass@h.io/x")).toBe("[redacted]h.io/x");
  });

  it("redacts the userinfo of a URL with an empty user", async () => {
    expect(await stored("https://:pass:word@h")).toBe("[redacted]h");
    expect(await stored("https://:token@h/x")).toBe("[redacted]h/x");
  });

  it("counts every redacted span", async () => {
    const log = new DecisionLog(file, { now: () => 1000 });
    await log.append({ ...base, text: "a sk-abcdefghijklmnop b postgres://u:p@h/db" });
    await log.append({ ...base, text: "nothing here" });
    expect(log.redactions()).toBe(2);
    expect(redactSecrets("a sk-abcdefghijklmnop b postgres://u:p@h/db")).toEqual({
      text: "a [redacted] b [redacted]", count: 2,
    });
  });
});

describe("DecisionLog cap, at and file", () => {
  it("stores a 600-char text at 500", async () => {
    const text = "word ".repeat(120);
    expect(text).toHaveLength(600);
    const out = await stored(text);
    expect(DECISION_TEXT_MAX).toBe(500);
    expect(out).toHaveLength(500);
    expect(out).toBe(text.slice(0, 500));
  });

  it("redacts, then cuts at 500, then redacts again", async () => {
    const secret = "sk-" + "A".repeat(100);
    const text = secret + " " + "word ".repeat(100);
    expect(await stored(text)).toBe(("[redacted] " + "word ".repeat(100)).slice(0, 500));
  });

  it("never stores half of a surrogate pair at the cut", async () => {
    const pre = "ab ".repeat(166) + "a";
    expect(pre).toHaveLength(499);
    expect(await stored(pre + "\u{1F600}" + "tail")).toBe(pre);
  });

  it("gives two appends with the same now at and at + 1", async () => {
    const log = new DecisionLog(file, { now: () => 5000 });
    const a = await log.append({ ...base, text: "one" });
    const b = await log.append({ ...base, text: "two" });
    expect([a.at, b.at]).toEqual([5000, 5001]);
    expect(fileLines().map((l) => l.at)).toEqual([5000, 5001]);
  });

  it("keeps at unique for concurrent appends and an explicit at", async () => {
    const log = new DecisionLog(file, { now: () => 7000 });
    const lines = await Promise.all([
      log.append({ ...base, text: "a" }),
      log.append({ ...base, text: "b" }),
      log.append({ ...base, text: "c", at: 7000 }),
    ]);
    expect(lines.map((l) => l.at)).toEqual([7000, 7001, 7002]);
    expect(fileLines().map((l) => l.at)).toEqual([7000, 7001, 7002]);
  });

  it("keeps at unique against lines already in the file (restart)", async () => {
    await new DecisionLog(file, { now: () => 9000 }).append({ ...base, text: "before" });
    const later = new DecisionLog(file, { now: () => 9000 });
    expect((await later.append({ ...base, text: "after" })).at).toBe(9001);
  });

  it("reads the lines back", async () => {
    const log = new DecisionLog(file, { now: () => 1 });
    expect(await log.read()).toEqual([]);
    await log.append({ ...base, text: "hi", agentId: "w1" });
    expect(await log.read()).toEqual([{ ...base, at: 1, text: "hi", agentId: "w1" }]);
  });

  it("writes the file with mode 0600", async () => {
    await stored("hello");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("lock runs on the append chain", async () => {
    const log = new DecisionLog(file, { now: () => 1 });
    const order: string[] = [];
    let release!: () => void;
    const held = log.lock(async () => {
      order.push("lock-start");
      await new Promise<void>((r) => { release = r; });
      order.push("lock-end");
    });
    const app = log.append({ ...base, text: "x" }).then(() => order.push("append"));
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["lock-start"]);
    release();
    await Promise.all([held, app]);
    expect(order).toEqual(["lock-start", "lock-end", "append"]);
  });
});

// A secret that crosses the 500-char cut must not leave a fragment in clear.
describe("DecisionLog across the 500-char cut", () => {
  const pad = (n: number) => "w ".repeat(n).slice(0, n - 1) + " ";
  const B64_A = "dGhpc0lzQVNlY3JldFRva2VuMTIzNDU2Nzg5MEFCQ0RF";
  const B64_B = "QW5vdGhlclNlY3JldEtleVZhbHVlMDEyMzQ1Njc4OUFC";
  const HEX64 = "0123456789abcdef".repeat(4);
  const HEX32 = "0123456789abcdef".repeat(2);
  const SHA40 = "0123456789abcdef0123456789abcdef01234567";
  const BOT = "123456789:AAH-abcdefghijklmnopqrstuvwxyz0123";

  async function storeOne(text: string): Promise<{ text: string; count: number }> {
    const log = new DecisionLog(file, { now: () => 1000 });
    const line = await log.append({ ...base, text });
    return { text: line.text, count: log.redactions() };
  }

  it("redacts a 44-char base64 run that crosses the cut (39 chars before it)", async () => {
    const out = await storeOne(pad(461) + B64_B + " tail");
    expect(out.text).not.toContain(B64_B.slice(0, 39));
    expect(out).toEqual({ text: pad(461) + "[redacted] tail", count: 1 });
  });

  it("redacts a 64-hex run cut to exactly 40 hex", async () => {
    const out = await storeOne(pad(460) + HEX64 + " end");
    expect(out.text).not.toContain(HEX64.slice(0, 40));
    expect(out).toEqual({ text: pad(460) + "[redacted] end", count: 1 });
  });

  it("redacts a 32-hex run cut to 31 hex", async () => {
    const out = await storeOne(pad(469) + HEX32 + " end");
    expect(out.text).not.toContain(HEX32.slice(0, 31));
    expect(out).toEqual({ text: pad(469) + "[redacted] end", count: 1 });
  });

  it("redacts URL userinfo whose @ is past the cut", async () => {
    const out = await storeOne(pad(480) + "https://user:secretpass@host/x");
    expect(out.text).not.toContain("secret");
    expect(out.text).not.toContain("user:");
    expect(out).toEqual({ text: pad(480) + "[redacted]host/x", count: 1 });
  });

  it("redacts a bot token cut after 29 chars", async () => {
    const out = await storeOne(pad(471) + BOT + " end");
    expect(out.text).not.toContain(BOT.slice(0, 29));
    expect(out).toEqual({ text: pad(471) + "[redacted] end", count: 1 });
  });

  it("never splits a [redacted] token at the cut", async () => {
    const out = await storeOne(pad(495) + B64_B + " tail");
    expect(out).toEqual({ text: pad(495), count: 0 });
  });

  it("redacts a SHA that the cut leaves at 32-39 hex", async () => {
    const out = await storeOne(pad(465) + SHA40 + " end");
    expect(out).toEqual({ text: pad(465) + "[redacted]", count: 1 });
  });

  it("counts the redactions of both passes", async () => {
    const out = await storeOne("a sk-abcdefghijklmnop " + pad(452) + SHA40 + " end");
    expect(out).toEqual({ text: "a [redacted] " + pad(452) + "[redacted]", count: 2 });
  });

  it("counts once a pass-2 span that holds a pass-1 token", async () => {
    // Pass 1 redacts the base64 run (it holds "/"); then the URL userinfo matches.
    const b64Slash = "dGhpc0lzQVNlY3Jl/dFRva2VuMTIz+NDU2Nzg5MEFCQ0RF==";
    expect(await storeOne("https://u-" + b64Slash + ":p@h")).toEqual({ text: "[redacted]h", count: 1 });
  });

  it("does not count a literal [redacted] in the user's text", async () => {
    expect(await storeOne("[redacted] is fine")).toEqual({ text: "[redacted] is fine", count: 0 });
  });

  it("drops a secret that the redaction window cuts when the window end is visible", async () => {
    // Pass 1 shrinks 33 runs of 44 chars to 10, so the window end (1524) lands
    // inside the stored text; B64_B crosses it with 39 chars inside.
    const prefix = (B64_A + " ").repeat(33);
    const text = prefix + B64_B + " end";
    expect(text.length).toBeGreaterThan(DECISION_TEXT_MAX + 1024);
    const out = await storeOne(text);
    expect(out.text).not.toContain(B64_B.slice(0, 20));
    expect(out).toEqual({ text: "[redacted] ".repeat(33), count: 33 });
  });

  it("stores at most 500 chars of a very long text", async () => {
    const out = await storeOne("word ".repeat(40_000));
    expect(out.text).toBe("word ".repeat(100));
  });

  it("matches URL userinfo in linear time on long runs of ':'", () => {
    const run4k = ("http://" + "a:".repeat(2000)).repeat(2).slice(0, 4000);
    let t0 = performance.now();
    expect(redactSecrets(run4k).count).toBe(0);
    expect(performance.now() - t0).toBeLessThan(200);
    t0 = performance.now();
    expect(redactSecrets("http://" + "a:".repeat(20_000)).count).toBe(0);
    expect(performance.now() - t0).toBeLessThan(200);
    expect(redactSecrets("http://" + "a:".repeat(2000) + "@h").text).toBe("[redacted]h");
  });

  it("matches bot tokens in linear time on long digit runs", () => {
    const t0 = performance.now();
    expect(redactSecrets("1".repeat(16_000) + ":x").count).toBe(1); // the hex rule matches the run
    expect(performance.now() - t0).toBeLessThan(50);
    expect(redactSecrets("a 1".repeat(5000) + " 1234567:" + "A".repeat(30))).toEqual({
      text: "a 1".repeat(5000) + " [redacted]", count: 1,
    });
  });
});
