import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, type AgentRecord } from "../agents/store.js";
import { cronPaths } from "../../bin/lib/cronspec.js";
import { RETIRED_CRON_MASTER_ID, retireCronMaster } from "./retire.js";

const dirs: string[] = [];
const tmp = async (p: string) => { const d = await mkdtemp(join(tmpdir(), p)); dirs.push(d); return d; };
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

// A record as the old Cron tab wrote it (kind "cron-master" is no record kind any more).
const oldRecord = (cwd: string) => ({
  id: RETIRED_CRON_MASTER_ID, label: "Cron", kind: "cron-master", repo: "", worktree: cwd, cwd,
  branch: "", baseBranch: "", sessionId: "s-1", hookToken: "t", status: "idle", createdAt: 1,
}) as unknown as AgentRecord;

describe("retireCronMaster", () => {
  it("stops the old session once, drops the record and keeps the memory dir", async () => {
    const store = new SessionStore(await tmp("retire-agents-"));
    const paths = cronPaths(await tmp("retire-cron-"));
    await mkdir(paths.memoryDir, { recursive: true });
    await writeFile(join(paths.memoryDir, "MEMORY.md"), "- why aws-cost-digest exists");
    await store.save(oldRecord(paths.agentDir));
    await store.save({ ...oldRecord("/w"), id: "w1", kind: undefined, label: "worker" });
    const killed: string[] = [];
    const logs: string[] = [];
    const d = { store, kill: (id: string) => { killed.push(id); }, log: (s: string) => logs.push(s) };

    expect(await retireCronMaster(d)).toBe(true);
    expect(killed).toEqual(["cron-master"]);
    expect(await store.load("cron-master")).toBeNull();
    expect((await store.list()).map((r) => r.id)).toEqual(["w1"]);
    expect(await readFile(join(paths.memoryDir, "MEMORY.md"), "utf8")).toBe("- why aws-cost-digest exists");
    expect(logs).toHaveLength(1);

    // The next boot finds nothing to do.
    expect(await retireCronMaster(d)).toBe(false);
    expect(killed).toEqual(["cron-master"]);
  });

  it("does nothing on a host that never ran the cron master", async () => {
    const store = new SessionStore(await tmp("retire-agents-"));
    const killed: string[] = [];
    expect(await retireCronMaster({ store, kill: (id) => { killed.push(id); }, log: () => {} })).toBe(false);
    expect(killed).toEqual([]);
  });
});
