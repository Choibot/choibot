// server/gh/appused.test.ts — the repos that the agents used in the last 14 days: from agent
// records, Recurring tasks and tickets, GitHub repos only, newest first, each source named once.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readRecurring, usedRepos, USED_DAYS } from "./appused.js";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const ws = [
  { name: "shop", slug: "acme/shop", path: "/ws/shop" },
  { name: "api", slug: "acme/api", path: "/ws/api" },
  { name: "notes", slug: "ana/notes", path: "/ws/notes" },
];
const agent = (repo: string, status: "running" | "idle" | "done" | "error", createdAt: number, o: { closedAt?: number } = {}) =>
  ({ repo, status, createdAt, ...o });

describe("usedRepos", () => {
  it("takes the agents that live now, and the ones that started or closed in the window", () => {
    const r = usedRepos({
      agents: [
        agent("/ws/shop", "idle", NOW - 40 * DAY),                     // alive: now
        agent("/ws/api", "done", NOW - 30 * DAY, { closedAt: NOW - 2 * DAY }),
        agent("/ws/notes", "done", NOW - 20 * DAY, { closedAt: NOW - 15 * DAY }), // out of the window
        agent("/elsewhere/x", "running", NOW),                         // not a repo of the work folder
        agent("", "running", NOW),                                     // a lead with no repo
      ],
      recurring: [], tickets: [], workspace: ws, now: NOW,
    });
    expect(r).toEqual([
      { slug: "acme/shop", name: "shop", lastAt: NOW, from: ["agents"] },
      { slug: "acme/api", name: "api", lastAt: NOW - 2 * DAY, from: ["agents"] },
    ]);
  });

  it("adds the Recurring tasks that are on, and the tickets of the window (by the PR's repo first)", () => {
    const r = usedRepos({
      agents: [agent("/ws/api", "done", NOW - 3 * DAY)],
      recurring: [{ workdir: "/ws/api", enabled: true }, { workdir: "/ws/notes", enabled: false }, { enabled: true }],
      tickets: [
        { repo: "shop", createdAt: NOW - DAY, pr: { url: "https://github.com/other/thing/pull/4", number: 4 } },
        { repo: "notes", createdAt: NOW - 5 * DAY },
        { repo: "shop", createdAt: NOW - 20 * DAY },
        { repo: "shop", createdAt: NOW - DAY, pr: { local: { repo: "shop", branch: "b" } } },
      ],
      workspace: ws, now: NOW,
    });
    expect(r).toEqual([
      { slug: "acme/api", name: "api", lastAt: NOW, from: ["agents", "recurring"] },
      // The same time: by name.
      { slug: "acme/shop", name: "shop", lastAt: NOW - DAY, from: ["tickets"] },
      { slug: "other/thing", name: null, lastAt: NOW - DAY, from: ["tickets"] },
      { slug: "ana/notes", name: "notes", lastAt: NOW - 5 * DAY, from: ["tickets"] },
    ]);
  });

  it("keeps one row for a repo with slugs in two cases, and the window is 14 days", () => {
    expect(USED_DAYS).toBe(14);
    const r = usedRepos({
      agents: [], recurring: [],
      tickets: [
        { repo: "x", createdAt: NOW - DAY, pr: { url: "https://github.com/Acme/Shop/pull/1", number: 1 } },
        { repo: "shop", createdAt: NOW - 2 * DAY },
      ],
      workspace: ws, now: NOW,
    });
    expect(r).toEqual([{ slug: "acme/shop", name: "shop", lastAt: NOW - DAY, from: ["tickets"] }]);
  });
});

describe("readRecurring", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "appused-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("reads the folder and the switch of each task, and skips a file that is not one", async () => {
    const jobs = join(dir, "jobs");
    mkdirSync(jobs, { recursive: true });
    writeFileSync(join(jobs, "a.json"), JSON.stringify({ name: "a", workdir: "/ws/api", enabled: true }));
    writeFileSync(join(jobs, "b.json"), JSON.stringify({ name: "b", enabled: false }));
    writeFileSync(join(jobs, "c.json"), "{torn");
    writeFileSync(join(jobs, "note.txt"), "x");
    const got = await readRecurring(dir);
    expect(got.sort((x, y) => Number(y.enabled) - Number(x.enabled))).toEqual([{ workdir: "/ws/api", enabled: true }, { enabled: false }]);
    expect(await readRecurring(join(dir, "none"))).toEqual([]);
  });
});
