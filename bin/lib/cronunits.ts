// bin/lib/cronunits.ts — render per-job systemd units from deploy/cron-job.*.
import { renderUnit, unitTemplate } from "./units.js";
import type { CronJobSpec } from "./cronspec.js";

export type CronUnitVars = { REPO_DIR: string; SETTINGS_FILE: string; NODE_BIN: string; PATH: string; CRON_DATA_DIR: string };

export function renderCronUnits(
  repoDir: string, spec: CronJobSpec, vars: CronUnitVars,
): { service: string; timer: string } {
  const all: Record<string, string> = {
    ...vars,
    JOB_NAME: spec.name,
    SCHEDULE: spec.schedule,
    TIMEOUT_START_SEC: String((spec.timeoutMinutes + 5) * 60),
  };
  const read = (n: string) => unitTemplate(repoDir, n);
  return {
    service: renderUnit(read("cron-job.service"), all),
    timer: renderUnit(read("cron-job.timer"), all),
  };
}
