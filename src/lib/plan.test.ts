import { describe, expect, it } from "vitest";
import { parsePlan, planProgress, taskStates } from "./plan";

const DOC = `# Widget Implementation Plan

Some intro prose.

### Task 1: Parser

- [x] **Step 1: Write the failing test**
- [x] Step 2: Run test
- [ ] Step 3: \`implement\`

### Notes

No checkboxes here — not a task.

### Task 2: Endpoint

- [ ] Step 1
  - [X] indented sub-step
* [ ] star bullet
`;

describe("parsePlan", () => {
  it("extracts the H1 title and checkbox-bearing ### tasks", () => {
    const p = parsePlan(DOC);
    expect(p.title).toBe("Widget Implementation Plan");
    expect(p.tasks.map((t) => t.title)).toEqual(["Task 1: Parser", "Task 2: Endpoint"]);
  });
  it("parses steps with indentation, star bullets, uppercase X, and strips markers", () => {
    const [t1, t2] = parsePlan(DOC).tasks;
    expect(t1.steps).toEqual([
      { text: "Step 1: Write the failing test", checked: true },
      { text: "Step 2: Run test", checked: true },
      { text: "Step 3: implement", checked: false },
    ]);
    expect(t2.steps).toEqual([
      { text: "Step 1", checked: false },
      { text: "indented sub-step", checked: true },
      { text: "star bullet", checked: false },
    ]);
  });
  it("groups pre-heading checkboxes into an implicit Plan task", () => {
    const p = parsePlan("- [x] a\n- [ ] b\n### Task 1: X\n- [ ] c\n");
    expect(p.tasks.map((t) => t.title)).toEqual(["Plan", "Task 1: X"]);
    expect(p.tasks[0].steps).toHaveLength(2);
  });
  it("skips checkboxes inside fenced code blocks", () => {
    const fenced = [
      "### Task 1: Backtick fence",
      "",
      "- [x] real step",
      "",
      "```ts",
      "- [x] fake step",
      "- [ ] another fake step",
      "```",
      "",
      "- [ ] second real step",
      "",
      "### Task 2: Tilde fence",
      "",
      "~~~",
      "- [x] fake tilde step",
      "~~~",
      "- [ ] real tilde step",
      "",
    ].join("\n");
    const p = parsePlan(fenced);
    expect(p.tasks.map((t) => t.title)).toEqual(["Task 1: Backtick fence", "Task 2: Tilde fence"]);
    expect(p.tasks[0].steps).toEqual([
      { text: "real step", checked: true },
      { text: "second real step", checked: false },
    ]);
    expect(p.tasks[1].steps).toEqual([{ text: "real tilde step", checked: false }]);
    expect(planProgress(p.tasks)).toEqual({ done: 1, total: 3 });
  });
  it("strips bold and inline-code markers from task titles", () => {
    const p = parsePlan("### Task 2: `GET /api/files/plan` discovery endpoint\n- [ ] a\n### **Task 3:** wiring\n- [ ] b\n");
    expect(p.tasks.map((t) => t.title)).toEqual([
      "Task 2: GET /api/files/plan discovery endpoint",
      "Task 3: wiring",
    ]);
  });
  it("parses CRLF documents", () => {
    const p = parsePlan("# T\r\n### Task 1: A\r\n- [x] one\r\n- [ ] two\r\n");
    expect(p.title).toBe("T");
    expect(p.tasks).toHaveLength(1);
    expect(p.tasks[0].steps).toEqual([
      { text: "one", checked: true },
      { text: "two", checked: false },
    ]);
  });
  it("returns no tasks for checkbox-free markdown and no title without an H1", () => {
    const p = parsePlan("## Heading\n\nplain prose\n- a list item\n");
    expect(p.title).toBe(null);
    expect(p.tasks).toEqual([]);
  });
});

describe("taskStates", () => {
  const task = (checked: boolean[]): { title: string; steps: { text: string; checked: boolean }[] } => ({
    title: "t",
    steps: checked.map((c, i) => ({ text: `s${i}`, checked: c })),
  });
  it("done when all checked; first non-done with progress is active", () => {
    expect(taskStates([task([true, true]), task([true, false]), task([false])]))
      .toEqual(["done", "active", "pending"]);
  });
  it("first non-done task is active even with zero checked steps", () => {
    expect(taskStates([task([true]), task([false, false]), task([false])]))
      .toEqual(["done", "active", "pending"]);
  });
  it("all done yields no active", () => {
    expect(taskStates([task([true]), task([true])])).toEqual(["done", "done"]);
  });
});

describe("planProgress", () => {
  it("counts checked over total across tasks", () => {
    const p = parsePlan(DOC);
    expect(planProgress(p.tasks)).toEqual({ done: 3, total: 6 });
  });
  it("is 0/0 for no tasks", () => {
    expect(planProgress([])).toEqual({ done: 0, total: 0 });
  });
});
