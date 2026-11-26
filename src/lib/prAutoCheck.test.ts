import { describe, expect, it } from "vitest";
import { AUTO_CHECK_GAP_MS, OPENED_FOR_MS, PrAutoCheck, bindPrAutoCheck, type CheckSource } from "./prAutoCheck";

// A page: a clock, a visibility flag, timers the test fires, and one view that records its checks.
function page(o: { open?: string[]; selected?: string | null } = {}) {
  const p = {
    t: 1_000_000, visible: true, selected: o.selected ?? null as string | null,
    open: new Set(o.open ?? ["q1", "q2"]), checks: [] as { id: string; at: number }[],
    timers: [] as { at: number; fn: () => void }[],
  };
  const auto = new PrAutoCheck({
    now: () => p.t, visible: () => p.visible,
    setTimer: (fn, ms) => { p.timers.push({ at: p.t + ms, fn }); },
  });
  const source: CheckSource = {
    selected: () => p.selected,
    check: (id) => { if (!p.open.has(id)) return false; p.checks.push({ id, at: p.t }); return true; },
  };
  auto.add(source);
  // Time passes: every timer that is due fires, in order.
  const pass = (ms: number) => {
    const end = p.t + ms;
    for (;;) {
      const due = p.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      p.timers.splice(p.timers.indexOf(due), 1);
      p.t = due.at;
      due.fn();
    }
    p.t = end;
  };
  // The user goes to another tab and comes back: the browser sends both events of each.
  const leave = () => { auto.left(); p.visible = false; auto.left(); };
  const comeBack = () => { p.visible = true; auto.returned(); auto.returned(); };
  return { p, auto, pass, leave, comeBack, ids: () => p.checks.map((c) => c.id) };
}

describe("PrAutoCheck: the check on a return to the tab", () => {
  it("the selected pr ticket is checked one time when the tab has focus again (two events, one check)", () => {
    const { p, leave, comeBack, pass, ids } = page({ selected: "q1" });
    leave();
    pass(40_000);
    comeBack();
    expect(ids()).toEqual(["q1"]);
    pass(60_000);
    expect(ids()).toEqual(["q1"]); // no later check with no new return
    expect(p.timers).toEqual([]);
  });

  it("no selected pr ticket and no opened one: a return checks nothing", () => {
    const { leave, comeBack, ids } = page();
    leave(); comeBack();
    expect(ids()).toEqual([]);
  });

  it("a focus event with no leave before it checks nothing", () => {
    const { auto, ids } = page({ selected: "q1" });
    auto.returned();
    expect(ids()).toEqual([]);
  });

  it("Open PR pressed on a ticket: no check at the press, one check at the return, also when it is not the selected ticket", () => {
    const { auto, leave, comeBack, ids } = page({ selected: "q1" });
    auto.opened("q2");
    expect(ids()).toEqual([]);
    leave(); comeBack();
    expect(ids().sort()).toEqual(["q1", "q2"]);
  });

  it("an opened ticket is checked at each later return, for 30 minutes after the press", () => {
    const { auto, leave, comeBack, pass, ids } = page();
    auto.opened("q2");
    leave(); pass(20_000); comeBack();
    leave(); pass(OPENED_FOR_MS - 30_000); comeBack();
    expect(ids()).toEqual(["q2", "q2"]);
    leave(); pass(60_000); comeBack(); // 30 minutes passed since the press
    expect(ids()).toEqual(["q2", "q2"]);
  });

  it("never in a hidden tab: a focus event while hidden does nothing, and the return after it still checks", () => {
    const { p, auto, ids } = page({ selected: "q1" });
    auto.left(); p.visible = false;
    auto.returned();
    expect(ids()).toEqual([]);
    p.visible = true;
    auto.returned();
    expect(ids()).toEqual(["q1"]);
  });
});

