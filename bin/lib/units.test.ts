import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CONSOLE_UNIT_TEMPLATE, renderUnit, buildPath, unitTemplate, UNIT_NAMES, type UnitVars } from "./units.js";
import { NEW_NAMES, OLD_NAMES } from "../../server/names.mjs";

const VARS: UnitVars = {
  REPO_DIR: "/home/alice/choibot", PNPM_BIN: "/home/alice/.local/share/pnpm/bin/pnpm",
  PATH: "/home/alice/nodebin:/usr/local/bin:/usr/bin:/bin",
};
const tmpl = (n: string) => readFileSync(new URL(`../../deploy/${n}`, import.meta.url), "utf8");

describe("unit templates", () => {
  for (const name of UNIT_NAMES) {
    it(`${name} renders with no leftovers, no User=, boots from default.target`, () => {
      const out = renderUnit(tmpl(name), VARS);
      expect(out).not.toMatch(/\{\{.*\}\}/);
      expect(out).not.toMatch(/^User=/m);
      expect(out).toMatch(/^WantedBy=default\.target$/m);
      // A renderer that deleted placeholders instead of replacing them would
      // still satisfy the assertions above — pin the real substitution.
      expect(out).toContain(VARS.REPO_DIR);
    });
  }
  // Each template renders as the file is: the templates carry the names of the table.
  const repo = fileURLToPath(new URL("../..", import.meta.url));
  for (const file of [CONSOLE_UNIT_TEMPLATE, "cron-job.service", "cron-job.timer"]) {
    it(`${file}: renders as the file is`, () => {
      expect(unitTemplate(repo, file, OLD_NAMES)).toBe(tmpl(file));
      const now = unitTemplate(repo, file, NEW_NAMES);
      expect(now).toBe(tmpl(file));
      expect(now.split("\n")).toHaveLength(tmpl(file).split("\n").length);
    });
  }
  it("the console unit of a new install", () => {
    const out = renderUnit(unitTemplate(repo, CONSOLE_UNIT_TEMPLATE, NEW_NAMES), VARS);
    expect(out).toContain("Description=ChoiBot (Fastify + Next.js)");
    expect(out).toContain("systemctl --user enable --now choibot");
    expect(out).toContain("`pnpm choibot setup`");
  });

  it("throws on unsubstituted placeholders", () => {
    expect(() => renderUnit("X={{NOPE}}", VARS)).toThrow(/unsubstituted/);
  });
  it("throws on any leftover double-brace token, however malformed", () => {
    // Typos must fail here, not at `systemctl` time on the host.
    for (const bad of ["X={{gate_dir}}", "X={{GATE-DIR}}", "X={{ REPO_DIR }}", "X={{}}"]) {
      expect(() => renderUnit(bad, VARS)).toThrow(/unsubstituted/);
    }
  });
  it("buildPath dedups and appends system dirs", () => {
    expect(buildPath(["/a", "", "/a", "/b"])).toBe("/a:/b:/usr/local/bin:/usr/bin:/bin");
  });
});
