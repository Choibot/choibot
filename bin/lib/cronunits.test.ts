import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { renderCronUnits, type CronUnitVars } from "./cronunits.js";
import type { CronJobSpec } from "./cronspec.js";

// renderCronUnits reads deploy/cron-job.* off disk, so repoDir must be the real
// repo root; derive it from this file rather than trusting the vitest cwd.
const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");

const spec = {
  name: "brief", schedule: "*-*-* 08:00:00", prompt: "p", timeoutMinutes: 30,
  notify: "always", enabled: true, createdAt: 1,
} as CronJobSpec;
const vars: CronUnitVars = {
  REPO_DIR: REPO, SETTINGS_FILE: `${REPO}/.env`, NODE_BIN: "/nvm/node", PATH: "/nvm:/bin", CRON_DATA_DIR: "/data/cron",
};

describe("renderCronUnits", () => {
  it("renders a per-job service unit", () => {
    const { service } = renderCronUnits(REPO, spec, vars);
    expect(service).toContain(`ExecStart=/nvm/node ${REPO}/bin/cron-runner.mjs brief`);
    expect(service).toContain(`EnvironmentFile=${REPO}/.env`);
    expect(service).toContain("Environment=CRON_DATA_DIR=/data/cron");
    expect(service).toContain("Environment=PATH=/nvm:/bin");
    // TimeoutStartSec, not RuntimeMaxSec — systemd ignores RuntimeMaxSec= on
    // Type=oneshot units.
    expect(service).toContain("TimeoutStartSec=2100"); // 30min + 5min, in seconds
    expect(service).toMatch(/^Type=oneshot$/m);
  });

  it("renders a per-job timer unit", () => {
    const { timer } = renderCronUnits(REPO, spec, vars);
    expect(timer).toContain("OnCalendar=*-*-* 08:00:00");
    expect(timer).toContain("Persistent=true");
    expect(timer).toContain("AccuracySec=1s");
    expect(timer).toMatch(/^WantedBy=timers\.target$/m);
  });

  it("leaves no unsubstituted placeholders", () => {
    const { service, timer } = renderCronUnits(REPO, spec, vars);
    expect(service).not.toMatch(/\{\{/);
    expect(timer).not.toMatch(/\{\{/);
  });

  it("scales TimeoutStartSec with the job timeout", () => {
    const { service } = renderCronUnits(REPO, { ...spec, timeoutMinutes: 5 }, vars);
    expect(service).toContain("TimeoutStartSec=600");
  });
});
