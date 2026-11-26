// server/chief/chiefids.ts — which agents run as the second account of strong protection
// (chiefaccount.ts): the persistent agents, by their fixed ids. A worker's id is a random UUID;
// the fleet master, the Coordinator and a lead (leads/areas.ts leadId, AREA_RE) have fixed ids.
// The id decides the account, so a path that knows only the id (a socket, a scan of /proc) needs
// no record. Kept apart from chiefaccount.ts so the strong check (hardened.ts) can use it.
import { COORDINATOR_ID } from "../coordinator/paths.js";
import { FLEET_MASTER_ID } from "../master/paths.js";

const LEAD_ID_RE = /^lead-[a-z0-9][a-z0-9-]{0,31}$/;

export function isChiefId(id: string): boolean {
  return id === FLEET_MASTER_ID || id === COORDINATOR_ID || LEAD_ID_RE.test(id);
}
