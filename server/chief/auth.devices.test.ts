import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEVICE_LABEL_RE, DeviceStore, type Device } from "./auth.js";

vi.mock("node:crypto", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:crypto")>();
  return { ...real, timingSafeEqual: vi.fn(real.timingSafeEqual), randomBytes: vi.fn(real.randomBytes) };
});

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chief-devices-"));
  file = join(dir, "user-devices.json");
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const readDevices = (): Device[] => JSON.parse(readFileSync(file, "utf8")) as Device[];

type FakeTimer = { fn: () => void; ms: number; cleared: boolean };
function fakeTimers() {
  const timers: FakeTimer[] = [];
  const setTimer = (fn: () => void, ms: number) => {
    const t: FakeTimer = { fn, ms, cleared: false };
    timers.push(t);
    return { clear: () => { t.cleared = true; } };
  };
  return { timers, setTimer };
}

describe("DeviceStore", () => {
  it("add re-draws until the token does not start with a dash", async () => {
    vi.mocked(randomBytes)
      .mockImplementationOnce(((n: number) => Buffer.alloc(n, 0xf8)) as typeof randomBytes)
      .mockImplementationOnce(((n: number) => Buffer.alloc(n, 0x01)) as typeof randomBytes);
    expect(Buffer.alloc(32, 0xf8).toString("base64url")[0]).toBe("-");
    const store = new DeviceStore(file, { setTimer: fakeTimers().setTimer });
    const token = await store.add("laptop");
    expect(token).toBe(Buffer.alloc(32, 0x01).toString("base64url"));
    expect(readDevices()[0].sha256).toBe(sha(token));
  });
  it("add never returns a token starting with a dash", async () => {
    const store = new DeviceStore(file, { setTimer: fakeTimers().setTimer });
    for (let i = 0; i < 200; i++) expect((await store.add("laptop"))[0]).not.toBe("-");
  });
  it("add returns a 43-char base64url token and stores only its sha256", async () => {
    const store = new DeviceStore(file, { setTimer: fakeTimers().setTimer });
    const token = await store.add("laptop");
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const raw = readFileSync(file, "utf8");
    expect(raw).toContain(sha(token));
    expect(raw).not.toContain(token);
    expect(readDevices()).toEqual([
      { label: "laptop", sha256: sha(token), createdAt: expect.any(Number), lastUsedAt: expect.any(Number) },
    ]);
  });

  it("verify accepts the right token and refuses others", async () => {
    const store = new DeviceStore(file, { setTimer: fakeTimers().setTimer });
    const token = await store.add("laptop");
    expect(await store.verify(token)).toMatchObject({ label: "laptop" });
    expect(await store.verify("x".repeat(43))).toBeNull();
    expect(await store.verify("")).toBeNull();
  });

  it("verify compares with crypto.timingSafeEqual", async () => {
    const store = new DeviceStore(file, { setTimer: fakeTimers().setTimer });
    const token = await store.add("laptop");
    vi.mocked(timingSafeEqual).mockClear();
    await store.verify(token);
    expect(timingSafeEqual).toHaveBeenCalled();
    vi.mocked(timingSafeEqual).mockClear();
    await store.verify("x".repeat(43));
    expect(timingSafeEqual).toHaveBeenCalled();
  });

  it("verify and list never expose sha256", async () => {
    const store = new DeviceStore(file, { setTimer: fakeTimers().setTimer });
    const token = await store.add("laptop");
    expect(Object.keys((await store.verify(token))!).sort()).toEqual(["createdAt", "label", "lastUsedAt"]);
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(Object.keys(list[0]).sort()).toEqual(["createdAt", "label", "lastUsedAt"]);
  });

  it("add with an existing label replaces that device", async () => {
    const store = new DeviceStore(file, { setTimer: fakeTimers().setTimer });
    const first = await store.add("laptop");
    const second = await store.add("laptop");
    expect(readDevices()).toHaveLength(1);
    expect(await store.verify(first)).toBeNull();
    expect(await store.verify(second)).toMatchObject({ label: "laptop" });
  });

  it("revoke removes a device and reports whether it existed", async () => {
    const store = new DeviceStore(file, { setTimer: fakeTimers().setTimer });
    const token = await store.add("laptop");
    expect(await store.revoke("laptop")).toBe(true);
    expect(await store.verify(token)).toBeNull();
    expect(await store.list()).toEqual([]);
    expect(await store.revoke("none")).toBe(false);
  });

  it.each(["Lap Top", "", "-x", "_x", "a".repeat(33), "lap/top", "laptop\n"])(
    "add rejects the bad label %j and writes nothing",
    async (label) => {
      const store = new DeviceStore(file, { setTimer: fakeTimers().setTimer });
      await expect(store.add(label)).rejects.toThrow();
      expect(existsSync(file)).toBe(false);
    },
  );

  it("DEVICE_LABEL_RE accepts the plan's label shape", () => {
    for (const ok of ["a", "laptop", "phone-2", "loop_back", "0", "a".repeat(32)]) expect(DEVICE_LABEL_RE.test(ok)).toBe(true);
  });

  it("flushes lastUsedAt at most once per flush period", async () => {
    const { timers, setTimer } = fakeTimers();
    let t = 1_000;
    const store = new DeviceStore(file, { now: () => t, setTimer });
    const token = await store.add("laptop");
    expect(readDevices()[0]).toMatchObject({ createdAt: 1_000, lastUsedAt: 1_000 });

    t = 5_000;
    expect(await store.verify(token)).toMatchObject({ lastUsedAt: 5_000 });
    t = 30_000;
    await store.verify(token);
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(60_000);
    expect(readDevices()[0].lastUsedAt).toBe(1_000);
    expect((await store.list())[0].lastUsedAt).toBe(30_000);

    timers[0].fn();
    await vi.waitFor(() => expect(readDevices()[0].lastUsedAt).toBe(30_000));

    t = 90_000;
    await store.verify(token);
    expect(timers).toHaveLength(2);
  });

  it("flush writes pending lastUsedAt at once and clears the timer", async () => {
    const { timers, setTimer } = fakeTimers();
    let t = 1_000;
    const store = new DeviceStore(file, { now: () => t, setTimer, flushMs: 5_000 });
    const token = await store.add("laptop");
    t = 2_000;
    await store.verify(token);
    expect(timers[0].ms).toBe(5_000);
    await store.flush();
    expect(timers[0].cleared).toBe(true);
    expect(readDevices()[0].lastUsedAt).toBe(2_000);
  });

  it("flush merges by label into the current file and skips a replaced device", async () => {
    const { setTimer } = fakeTimers();
    let t = 1_000;
    const store = new DeviceStore(file, { now: () => t, setTimer });
    const laptop = await store.add("laptop");
    await store.add("phone");
    t = 2_000;
    await store.verify(laptop);
    // Written from outside after the bump: a new phone device and a replaced laptop.
    const cur = readDevices();
    const outside = [
      ...cur.filter((d) => d.label === "phone"),
      { label: "laptop", sha256: sha("other-token"), createdAt: 1_500, lastUsedAt: 1_500 },
      { label: "tablet", sha256: sha("tablet-token"), createdAt: 1_600, lastUsedAt: 1_600 },
    ];
    writeFileSync(file, JSON.stringify(outside, null, 2));
    await store.flush();
    const after = readDevices();
    expect(after.map((d) => d.label)).toEqual(["phone", "laptop", "tablet"]);
    expect(after.find((d) => d.label === "laptop")!.lastUsedAt).toBe(1_500);
  });

  it.each([
    ["torn array", "[{"],
    ["an object", "{}"],
    ["a JSON string", '"[{"'],
    ["null", "null"],
    ["an empty file", ""],
  ])("reads %s as no devices and the next add rewrites a valid file", async (_name, content) => {
    writeFileSync(file, content);
    const store = new DeviceStore(file, { setTimer: fakeTimers().setTimer });
    expect(await store.list()).toEqual([]);
    expect(await store.verify("anything")).toBeNull();
    const token = await store.add("a");
    const devices = readDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ label: "a", sha256: sha(token) });
    expect(await store.verify(token)).toMatchObject({ label: "a" });
  });

  it("drops malformed entries and keeps the valid ones", async () => {
    const good = { label: "ok", sha256: sha("good-token"), createdAt: 1, lastUsedAt: 2 };
    writeFileSync(file, JSON.stringify([
      null, 1, "x", [], { label: 5 }, { label: "nohash" }, { label: "short", sha256: "abc" },
      { label: "Bad Label", sha256: sha("bad-label-token"), createdAt: 1, lastUsedAt: 1 },
      good,
    ]));
    const store = new DeviceStore(file, { setTimer: fakeTimers().setTimer });
    expect(await store.list()).toEqual([{ label: "ok", createdAt: 1, lastUsedAt: 2 }]);
    expect(await store.verify("bad-label-token")).toBeNull();
    expect(await store.verify("good-token")).toMatchObject({ label: "ok" });
  });

  it("re-reads the file when it is rewritten from outside", async () => {
    const store = new DeviceStore(file, { setTimer: fakeTimers().setTimer });
    await store.add("laptop");
    expect(await store.verify("forged-token")).toBeNull();
    const forged = { label: "forged-dev", sha256: sha("forged-token"), createdAt: 1, lastUsedAt: 1 };
    writeFileSync(file, JSON.stringify([forged]));
    expect(await store.verify("forged-token")).toMatchObject({ label: "forged-dev" });
    expect((await store.list()).map((d) => d.label)).toEqual(["forged-dev"]);
  });

  it("reads a missing file as no devices", async () => {
    const store = new DeviceStore(file, { setTimer: fakeTimers().setTimer });
    expect(await store.list()).toEqual([]);
    expect(await store.verify("anything")).toBeNull();
  });

  it("keeps both devices of concurrent adds", async () => {
    const store = new DeviceStore(file, { setTimer: fakeTimers().setTimer });
    const [a, b] = await Promise.all([store.add("a"), store.add("b")]);
    expect((await store.list()).map((d) => d.label).sort()).toEqual(["a", "b"]);
    expect(await store.verify(a)).toMatchObject({ label: "a" });
    expect(await store.verify(b)).toMatchObject({ label: "b" });
  });
});
