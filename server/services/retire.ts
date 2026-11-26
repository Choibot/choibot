// server/services/retire.ts — two old services left the repo: their scripts are gone. A host that ran them still has their records. Boot drops
// a record of exactly these ids once its script is gone, before reconcile, so the store keeps no
// service that cannot start. A record with a live session stays (stop it first), and no other
// record and no file outside the services store is touched.
import { existsSync } from "node:fs";
import type { ServiceStore } from "./store.js";

export const RETIRED_SERVICE_IDS: readonly string[] = ["retired-b-backup", "retired-a-monitor"];

export type RetireServicesDeps = {
  store: Pick<ServiceStore, "load" | "delete">;
  // true while the service's dtach session lives (TerminalManager.hasSession of svcTermId).
  alive: (id: string) => Promise<boolean>;
  exists?: (path: string) => boolean;
  log?: (s: string) => void;
};

// The ids whose record was there and is now gone.
export async function retirePriceServices(d: RetireServicesDeps): Promise<string[]> {
  const exists = d.exists ?? existsSync;
  const log = d.log ?? console.log;
  const gone: string[] = [];
  for (const id of RETIRED_SERVICE_IDS) {
    const rec = await d.store.load(id);
    if (!rec || exists(rec.command)) continue;
    if (await d.alive(id)) {
      log(`[services] ${id}: its script left the repo, but it still runs; stop it and the next boot removes its record`);
      continue;
    }
    await d.store.delete(id);
    gone.push(id);
  }
  if (gone.length) log(`[services] removed the records of ${gone.join(", ")}: their scripts left the repo`);
  return gone;
}
