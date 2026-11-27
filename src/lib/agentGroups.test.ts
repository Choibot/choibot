import { describe, it, expect } from "vitest";
import { agentsWord, closedDot, groupAgents, leadCount, leadOpenKey, leadsOf, leadSummary, markClosed, moveWithinSection, readLeadOpen, sectionOf, statusDot, ticketsWord, writeLeadOpen } from "./agentGroups";

type A = { id: string; kind?: string; area?: string; spawnedBy?: string; closedAt?: number };
const a = (id: string, o: Partial<A> = {}): A => ({ id, ...o });
const ids = (xs: A[]) => xs.map((x) => x.id);

// GET /api/agents leaves leads out (persistent kinds): the lead rows come from GET /api/leads.
describe("leadsOf", () => {
  it("takes the areas whose lead was started and has a record, in order", () => {
    expect(leadsOf([
      { area: "b", repos: [], leadId: "lead-b", status: "idle", reportAt: null },
      { area: "x", repos: [], leadId: null, status: null },
      { area: "y", repos: [], leadId: "lead-y", status: null },
      { area: "a", repos: [], leadId: "lead-a", status: "running" },
    ])).toEqual([{ id: "lead-b", area: "b", status: "idle" }, { id: "lead-a", area: "a", status: "running" }]);
  });
  it("passes the lead's model and login through for its tag and header", () => {
    expect(leadsOf([{ area: "a", repos: [], leadId: "lead-a", status: "idle", model: "opus" }])).toEqual([{ id: "lead-a", area: "a", status: "idle", model: "opus" }]);
    expect(leadsOf([{ area: "a", repos: [], leadId: "lead-a", status: "idle", model: "opus", account: "choibot" }])).toEqual([{ id: "lead-a", area: "a", status: "idle", model: "opus", account: "choibot" }]);
  });
});

const L = (id: string) => ({ id, area: id.replace(/^lead-/, ""), status: "idle" });

describe("groupAgents", () => {
  it("puts every open agent in other when there are no leads", () => {
    const g = groupAgents([a("w1"), a("w2", { spawnedBy: "fleet-master" })], []);
    expect(g.leads).toEqual([]);
    expect(ids(g.other)).toEqual(["w1", "w2"]);
    expect(g.closed).toEqual([]);
  });
  it("gives each lead the workers it spawned, in list order", () => {
    const g = groupAgents([a("w1", { spawnedBy: "lead-b" }), a("w2", { spawnedBy: "lead-a" }), a("w3", { spawnedBy: "lead-b" })], [L("lead-a"), L("lead-b")]);
    expect(g.leads.map((x) => [x.lead.id, ids(x.workers)])).toEqual([["lead-a", ["w2"]], ["lead-b", ["w1", "w3"]]]);
    expect(g.other).toEqual([]);
  });
  it("sends no-lead workers to other: no spawnedBy, the master, or an id that is not a current lead", () => {
    const g = groupAgents([a("w1"), a("w2", { spawnedBy: "fleet-master" }), a("w3", { spawnedBy: "lead-gone" }), a("w4", { spawnedBy: "w1" })], [L("lead-a")]);
    expect(ids(g.other)).toEqual(["w1", "w2", "w3", "w4"]);
    expect(g.leads[0].workers).toEqual([]);
  });
  it("keeps closed workers out of the sections, newest close first", () => {
    const g = groupAgents([a("w1", { spawnedBy: "lead-a", closedAt: 10 }), a("w2", { closedAt: 30 }), a("w3", { closedAt: 20 })], [L("lead-a")]);
    expect(g.leads.map((x) => [x.lead.id, ids(x.workers)])).toEqual([["lead-a", []]]);
    expect(ids(g.closed)).toEqual(["w2", "w3", "w1"]);
  });
  it("never lists a lead's own record as a worker or in other", () => {
    const g = groupAgents([a("lead-a", { kind: "lead" }), a("w1", { spawnedBy: "lead-a" })], [L("lead-a")]);
    expect(g.leads.map((x) => [x.lead.id, ids(x.workers)])).toEqual([["lead-a", ["w1"]]]);
    expect(g.other).toEqual([]);
  });
});

