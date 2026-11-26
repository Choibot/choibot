import { describe, it, expect } from "vitest";
import { parseRolloutPlan } from "./codex-plan.js";

const line = (o: unknown) => JSON.stringify(o) + "\n";

const planCall = (steps: { step: string; status: string }[]) =>
  line({
    type: "response_item",
    payload: { type: "function_call", name: "update_plan", arguments: JSON.stringify({ plan: steps }) },
  });

describe("parseRolloutPlan", () => {
  it("maps the plan steps to tasks in order", () => {
    const out = parseRolloutPlan(planCall([
      { step: "Read the code", status: "completed" },
      { step: "Write the test", status: "in_progress" },
      { step: "Ship it", status: "pending" },
    ]));
    expect(out).toEqual([
      { id: "1", subject: "Read the code", status: "completed" },
      { id: "2", subject: "Write the test", status: "in_progress" },
      { id: "3", subject: "Ship it", status: "pending" },
    ]);
  });

  it("uses the last plan call, not the first", () => {
    const out = parseRolloutPlan(
      planCall([{ step: "old", status: "pending" }]) +
      planCall([{ step: "new", status: "completed" }]),
    );
    expect(out).toEqual([{ id: "1", subject: "new", status: "completed" }]);
  });

  it("treats an unknown status as pending", () => {
    expect(parseRolloutPlan(planCall([{ step: "s", status: "wat" }]))[0].status).toBe("pending");
  });

  it("returns empty for a rollout with no plan call", () => {
    expect(parseRolloutPlan(line({ type: "session_meta", payload: { session_id: "x" } }))).toEqual([]);
  });

  it("ignores malformed lines instead of throwing", () => {
    expect(parseRolloutPlan("not json\n" + planCall([{ step: "s", status: "pending" }])))
      .toEqual([{ id: "1", subject: "s", status: "pending" }]);
  });

  it("skips a plan call whose arguments do not parse", () => {
    const bad = line({ type: "response_item", payload: { type: "function_call", name: "update_plan", arguments: "{{" } });
    expect(parseRolloutPlan(bad)).toEqual([]);
  });

  it("drops steps with no text", () => {
    expect(parseRolloutPlan(planCall([{ step: "", status: "pending" }, { step: "ok", status: "pending" }])))
      .toEqual([{ id: "1", subject: "ok", status: "pending" }]);
  });

  it("returns empty for an empty file", () => {
    expect(parseRolloutPlan("")).toEqual([]);
  });

  // A tail read (see codex.ts readPlan) starts mid-line on a large rollout.
  it("survives a truncated first line", () => {
    const truncated = '{"type":"response_item","payload":{"type":"messa';
    expect(parseRolloutPlan(truncated + "\n" + planCall([{ step: "s", status: "pending" }])))
      .toEqual([{ id: "1", subject: "s", status: "pending" }]);
  });

  it("keeps the earlier plan when a later call is unreadable", () => {
    const bad = line({ type: "response_item", payload: { name: "update_plan", arguments: "{{" } });
    expect(parseRolloutPlan(planCall([{ step: "kept", status: "in_progress" }]) + bad))
      .toEqual([{ id: "1", subject: "kept", status: "in_progress" }]);
  });

  it("reads the plan_update event form as well as the tool call", () => {
    const ev = line({
      type: "event_msg",
      payload: { type: "plan_update", explanation: "why", plan: [{ step: "from event", status: "completed" }] },
    });
    expect(parseRolloutPlan(ev)).toEqual([{ id: "1", subject: "from event", status: "completed" }]);
  });

  it("tolerates arguments already decoded into an object", () => {
    const obj = line({
      type: "response_item",
      payload: { type: "function_call", name: "update_plan", arguments: { plan: [{ step: "obj", status: "pending" }] } },
    });
    expect(parseRolloutPlan(obj)).toEqual([{ id: "1", subject: "obj", status: "pending" }]);
  });

  it("ignores a step whose text is not a string", () => {
    const weird = line({
      type: "response_item",
      payload: { name: "update_plan", arguments: JSON.stringify({ plan: [{ step: 7, status: "pending" }, "nope", null] }) },
    });
    expect(parseRolloutPlan(weird)).toEqual([]);
  });

  it("returns empty for an explicitly emptied plan", () => {
    expect(parseRolloutPlan(planCall([]))).toEqual([]);
  });

  it("does not mistake another tool call for a plan", () => {
    const shell = line({
      type: "response_item",
      payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["cat", "plan.md"] }) },
    });
    expect(parseRolloutPlan(shell)).toEqual([]);
  });
});

// The sandbox-script form. Codex 0.144.0 emits ONLY this: every tool goes
// through one JS `exec` tool, so the plan is JavaScript source, not JSON. The
// two `execCall` strings below are copied byte-for-byte out of a real rollout
// captured on 2026-08-14 — do not "tidy" them into JSON, the point is that they
// are not JSON.
const execRecord = (input: string) =>
  line({ type: "response_item", payload: { type: "custom_tool_call", name: "exec", input } });

const REAL_FIRST =
  'const r = await tools.update_plan({plan:[\n' +
  '  {step:"Define the health endpoint handler in health.js",status:"pending"},\n' +
  '  {step:"Connect the handler to the /health route",status:"pending"},\n' +
  '  {step:"Add tests for the /health endpoint",status:"pending"}\n' +
  ']});\ntext(r);\n';

