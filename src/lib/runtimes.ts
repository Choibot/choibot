// src/lib/runtimes.ts
// The runtimes the launcher offers. Claude leads because it is the server-side
// default: an agent created with no runtime is a Claude agent.
export type RuntimeId = "claude" | "codex";

export const RUNTIMES: { id: RuntimeId; label: string }[] = [
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
];

// Records predate the field, so an absent runtime reads as Claude. An unknown id
// falls back to itself rather than lying about which runtime produced the agent.
export function runtimeLabel(id?: string): string {
  if (!id) return "Claude";
  return RUNTIMES.find((r) => r.id === id)?.label ?? id;
}