describe("sectionOf", () => {
  it("maps each open worker row to its section: one per lead, or other", () => {
    const g = groupAgents([a("w1", { spawnedBy: "lead-a" }), a("w2"), a("w3", { closedAt: 1 })], [L("lead-a")]);
    expect(sectionOf(g)).toEqual({ w1: "lead:lead-a", w2: "other" });
  });
});

describe("moveWithinSection", () => {
  const list = [a("w1", { spawnedBy: "L" }), a("w2"), a("w3", { spawnedBy: "L" }), a("w4")];
  const sec = { w1: "lead:L", w2: "other", w3: "lead:L", w4: "other" };
  it("moves the dragged row to the target's place, keeping every other row's relative order", () => {
    expect(ids(moveWithinSection(list, "w3", "w1", sec))).toEqual(["w3", "w1", "w2", "w4"]);
    expect(ids(moveWithinSection(list, "w2", "w4", sec))).toEqual(["w1", "w3", "w4", "w2"]);
  });
  it("refuses a move across sections (same list back)", () => {
    expect(moveWithinSection(list, "w1", "w2", sec)).toBe(list);
  });
  it("refuses a move onto itself or an unknown row", () => {
    expect(moveWithinSection(list, "w1", "w1", sec)).toBe(list);
    expect(moveWithinSection(list, "w1", "nope", sec)).toBe(list);
  });
});

describe("leadSummary", () => {
  it("counts the lead's agents and the open tickets of the lead and its agents", () => {
    const lead = a("lead-a"), workers = [a("w1"), a("w2")];
    expect(leadSummary(lead, workers, { "lead-a": 1, w1: 2, other: 9 })).toEqual({ agents: 2, open: 3 });
    expect(leadSummary(lead, [], {})).toEqual({ agents: 0, open: 0 });
  });
});

// A row's one count is always open tickets; its title and aria-label say so.
describe("ticketsWord / agentsWord", () => {
  it("names the count", () => {
    expect(ticketsWord(1)).toBe("1 open ticket");
    expect(ticketsWord(2)).toBe("2 open tickets");
    expect(agentsWord(0)).toBe("no agents");
    expect(agentsWord(1)).toBe("1 agent");
    expect(agentsWord(3)).toBe("3 agents");
  });
});

describe("leadCount", () => {
  const sum = { agents: 2, open: 3 };
  it("folded: the open tickets of the lead and its agents", () => {
    expect(leadCount("lead-a", false, sum, { "lead-a": 1, w1: 2 })).toEqual({ n: 3, title: "3 open tickets: the lead's and its agents'" });
  });
  it("unfolded: the lead's own (each agent row shows its own)", () => {
    expect(leadCount("lead-a", true, sum, { "lead-a": 1, w1: 2 })).toEqual({ n: 1, title: "1 open ticket of the lead" });
    expect(leadCount("lead-a", true, sum, { w1: 2 }).n).toBe(0);
  });
  it("folded with no agents: the lead's own, said so", () => {
    expect(leadCount("lead-a", false, { agents: 0, open: 1 }, { "lead-a": 1 })).toEqual({ n: 1, title: "1 open ticket of the lead" });
  });
});

