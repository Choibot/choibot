import { describe, it, expect } from "vitest";
import { groupOptions } from "./group-options";

const o = (value: string, group?: string) => ({ value, label: value, group });

describe("groupOptions", () => {
  it("returns a single null-group bucket when nothing is grouped", () => {
    const r = groupOptions([o("a"), o("b")]);
    expect(r).toEqual([{ group: null, items: [o("a"), o("b")] }]);
  });

  it("buckets by group, preserving first-seen order", () => {
    const r = groupOptions([o("main", "local"), o("origin/x", "remote"), o("feat", "local")]);
    expect(r.map((g) => g.group)).toEqual(["local", "remote"]);
    expect(r[0].items.map((i) => i.value)).toEqual(["main", "feat"]);
    expect(r[1].items.map((i) => i.value)).toEqual(["origin/x"]);
  });

  it("handles an empty list", () => {
    expect(groupOptions([])).toEqual([]);
  });
});
