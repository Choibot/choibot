// bin/lib/units.ts — render deploy/*.service templates with real host paths.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DISPLAY_NAME } from "../../server/brand.js";
import { names, OLD_NAMES, type Names } from "../../server/names.mjs";
// SETTINGS_FILE: the settings file of the install (server/layout.ts settingsFile).
export type UnitVars = { REPO_DIR: string; SETTINGS_FILE: string; PNPM_BIN: string; PATH: string };
// The unit the console runs in: choibot.service, or choibot.service on an install with
// the old names.
export const UNIT_NAMES: readonly string[] = [names().unit];
// The template of that unit in deploy/. The templates carry the old names.
export const CONSOLE_UNIT_TEMPLATE = OLD_NAMES.unit;

// A template of deploy/, as this install renders it. An install with the old names gets the
// file as it is, so its unit files stay byte for byte the same. A new install gets the same
// text with the new names.
export function unitTemplate(repoDir: string, file: string, n: Readonly<Names> = names()): string {
  const text = readFileSync(join(repoDir, "deploy", file), "utf8");
  if (n.legacy) return text;
  return text
    .replaceAll("ChoiBot", DISPLAY_NAME)
    .replaceAll(/\b[Hh]ylo cron job/g, `${DISPLAY_NAME} cron job`)
    .replaceAll(OLD_NAMES.cronUnitPrefix, n.cronUnitPrefix)
    .replaceAll(OLD_NAMES.unit.replace(/\.service$/, ""), n.unit.replace(/\.service$/, ""));
}

// Vars are an open string map so other renderers (e.g. bin/lib/cronunits.ts)
// can reuse this; `UnitVars` still satisfies it.
export function renderUnit(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{{${k}}}`, v);
  // Any leftover double-brace token is fatal, not just well-formed KEYS: a typo
  // like {{gate_dir}} or {{ REPO_DIR }} must fail here rather than render into a
  // unit file and blow up at `systemctl` time.
  const left = out.match(/\{\{[^}]*\}\}/);
  if (left) throw new Error(`unsubstituted placeholder: ${left[0]}`);
  return out;
}

export function buildPath(parts: string[]): string {
  const seen = new Set<string>();
  for (const p of [...parts, "/usr/local/bin", "/usr/bin", "/bin"]) if (p) seen.add(p);
  return [...seen].join(":");
}