// A lead closed one of its workers (`agents close`): the rail gets agent-closed and marks the row.
describe("a worker its lead closed", () => {
  const list = [a("w1", { spawnedBy: "lead-a" }), a("w2", { spawnedBy: "lead-a" }), a("w3", { spawnedBy: "lead-b" }), a("w4")];
  const leads = [L("lead-a"), L("lead-b")];
  // Open tickets: one of the lead, one of w1; w2 has none (the server refuses its close otherwise).
  const byAgent = { "lead-a": 1, w1: 1, w3: 4 };
  it("leaves its lead's section for Closed; the other sections keep their rows", () => {
    const g = groupAgents(markClosed(list, "w2", 50), leads);
    expect(g.leads.map((x) => [x.lead.id, ids(x.workers)])).toEqual([["lead-a", ["w1"]], ["lead-b", ["w3"]]]);
    expect(ids(g.other)).toEqual(["w4"]);
    expect(g.closed).toEqual([{ id: "w2", spawnedBy: "lead-a", closedAt: 50 }]);
    expect(sectionOf(g)).toEqual({ w1: "lead:lead-a", w3: "lead:lead-b", w4: "other" });
  });
  it("the section's count line drops by one and its ticket count stays", () => {
    const before = groupAgents(list, leads).leads[0];
    const after = groupAgents(markClosed(list, "w2", 50), leads).leads[0];
    expect(leadSummary(before.lead, before.workers, byAgent)).toEqual({ agents: 2, open: 2 });
    expect(leadSummary(after.lead, after.workers, byAgent)).toEqual({ agents: 1, open: 2 });
    const lone = groupAgents(markClosed(markClosed(list, "w2", 50), "w1", 60), leads).leads[0];
    expect(leadSummary(lone.lead, lone.workers, { "lead-a": 1 })).toEqual({ agents: 0, open: 1 });
  });
  it("keeps the first close time, leaves the other rows as they are, and ignores an unknown id", () => {
    const once = markClosed(list, "w2", 50);
    expect(markClosed(once, "w2", 99).find((x) => x.id === "w2")?.closedAt).toBe(50);
    expect(once.filter((x) => x.id !== "w2")).toEqual(list.filter((x) => x.id !== "w2"));
    expect(markClosed(list, "nope", 50)).toEqual(list);
  });
  it("reopened (closedAt cleared), it is back in its lead's section in its old place", () => {
    const reopened = markClosed(list, "w2", 50).map((x) => (x.id === "w2" ? { ...x, closedAt: undefined } : x));
    expect(ids(groupAgents(reopened, leads).leads[0].workers)).toEqual(["w1", "w2"]);
  });
});

describe("lead open state per browser", () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
  };
  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  it("uses the key choibot.leadOpen.<area>", () => {
    expect(leadOpenKey("indexer")).toBe("choibot.leadOpen.indexer");
  });
  it("defaults to open", () => {
    expect(readLeadOpen(mem(), "indexer")).toBe(true);
    expect(readLeadOpen(null, "indexer")).toBe(true);
  });
  it("remembers a collapse and an expand", () => {
    const s = mem();
    writeLeadOpen(s, "indexer", false);
    expect(s.m.get("choibot.leadOpen.indexer")).toBe("0");
    expect(readLeadOpen(s, "indexer")).toBe(false);
    writeLeadOpen(s, "indexer", true);
    expect(readLeadOpen(s, "indexer")).toBe(true);
  });
  it("survives storage that throws (private window, blocked site data)", () => {
    expect(readLeadOpen(broken, "indexer")).toBe(true);
    expect(() => writeLeadOpen(broken, "indexer", false)).not.toThrow();
    expect(() => writeLeadOpen(null, "indexer", false)).not.toThrow();
  });
});

// The sidebar draws status as a dot; the word is the dot's title and aria-label.
describe("statusDot", () => {
  it("maps each agent status to its token colour and word", () => {
    expect(statusDot("running")).toEqual({ dot: "run", word: "running" });
    expect(statusDot("idle")).toEqual({ dot: "turn", word: "your turn" });
    expect(statusDot("done")).toEqual({ dot: "ok", word: "done" });
    expect(statusDot("error")).toEqual({ dot: "err", word: "error" });
  });
  it("draws an unknown status as the empty ring and keeps its word", () => {
    expect(statusDot("starting")).toEqual({ dot: "idle", word: "starting" });
    expect(statusDot("")).toEqual({ dot: "idle", word: "unknown" });
  });
});

describe("closedDot", () => {
  it("keeps the live dot of a closed agent that still runs", () => {
    expect(closedDot("running")).toEqual({ dot: "run", word: "running" });
    expect(closedDot("idle")).toEqual({ dot: "turn", word: "your turn" });
  });
  it("is the stopped ring otherwise", () => {
    expect(closedDot("done")).toEqual({ dot: "idle", word: "stopped" });
    expect(closedDot("error")).toEqual({ dot: "idle", word: "stopped" });
  });
});
