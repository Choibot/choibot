// server/cron/retire.ts — the cron master is retired: the fleet master manages
// cron jobs now (server/master/prompt.ts, "Cron jobs"). A host that ran the
// old Cron tab still has its record (id "cron-master"). Boot stops that
// session once and drops the record, before reconcile, so nothing resumes it
// as a worker. Its memory dir (the notes on why each job exists) stays: the
// fleet master prompt points at it.
import type { SessionStore } from "../agents/store.js";

export const RETIRED_CRON_MASTER_ID = "cron-master";

export type RetireDeps = {
  store: Pick<SessionStore, "load" | "delete">;
  // TerminalManager.kill: ends the dtach session (live or unattached) and its process tree.
  kill: (id: string) => void;
  log?: (s: string) => void;
};

// true when a record was there and is now gone.
export async function retireCronMaster(d: RetireDeps): Promise<boolean> {
  if (!(await d.store.load(RETIRED_CRON_MASTER_ID))) return false;
  d.kill(RETIRED_CRON_MASTER_ID);
  await d.store.delete(RETIRED_CRON_MASTER_ID);
  (d.log ?? console.log)("[cron] retired the cron master: its session is stopped and its record removed; its memory dir is kept");
  return true;
}
