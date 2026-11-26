import { describe, expect, it } from "vitest";
import { parseTaskFile, sortTasks, type AgentTask } from "./tasks.js";

describe("parseTaskFile", () => {
  it("extracts id, subject, activeForm, status", () => {
    const raw = JSON.stringify({
      id: "2", subject: "Build endpoint", description: "long text",
      activeForm: "Building endpoint", status: "in_progress", blocks: [], blockedBy: [],
    });
    expect(parseTaskFile(raw)).toEqual({
      id: "2", subject: "Build endpoint", activeForm: "Building endpoint", status: "in_progress",
    });
  });
  it("normalizes unknown/missing status to pending and omits missing activeForm", () => {
    expect(parseTaskFile(JSON.stringify({ id: "1", subject: "A", status: "weird" })))
      .toEqual({ id: "1", subject: "A", status: "pending" });
    expect(parseTaskFile(JSON.stringify({ id: "3", subject: "C", status: "completed" })))
      .toEqual({ id: "3", subject: "C", status: "completed" });
  });
  it("coerces a numeric id to string and rejects junk", () => {
    expect(parseTaskFile(JSON.stringify({ id: 4, subject: "D" })))
      .toEqual({ id: "4", subject: "D", status: "pending" });
    expect(parseTaskFile("not json")).toBe(null);
    expect(parseTaskFile(JSON.stringify({ id: "5" }))).toBe(null);      // no subject
    expect(parseTaskFile(JSON.stringify({ subject: "A" }))).toBe(null); // no id
    expect(parseTaskFile(JSON.stringify(["array"]))).toBe(null);
    expect(parseTaskFile(JSON.stringify({ id: "6", subject: 42 }))).toBe(null);
    expect(parseTaskFile(JSON.stringify({ id: "", subject: "E" }))).toBe(null); // empty id
  });
});

describe("sortTasks", () => {
  const t = (id: string): AgentTask => ({ id, subject: id, status: "pending" });
  it("sorts numerically, with non-numeric ids after, string-compared", () => {
    expect(sortTasks([t("10"), t("2"), t("b"), t("1"), t("a")]).map((x) => x.id))
      .toEqual(["1", "2", "10", "a", "b"]);
  });
  it("returns a new array without mutating the input", () => {
    const input = [t("10"), t("2"), t("1")];
    const sorted = sortTasks(input);
    expect(input.map((x) => x.id)).toEqual(["10", "2", "1"]);
    expect(sorted).not.toBe(input);
  });
});
