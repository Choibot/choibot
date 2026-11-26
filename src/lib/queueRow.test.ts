import { describe, it, expect } from "vitest";
import { agentsCenter, onQueueRow, openCounts, phoneScreen, queueRowShown, sideRow } from "./queueRow";
import type { QueueItem } from "../../server/chief/queue/types";

const NOW = 1_000_000;
const item = (o: Partial<QueueItem>): QueueItem =>
  ({ id: "q1", kind: "question", agentId: "worker-1", status: "open", createdAt: 1, title: "t", repo: "r", ...o }) as QueueItem;

describe("queueRowShown", () => {
  it("shows the row while the queue is on or misconfigured", () => {
    expect(queueRowShown("on")).toBe(true);
    expect(queueRowShown("misconfigured")).toBe(true);
  });
  it("hides the row while the flag is off (404) or the first fetch is pending", () => {
    expect(queueRowShown("off")).toBe(false);
    expect(queueRowShown("loading")).toBe(false);
  });
});

describe("openCounts", () => {
  it("counts nothing for no items", () => {
    expect(openCounts([], NOW)).toEqual({ total: 0, byAgent: {} });
  });
  it("counts open items per agentId and in total", () => {
    const items = [
      item({ id: "a", agentId: "worker-1" }),
      item({ id: "b", agentId: "worker-1", kind: "pr" }),
      item({ id: "c", agentId: "fleet-master" }),
      item({ id: "d", agentId: "lead-indexer" }),
    ];
    expect(openCounts(items, NOW)).toEqual({ total: 4, byAgent: { "worker-1": 2, "fleet-master": 1, "lead-indexer": 1 } });
  });
  it("the console's deploy ticket counts on the fleet master row; a rule suggestion only in the total", () => {
    const items = [item({ id: "a", agentId: "console", kind: "deploy" }), item({ id: "b", agentId: "console", rule: { id: "r_aaaaa" } })];
    expect(openCounts(items, NOW)).toEqual({ total: 2, byAgent: { "fleet-master": 1, console: 1 } });
  });
  it("uses the Queue view's Open rule: a snooze that ended counts, a running snooze does not", () => {
    const items = [
      item({ id: "a", status: "snoozed", snoozedUntil: NOW - 1 }),
      item({ id: "b", status: "snoozed", snoozedUntil: NOW + 60_000 }),
    ];
    expect(openCounts(items, NOW)).toEqual({ total: 1, byAgent: { "worker-1": 1 } });
  });
  it("leaves out answered, auto, undone and withdrawn items", () => {
    const items = (["answered", "auto", "undone", "withdrawn"] as const).map((status, n) => item({ id: `x${n}`, status }));
    expect(openCounts(items, NOW)).toEqual({ total: 0, byAgent: {} });
  });
});

describe("onQueueRow", () => {
  it("is the old Queue tab: the Agents tab with the Queue row selected", () => {
    expect(onQueueRow("agents", true)).toBe(true);
  });
  it("is false on the Agents tab without the Queue row, and on any other tab", () => {
    expect(onQueueRow("agents", false)).toBe(false);
    expect(onQueueRow("shell", true)).toBe(false);
    expect(onQueueRow("cockpit", false)).toBe(false);
  });
});

describe("agentsCenter", () => {
  const base = { agentId: null, leadId: null, masterOpen: false, queueOpen: false, queueShown: true };
  it("shows an agent's terminal when an agent is selected", () => {
    expect(agentsCenter({ ...base, agentId: "a1" })).toBe("agent");
    expect(agentsCenter({ ...base, agentId: "a1", queueOpen: true })).toBe("agent");
  });
  it("shows a lead's terminal when a lead row is selected", () => {
    expect(agentsCenter({ ...base, leadId: "lead-a" })).toBe("lead");
  });
  it("shows the queue when the Queue row is selected and the row exists", () => {
    expect(agentsCenter({ ...base, queueOpen: true })).toBe("queue");
  });
  it("does not show the queue while the row is hidden (flag off, first fetch pending)", () => {
    expect(agentsCenter({ ...base, queueOpen: true, queueShown: false })).toBe("empty");
  });
  it("shows the master when its row is selected", () => {
    expect(agentsCenter({ ...base, masterOpen: true })).toBe("master");
  });
  it("is empty when nothing is selected", () => {
    expect(agentsCenter(base)).toBe("empty");
  });
});