const REAL_SECOND =
  'const r = await tools.update_plan({explanation:"Step 1 is complete. Steps 2 and 3 remain unimplemented.",plan:[\n' +
  '  {step:"Define the health endpoint handler in health.js",status:"completed"},\n' +
  '  {step:"Connect the handler to the /health route",status:"pending"},\n' +
  '  {step:"Add tests for the /health endpoint",status:"pending"}\n' +
  ']});\ntext(r);\n';

describe("parseRolloutPlan — codex 0.144.0 sandbox-script form", () => {
  it("reads a plan out of a real captured update_plan script", () => {
    expect(parseRolloutPlan(execRecord(REAL_FIRST))).toEqual([
      { id: "1", subject: "Define the health endpoint handler in health.js", status: "pending" },
      { id: "2", subject: "Connect the handler to the /health route", status: "pending" },
      { id: "3", subject: "Add tests for the /health endpoint", status: "pending" },
    ]);
  });

  it("uses the last script call, so completed steps show as completed", () => {
    const out = parseRolloutPlan(execRecord(REAL_FIRST) + execRecord(REAL_SECOND));
    expect(out.map((t) => t.status)).toEqual(["completed", "pending", "pending"]);
  });

  it("takes the last call when one script updates the plan twice", () => {
    const twice =
      'await tools.update_plan({plan:[{step:"a",status:"pending"}]});\n' +
      'await tools.update_plan({plan:[{step:"b",status:"completed"}]});\n';
    expect(parseRolloutPlan(execRecord(twice))).toEqual([
      { id: "1", subject: "b", status: "completed" },
    ]);
  });

  it("accepts single quotes and a trailing comma", () => {
    const js = "await tools.update_plan({plan:[{step:'it\\'s fine', status:'in_progress'},]});";
    expect(parseRolloutPlan(execRecord(js))).toEqual([
      { id: "1", subject: "it's fine", status: "in_progress" },
    ]);
  });

  // The whole reason the scan is string-aware rather than a regex.
  it("keeps braces, brackets and colons that live inside a step's text", () => {
    const js = 'await tools.update_plan({plan:[{step:"fix {a: [1,2]} in parse()",status:"pending"}]});';
    expect(parseRolloutPlan(execRecord(js))[0].subject).toBe("fix {a: [1,2]} in parse()");
  });

  it("ignores a script that only mentions the tool without calling it", () => {
    expect(parseRolloutPlan(execRecord('console.log("run update_plan later");'))).toEqual([]);
  });

  it("ignores call-shaped text inside strings, templates, and comments", () => {
    const fake = 'update_plan({plan:[{step:"fake",status:"completed"}]})';
    const src = [
      `const a = ${JSON.stringify(fake)};`,
      `const b = \`${fake}\`;`,
      `// ${fake}`,
      `/* ${fake} */`,
      'await tools.update_plan({plan:[{step:"real",status:"pending"}]});',
    ].join("\n");
    expect(parseRolloutPlan(execRecord(src))).toEqual([
      { id: "1", subject: "real", status: "pending" },
    ]);
  });

  it("does not let later call-shaped text replace a real plan", () => {
    const src = [
      'await tools.update_plan({plan:[{step:"real",status:"pending"}]});',
      '// update_plan({plan:[{step:"comment",status:"completed"}]})',
      'const sample = "update_plan({plan:[{step:\\"string\\",status:\\"completed\\"}]})";',
    ].join("\n");
    expect(parseRolloutPlan(execRecord(src))).toEqual([
      { id: "1", subject: "real", status: "pending" },
    ]);
  });

  it("ignores an unrelated sandbox script", () => {
    const js = 'const patch = "*** Begin Patch\\n*** Add File: health.js";\ntext(await tools.apply_patch(patch));\n';
    expect(parseRolloutPlan(execRecord(js))).toEqual([]);
  });

  it("survives a truncated script instead of throwing", () => {
    expect(parseRolloutPlan(execRecord('await tools.update_plan({plan:[{step:"a"'))).toEqual([]);
  });

  it("keeps an earlier plan when a later script is unreadable", () => {
    const bad = execRecord("await tools.update_plan({plan:[{step:}]});");
    expect(parseRolloutPlan(execRecord(REAL_FIRST) + bad)).toHaveLength(3);
  });

  // Parsing a call site costs two scans of the whole record, so an unbounded
  // number of them is quadratic — and the Plan rail polls, so the console would
  // freeze rather than degrade. The parser spends a fixed budget of call sites
  // from the END of the script (the last call is the current plan) and gives up
  // rather than walking back through thousands of them.
  it("spends a bounded number of call sites, giving up instead of scanning them all", () => {
    const decoys = "await tools.update_plan({plan:[{step:}]});\n".repeat(64);
    const src = 'await tools.update_plan({plan:[{step:"buried",status:"pending"}]});\n' + decoys;
    expect(parseRolloutPlan(execRecord(src))).toEqual([]);
  });

  it("still reads the current plan when it sits inside the budget", () => {
    const decoys = "await tools.update_plan({plan:[{step:}]});\n".repeat(8);
    const src = 'await tools.update_plan({plan:[{step:"kept",status:"pending"}]});\n' + decoys;
    expect(parseRolloutPlan(execRecord(src))).toEqual([
      { id: "1", subject: "kept", status: "pending" },
    ]);
  });

  // A bare mention is O(1) to reject, so a record full of them must not spend
  // the budget — and must not take quadratic time either.
  it("stays fast on a large record that repeats the tool name", () => {
    const src = "// update_plan\n".repeat(60_000)
      + 'await tools.update_plan({plan:[{step:"last",status:"in_progress"}]});';
    const started = Date.now();
    expect(parseRolloutPlan(execRecord(src))).toEqual([
      { id: "1", subject: "last", status: "in_progress" },
    ]);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
