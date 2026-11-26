import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ServiceStore, type ServiceRecord } from "./store.js";
import { RETIRED_SERVICE_IDS, retirePriceServices } from "./retire.js";

const rec = (id: string, command: string): ServiceRecord => ({
  id, name: id, description: "", command, args: [], cwd: "/repo", env: {},
  requiresConfirm: false, confirmMessage: "", autoRestart: true, createdAt: 1,
});

describe("retirePriceServices", () => {
  let dir: string, store: ServiceStore, logs: string[];
  const notAlive = async () => false;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "svc-retire-")); store = new ServiceStore(dir); logs = []; });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("removes the two retired records whose script is gone, once, with one log line", async () => {
    for (const id of RETIRED_SERVICE_IDS) await store.save(rec(id, `/repo/services/${id}/run.sh`));
    const d = { store, alive: notAlive, exists: () => false, log: (s: string) => logs.push(s) };
    expect(await retirePriceServices(d)).toEqual([...RETIRED_SERVICE_IDS]);
    expect(await store.list()).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(await retirePriceServices(d)).toEqual([]); // nothing left: a no-op
    expect(logs).toHaveLength(1);
  });

  it("keeps a retired record whose script still exists, or whose session still runs", async () => {
    await store.save(rec("retired-b-backup", "/opt/pusher.sh"));
    await store.save(rec("retired-a-monitor", "/repo/services/old-monitor/run.sh"));
    const gone = await retirePriceServices({
      store, alive: async (id) => id === "retired-a-monitor", exists: (p) => p === "/opt/pusher.sh", log: (s) => logs.push(s),
    });
    expect(gone).toEqual([]);
    expect((await store.list()).map((r) => r.id).sort()).toEqual(["retired-a-monitor", "retired-b-backup"]);
    expect(logs).toEqual([expect.stringContaining("retired-a-monitor: its script left the repo, but it still runs")]);
  });

  it("never touches another record, even with a missing script", async () => {
    await store.save(rec("svc-0b1c", "/gone/run.sh"));
    expect(await retirePriceServices({ store, alive: notAlive, exists: () => false, log: (s) => logs.push(s) })).toEqual([]);
    expect((await store.list()).map((r) => r.id)).toEqual(["svc-0b1c"]);
    expect(logs).toEqual([]);
  });
});
