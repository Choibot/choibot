// server/agents/runtimes/codex-skills.ts
//
// Codex discovers skills as `SKILL.md` folders under $CODEX_HOME/skills — the
// same format Claude uses, verified to load a Claude skill directory verbatim
// with no frontmatter conversion. So sharing is a symlink farm, not a copy: the
// links point back into ~/.claude, and editing a skill there changes what Codex
// sees on its next launch.
//
// Naming is pure (planSkillLinks) so collisions are testable without touching
// the filesystem: personal skills keep their bare name, plugin skills are
// namespaced <plugin>-<skill>, and anything still colliding gets a numeric
// suffix rather than being silently dropped.
import { readdir, readFile, mkdir, rm, symlink, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

export type SkillSource = { name: string; dir: string };
export type PluginSkills = { plugin: string; skills: SkillSource[] };

// Codepoint order, not localeCompare: localeCompare is ICU- and locale-dependent,
// so it could order two colliding names differently on two hosts and hand the
// "-2" suffix to a different skill. Suffix assignment must be reproducible.
const byCodepoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// A link name becomes a path segment under <codexHome>/skills, and the plugin
// half of it comes from an installed_plugins.json key — external data. `join`
// normalises "..", so an unsanitised key like "../../evil@market" would plant a
// symlink OUTSIDE the farm, where the next rebuild's rm cannot reach it. Flatten
// anything that is not a plain filename character, and neutralise a name that is
// nothing but dots ("." and ".." are directory entries, not names).
function sanitizeName(raw: string): string {
  const flat = raw.replace(/[^A-Za-z0-9._-]/g, "-");
  if (!flat || /^\.+$/.test(flat)) return flat.replace(/\./g, "-") || "skill";
  return flat;
}

export function planSkillLinks(personal: SkillSource[], plugins: PluginSkills[]): SkillSource[] {
  const taken = new Set<string>();
  const out: SkillSource[] = [];
  const claim = (want: string, dir: string): void => {
    let name = sanitizeName(want);
    const base = name;
    for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
    taken.add(name);
    out.push({ name, dir });
  };
  // Personal first: a name they already use must not be stolen by a plugin.
  const bySkill = (a: SkillSource, b: SkillSource): number =>
    byCodepoint(a.name, b.name) || byCodepoint(a.dir, b.dir);
  for (const s of [...personal].sort(bySkill)) claim(s.name, s.dir);
  // Two marketplaces can ship the same display name (the "@market" half is
  // dropped), and Array.sort is stable — so sorting on `plugin` alone would let
  // input order decide which one gets the "-2" suffix. Tiebreak on the skill
  // dirs, which are unique, so the assignment never churns between launches.
  const byDirs = (a: PluginSkills, b: PluginSkills): number => {
    const da = a.skills.map((s) => s.dir).sort(byCodepoint);
    const db = b.skills.map((s) => s.dir).sort(byCodepoint);
    for (let i = 0; i < Math.max(da.length, db.length); i++) {
      const c = byCodepoint(da[i] ?? "", db[i] ?? "");
      if (c) return c;
    }
    return 0;
  };
  const sorted = [...plugins].sort((a, b) => byCodepoint(a.plugin, b.plugin) || byDirs(a, b));
  for (const p of sorted) {
    for (const s of [...p.skills].sort(bySkill)) {
      claim(`${p.plugin}-${s.name}`, s.dir);
    }
  }
  return out;
}

// A directory is a skill only if it holds a SKILL.md. Anything else in the
// skills dir (stray files, a half-written folder) is skipped, not an error.
async function skillDirsIn(root: string): Promise<SkillSource[]> {
  let entries: string[];
  try { entries = await readdir(root); } catch { return []; }
  const out: SkillSource[] = [];
  for (const name of entries.sort(byCodepoint)) {
    if (name.startsWith(".")) continue;
    const dir = join(root, name);
    try {
      if (!(await stat(join(dir, "SKILL.md"))).isFile()) continue;
    } catch { continue; }
    out.push({ name, dir });
  }
  return out;
}

export async function discoverSkills(claudeHome = join(homedir(), ".claude")): Promise<SkillSource[]> {
  return skillDirsIn(join(claudeHome, "skills"));
}

// Plugin skills come from installed_plugins.json, not from globbing the cache:
// the cache keeps superseded versions, and only the installed one should be
// shared. Keys look like "superpowers@claude-plugins-official"; the part before
// the @ is the display name and the namespace prefix.
export async function discoverPluginSkills(
  claudeHome = join(homedir(), ".claude"),
): Promise<PluginSkills[]> {
  let manifest: { plugins?: Record<string, { installPath?: string }[]> };
  try {
    manifest = JSON.parse(await readFile(join(claudeHome, "plugins", "installed_plugins.json"), "utf8"));
  } catch { return []; }
  const out: PluginSkills[] = [];
  for (const [key, installs] of Object.entries(manifest.plugins ?? {})) {
    const installPath = installs?.[0]?.installPath;
    if (!installPath) continue;
    const skills = await skillDirsIn(join(installPath, "skills"));
    if (skills.length) out.push({ plugin: key.split("@")[0], skills });
  }
  return out;
}

// Rebuild the farm from scratch on every call. It is a directory of symlinks,
// so this is cheap, and starting clean is what keeps an uninstalled plugin's
// skills from lingering in an agent's home.
export async function linkSkills(codexHome: string, links: SkillSource[]): Promise<number> {
  const dir = resolve(codexHome, "skills");
  // An unwritable or unusable farm dir (EACCES, EROFS, ENOSPC, ENOTDIR) is a
  // degraded path like any other: report zero skills, never fail the launch.
  try {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
  } catch { return 0; }
  let linked = 0;
  for (const l of links) {
    // Defence in depth behind sanitizeName: whatever the name, the link must
    // land strictly inside the farm — the only place a rebuild can clean up.
    const link = resolve(dir, l.name);
    if (!link.startsWith(dir + sep)) continue;
    try {
      // Absolute target: a relative dir would be stat'd against process.cwd()
      // but resolved against the farm dir, giving a dangling link that still
      // counts as a success.
      const src = resolve(l.dir);
      await stat(src);                // a vanished source is skipped, never fatal
      await symlink(src, link);
      linked++;
    } catch { /* skip this skill */ }
  }
  return linked;
}

// The whole farm, end to end. Returns how many skills the agent will see.
export async function buildSkillFarm(
  codexHome: string, claudeHome = join(homedir(), ".claude"),
): Promise<number> {
  const [personal, plugins] = await Promise.all([
    discoverSkills(claudeHome),
    discoverPluginSkills(claudeHome),
  ]);
  return linkSkills(codexHome, planSkillLinks(personal, plugins));
}