describe("PrAutoCheck: at most one check per ticket in 15 seconds", () => {
  it("a second return inside the 15 s makes no check now; it runs once when the 15 s end", () => {
    const { p, leave, comeBack, pass } = page({ selected: "q1" });
    leave(); comeBack(); // check 1 at t0
    const t0 = p.t;
    pass(4_000); leave(); pass(3_000); comeBack(); // back at t0 + 7 s
    pass(1_000); leave(); pass(1_000); comeBack(); // and again at t0 + 9 s: still one check waiting
    expect(p.checks).toEqual([{ id: "q1", at: t0 }]);
    pass(AUTO_CHECK_GAP_MS);
    expect(p.checks).toEqual([{ id: "q1", at: t0 }, { id: "q1", at: t0 + AUTO_CHECK_GAP_MS }]);
  });

  it("the waiting check does not run in a hidden tab; the next return runs it", () => {
    const { p, leave, comeBack, pass, ids } = page({ selected: "q1" });
    leave(); comeBack();
    pass(5_000); leave(); comeBack(); // a check waits for t0 + 15 s
    leave(); // hidden when it is due
    pass(20_000);
    expect(ids()).toEqual(["q1"]);
    expect(p.timers).toEqual([]);
    comeBack();
    expect(ids()).toEqual(["q1", "q1"]);
  });

  it("a press of the button counts: a return less than 15 s after it waits", () => {
    const { p, auto, leave, comeBack, pass } = page({ selected: "q1" });
    auto.stamp("q1"); // "I merged it" at t0
    const t0 = p.t;
    pass(2_000); leave(); pass(6_000); comeBack();
    expect(p.checks).toEqual([]);
    pass(AUTO_CHECK_GAP_MS);
    expect(p.checks).toEqual([{ id: "q1", at: t0 + AUTO_CHECK_GAP_MS }]);
  });

  it("the limit is per ticket", () => {
    const { p, auto, leave, comeBack, pass, ids } = page({ selected: "q1" });
    leave(); comeBack();
    pass(5_000);
    auto.opened("q2");
    leave(); comeBack();
    expect(ids()).toEqual(["q1", "q2"]);
    expect(p.timers).toHaveLength(1); // q1 waits
  });
});

describe("PrAutoCheck: views", () => {
  it("a ticket that no view can check (closed, read-only) is forgotten: no check at the next return", () => {
    const { p, auto, leave, comeBack, ids } = page();
    auto.opened("q2");
    p.open.delete("q2"); // the ticket closed (the merge was seen by the server's poll)
    leave(); comeBack();
    p.open.add("q2");
    leave(); comeBack();
    expect(ids()).toEqual([]);
  });

  it("two views (the Queue and a thread): one check, by the first view that can; a removed view is not asked", () => {
    const { p, auto, leave, comeBack, ids } = page({ selected: "q1" });
    const second: string[] = [];
    const remove = auto.add({ check: (id) => { second.push(id); return true; } });
    leave(); comeBack();
    expect(ids()).toEqual(["q1"]);
    expect(second).toEqual([]);
    p.open.delete("q1");
    p.t += AUTO_CHECK_GAP_MS;
    leave(); comeBack();
    expect(second).toEqual(["q1"]); // the first view gave false
    remove();
    p.t += AUTO_CHECK_GAP_MS;
    leave(); comeBack();
    expect(second).toEqual(["q1"]);
  });
});

describe("bindPrAutoCheck", () => {
  const target = () => {
    const fns = new Map<string, () => void>();
    return { addEventListener: (type: string, fn: () => void) => { fns.set(type, fn); }, fire: (type: string) => fns.get(type)?.() };
  };
  it("window blur and a hidden tab are a leave; window focus and a visible tab are a return", () => {
    const calls: string[] = [];
    const auto = { left: () => { calls.push("left"); }, returned: () => { calls.push("returned"); } };
    const win = target();
    const doc = { ...target(), visibilityState: "visible" };
    bindPrAutoCheck(auto, win, doc);
    win.fire("blur");
    doc.visibilityState = "hidden"; doc.fire("visibilitychange");
    doc.visibilityState = "visible"; doc.fire("visibilitychange");
    win.fire("focus");
    expect(calls).toEqual(["left", "left", "returned", "returned"]);
  });
  it("no window (the server render): nothing", () => {
    expect(() => bindPrAutoCheck({ left: () => {}, returned: () => {} }, undefined, undefined)).not.toThrow();
  });
});
