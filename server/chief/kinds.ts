// server/chief/kinds.ts — the queue item kinds (spec §5.1). The one
// definition: rule scopes (brain/store.ts) and queue items import it.
export type QueueKind = "pr" | "choice" | "preview" | "question";
// The kinds of the console's own tickets: the deploy ticket (spec §5.7) and the usage-limit
// ticket (chief/limit). They are not QueueKinds on purpose: an agent cannot add one, a rule scope
// cannot name one and a digest line cannot carry one, and the compiler holds every such path to
// the four kinds above.
export type ConsoleKind = "deploy" | "limit";
export type ItemKind = QueueKind | ConsoleKind;
export const isAgentKind = (k: ItemKind): k is QueueKind => k !== "deploy" && k !== "limit";

// UI mistake guard only: the server decides with isPersistentKind(rec.kind).
export function isPersistentAgentId(id: string): boolean {
  return id === "fleet-master" || id === "cron-master" || id === "coordinator" || id.startsWith("lead-");
}
