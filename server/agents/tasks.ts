// server/agents/tasks.ts — pure parsing of Claude Code harness task files
// (~/.claude/tasks/<sessionId>/<n>.json) for the rail's live-tasks view.
// Filesystem access stays in the route; this module is string → shape.

export type AgentTask = {
  id: string;
  subject: string;
  activeForm?: string;
  status: "pending" | "in_progress" | "completed";
};

// One task file → one task, or null for anything malformed. Task files are
// harness-written but the shape is not ours to trust — fail soft per file.
export function parseTaskFile(raw: string): AgentTask | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const o = data as { id?: unknown; subject?: unknown; activeForm?: unknown; status?: unknown };
  if (typeof o.subject !== "string") return null;
  const id = typeof o.id === "string" ? o.id : typeof o.id === "number" ? String(o.id) : null;
  // Empty ids would collide as React keys in the rail — treat as malformed.
  if (id === null || id === "") return null;
  const status = o.status === "completed" || o.status === "in_progress" ? o.status : "pending";
  const activeForm = typeof o.activeForm === "string" && o.activeForm ? o.activeForm : undefined;
  return { id, subject: o.subject, ...(activeForm ? { activeForm } : {}), status };
}

// Harness ids are small integers ("1", "2", …); sort those numerically and
// park any non-numeric stragglers after them in string order.
export function sortTasks(tasks: AgentTask[]): AgentTask[] {
  return [...tasks].sort((a, b) => {
    const na = /^\d+$/.test(a.id) ? Number(a.id) : null;
    const nb = /^\d+$/.test(b.id) ? Number(b.id) : null;
    if (na !== null && nb !== null) return na - nb;
    if (na !== null) return -1;
    if (nb !== null) return 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
