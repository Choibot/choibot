import { describe, expect, it } from "vitest";
import { changeStarts, nextStop, openAtFirst, pillFile, shownFile, toggleFile } from "./prDiffNav";

const files = [{ path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }];

describe("toggleFile (a press on a file row of the ticket)", () => {
  it("opens the pressed file when the diff is closed", () => {
    expect(toggleFile(null, "b.ts")).toBe("b.ts");
  });
  it("moves to the pressed file when another file is open", () => {
    expect(toggleFile("a.ts", "b.ts")).toBe("b.ts");
  });
  it("closes the diff on a second press of the open file", () => {
    expect(toggleFile("b.ts", "b.ts")).toBeNull();
  });
  it("opens the pressed file when the diff is open on no named file", () => {
    expect(toggleFile("", "a.ts")).toBe("a.ts");
  });
});

describe("pillFile (a press on the +N -M in K files pill)", () => {
  it("opens on the first changed file", () => {
    expect(pillFile(null, files)).toBe("a.ts");
  });
  it("opens with no named file while the file list is not known", () => {
    expect(pillFile(null, [])).toBe("");
  });
  it("closes an open diff", () => {
    expect(pillFile("c.ts", files)).toBeNull();
    expect(pillFile("", files)).toBeNull();
  });
});

describe("shownFile", () => {
  it("is the asked file", () => {
    expect(shownFile("b.ts", ["a.ts", "b.ts"])).toBe("b.ts");
  });
  it("is the first changed file when no file is asked, never nothing", () => {
    expect(shownFile("", ["a.ts", "b.ts"])).toBe("a.ts");
    expect(shownFile(null, ["a.ts"])).toBe("a.ts");
    expect(shownFile(undefined, ["a.ts"])).toBe("a.ts");
  });
  it("is empty only when the PR changes no file", () => {
    expect(shownFile("", [])).toBe("");
  });
});

describe("openAtFirst (which files of the change view start open)", () => {
  it("opens every file of a small PR", () => {
    expect(openAtFirst([10, 40, 3])).toEqual([true, true, true]);
  });
  it("folds a file over the file limit and keeps the next small ones open", () => {
    expect(openAtFirst([10, 900, 5], 400, 2500)).toEqual([true, false, true]);
  });
  it("folds the files after the budget is used", () => {
    expect(openAtFirst([300, 300, 300, 10], 400, 700)).toEqual([true, true, false, true]);
  });
  it("opens nothing of an empty list", () => {
    expect(openAtFirst([])).toEqual([]);
  });
});

describe("changeStarts (the first row of each run of changed lines)", () => {
  it("finds each run once", () => {
    expect(changeStarts([false, true, true, false, false, true, false, true])).toEqual([1, 5, 7]);
  });
  it("counts a run at the first row", () => {
    expect(changeStarts([true, true, false])).toEqual([0]);
  });
  it("finds none in a file with no change", () => {
    expect(changeStarts([false, false])).toEqual([]);
  });
});

describe("nextStop (the scroll top of the next change)", () => {
  const tops = [400, 1200, 3000];
  it("the first stop puts the first change a few lines under the top", () => {
    expect(nextStop(tops, -Infinity, 60, 5000)).toBe(340);
  });
  it("goes to the change after the one at the top", () => {
    expect(nextStop(tops, 340, 60, 5000)).toBe(1140);
    expect(nextStop(tops, 1140, 60, 5000)).toBe(2940);
  });
  it("goes from a place between two changes to the next one", () => {
    expect(nextStop(tops, 700, 60, 5000)).toBe(1140);
  });
  it("goes back to the first change after the last", () => {
    expect(nextStop(tops, 2940, 60, 5000)).toBe(340);
  });
  it("goes back to the first change when the box is at its end", () => {
    // The last change is in the last screen: the box cannot put it at the top.
    expect(nextStop(tops, 2500, 60, 2500)).toBe(340);
  });
  it("never goes over the end of the box or under 0", () => {
    expect(nextStop(tops, 1140, 60, 2500)).toBe(2500);
    expect(nextStop([20], -Infinity, 60, 2500)).toBe(0);
  });
  it("has no stop in a file with no change", () => {
    expect(nextStop([], 0, 60, 100)).toBeNull();
  });
});