// The sidebar replaces the top bar: GitHub is a row, and one row at most is drawn selected.
describe("sideRow", () => {
  it("selects the GitHub row while the cockpit is open, whatever the Agents center holds", () => {
    expect(sideRow("cockpit", "empty")).toBe("github");
    expect(sideRow("cockpit", "agent")).toBe("github");
  });
  it("selects the Server row while the Server page is open, whatever the Agents center holds", () => {
    expect(sideRow("server", "empty")).toBe("server");
    expect(sideRow("server", "agent")).toBe("server");
  });
  it("selects the Recurring row while the Recurring section is open, whatever the Agents center holds", () => {
    expect(sideRow("recurring", "empty")).toBe("recurring");
    expect(sideRow("recurring", "agent")).toBe("recurring");
  });
  it("selects the row of the Agents center on the Agents tab", () => {
    for (const c of ["agent", "lead", "queue", "master"] as const) expect(sideRow("agents", c)).toBe(c);
    expect(sideRow("agents", "empty")).toBeNull();
  });
  it("selects no row on a deprecated tab (editor, console, services)", () => {
    for (const t of ["editor", "console", "services"]) expect(sideRow(t, "agent")).toBeNull();
  });
  it("selects no row while Settings is open (the footer gear shows it)", () => {
    expect(sideRow("settings", "agent")).toBeNull();
    expect(sideRow("settings", "empty")).toBeNull();
  });
});

describe("phoneScreen", () => {
  it("shows the home list while nothing is open on the Agents tab", () => {
    expect(phoneScreen("agents", "empty")).toBe("home");
  });

  it("shows the screen of what is open", () => {
    for (const c of ["agent", "lead", "queue", "master"] as const) expect(phoneScreen("agents", c)).toBe(c);
  });

  it("shows the Recurring section for its tab, whatever the agents center is", () => {
    expect(phoneScreen("recurring", "empty")).toBe("recurring");
    expect(phoneScreen("recurring", "agent")).toBe("recurring");
  });

  it("shows GitHub for the cockpit tab (a #pr= link), whatever the agents center is", () => {
    expect(phoneScreen("cockpit", "empty")).toBe("github");
    expect(phoneScreen("cockpit", "agent")).toBe("github");
  });

  it("shows the Server page on its own screen, whatever the agents center is", () => {
    expect(phoneScreen("server", "empty")).toBe("server");
    expect(phoneScreen("server", "agent")).toBe("server");
  });

  it("shows Settings on its own screen (the home list's last row, a Manage link), whatever the agents center is", () => {
    expect(phoneScreen("settings", "empty")).toBe("settings");
    expect(phoneScreen("settings", "agent")).toBe("settings");
  });

  it("shows a deprecated tab (the editor of 'Open in editor') on its own screen", () => {
    expect(phoneScreen("editor", "agent")).toBe("tab");
    expect(phoneScreen("console", "empty")).toBe("tab");
  });

  it("maps the Telegram links to their screens", () => {
    // #agent=…&reconcile selects the agent (its review); #brain=diff now opens Settings → Rules (page.tsx).
    expect(phoneScreen("agents", agentsCenter({ agentId: "a1", leadId: null, masterOpen: false, queueOpen: false, queueShown: true }))).toBe("agent");
    expect(phoneScreen("agents", agentsCenter({ agentId: null, leadId: null, masterOpen: false, queueOpen: true, queueShown: true }))).toBe("queue");
    // Until the queue is known to be on, the Queue link waits on the home list.
    expect(phoneScreen("agents", agentsCenter({ agentId: null, leadId: null, masterOpen: false, queueOpen: true, queueShown: false }))).toBe("home");
  });
});
