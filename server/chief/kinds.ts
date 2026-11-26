// server/chief/kinds.ts — the queue item kinds (spec §5.1). The one
// definition: rule scopes (brain/store.ts) and queue items import it.
export type QueueKind = "pr" | "choice" | "preview" | "question";
// The kind of the console's own deploy ticket (spec §5.7). It is not a QueueKind on purpose: an
// agent cannot add it, a rule scope cannot name it and a digest line cannot carry it, and the
// compiler holds every such path to the four kinds above.
export type ConsoleKind = "deploy";
export type ItemKind = QueueKind | ConsoleKind;
export const isAgentKind = (k: ItemKind): k is QueueKind => k !== "deploy";

// UI mistake guard only: the server decides with isPersistentKind(rec.kind).
export function isPersistentAgentId(id: string): boolean {
  return id === "fleet-master" || id === "cron-master" || id === "coordinator" || id.startsWith("lead-");
}
