// src/lib/plan.ts — pure parsing of superpowers plan docs (checkbox-tracked
// markdown) for the rail's Plan view. No fetching here; ChangesRail supplies
// the file content.

export type PlanStep = { text: string; checked: boolean };
export type PlanTask = { title: string; steps: PlanStep[] };
export type ParsedPlan = { title: string | null; tasks: PlanTask[] };
export type TaskState = "done" | "active" | "pending";

const H1_RE = /^#\s+(.+?)\s*$/;
const H3_RE = /^###\s+(.+?)\s*$/;
const STEP_RE = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/;

// Strip the markdown that plan headings and steps commonly carry (bold
// labels, inline code) so rail rows read as plain text.
function stripMarkers(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, "$1").replace(/`([^`]*)`/g, "$1").trim();
}

// Tasks are ### headings that own at least one checkbox before the next ###;
// checkboxes before the first such heading form an implicit "Plan" task.
// Fenced code blocks are skipped so example checkboxes inside ``` fences
// don't count as steps.
export function parsePlan(markdown: string): ParsedPlan {
  let title: string | null = null;
  const tasks: PlanTask[] = [];
  let current: PlanTask | null = null; // owns steps; pushed only if it has any
  let inFence = false;
  const push = () => {
    if (current && current.steps.length > 0) tasks.push(current);
  };
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const h1 = H1_RE.exec(line);
    if (h1 && title === null) { title = h1[1]; continue; }
    const h3 = H3_RE.exec(line);
    if (h3) { push(); current = { title: stripMarkers(h3[1]), steps: [] }; continue; }
    const step = STEP_RE.exec(line);
    if (step) {
      if (!current) current = { title: "Plan", steps: [] };
      current.steps.push({ text: stripMarkers(step[2]), checked: step[1] !== " " });
    }
  }
  push();
  return { title, tasks };
}

// done = every step checked; the FIRST non-done task is active (it is the
// one being worked, whether or not any of its steps are ticked yet); the
// rest are pending.
export function taskStates(tasks: PlanTask[]): TaskState[] {
  let activeAssigned = false;
  return tasks.map((t) => {
    if (t.steps.every((s) => s.checked)) return "done";
    if (!activeAssigned) { activeAssigned = true; return "active"; }
    return "pending";
  });
}

export function planProgress(tasks: PlanTask[]): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const t of tasks) {
    total += t.steps.length;
    for (const s of t.steps) if (s.checked) done++;
  }
  return { done, total };
}
