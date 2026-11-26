// scripts/release/release.mjs — the parts of the release builder (build.sh) that are rules, not
// steps: the entry rules of the tree, app/release.json and index.json (format v1). The
// updater of hosted ChoiBot reads the same files with the same rules. Plain JS, node: builtins only: build.sh runs it with the
// release's own Node, before any package exists.
//
//   node release.mjs check <stage>                         the entry rules of the stage folder
//   node release.mjs release-json <stage> <facts.json>     write <stage>/app/release.json
//   node release.mjs index <out> <facts.json> <stage>      write <out>/index.json (and check it)
//   node release.mjs source <file> [<first parent's file>]  a public tree's version: "<version> <source commit>"
//
// facts.json: {version, commit, channel, builtAt, node, pnpm, gh, file?, notes?, sudoers?}, made by
// build.sh. Every value is checked here again: a wrong one stops the build.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const TOPS = ["app", "node", "gh"];
export const CHANNELS = ["test", "proof", "stable"];
const SHA = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const PLAIN = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
export const NOTES_MAX = 30;
export const NOTE_CHARS = 200;
export const INDEX_MAX = 64 * 1024;

// The root files a release ships (format section 4): `from` is the file in the tar that root
// installs as a byte copy; null is a text that strong-setup renders (build.sh gives it).
export const ROOT_PARTS = [
  { path: "/usr/local/bin/choibot-agent-exec", from: "app/deploy/choibot-agent-exec" },
  { path: "/usr/local/sbin/choibot-first-boot", from: "app/deploy/choibot-first-boot" },
  { path: "/etc/systemd/system/choibot-first-boot.service", from: "app/deploy/choibot-first-boot.service" },
  { path: "/etc/systemd/system/choibot-first-boot.path", from: "app/deploy/choibot-first-boot.path" },
  { path: "/etc/sudoers.d/choibot-agent-exec", from: null },
];

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const fail = (why) => { throw new Error(why); };

// A public tree (format section 2): release-source.json, written by the public export. ONE line
// of JSON and a newline: {"v":1,"version":<the source commit's first-parent count>,"commit":<it>}.
export const SOURCE_FILE = "release-source.json";
export const SOURCE_MAX = 1024;

export function parseSource(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > SOURCE_MAX) fail(`${SOURCE_FILE} is larger than ${SOURCE_MAX} bytes`);
  if (!text.endsWith("\n") || text.indexOf("\n") !== text.length - 1) fail(`${SOURCE_FILE} is not ONE line with a newline at its end`);
  let o;
  try { o = JSON.parse(text); } catch { fail(`${SOURCE_FILE} is not JSON`); }
  if (!o || typeof o !== "object" || Array.isArray(o) || Object.keys(o).sort().join(",") !== "commit,v,version") fail(`${SOURCE_FILE} has not exactly the fields v, version, commit`);
  if (o.v !== 1) fail(`${SOURCE_FILE} is not of format 1`);
  if (!Number.isInteger(o.version) || o.version < 1) fail(`${SOURCE_FILE}: version is not a whole number of 1 or more`);
  if (typeof o.commit !== "string" || !SHA.test(o.commit)) fail(`${SOURCE_FILE}: commit is not a full commit id`);
  return { version: o.version, commit: o.commit };
}

// The version of a public tree's commit. `parent`: the file of the commit's first parent, or null
// (no parent, or a parent with no file). A commit that holds its parent's file is not an export
// (no new source: one source commit gives at most one release); the number only goes up.
export function sourceVersion(text, parent) {
  const s = parseSource(text);
  if (parent !== null) {
    if (parent === text) fail(`the first parent holds the same ${SOURCE_FILE}: this commit is not an export (no new source)`);
    const p = parseSource(parent);
    if (s.version <= p.version) fail(`${SOURCE_FILE}: version ${s.version} is not greater than ${p.version} of the first parent`);
  }
  return s;
}

// The tar's file name (format section 1).
export const tarName = (version, commit) => `choibot-${version}-${commit.slice(0, 12)}-linux-x64.tar.gz`;

// The entry rules (format section 3) on the stage folder, before the tar is made. Returns the
// problems (at most 20), [] when the tree is good. Symbolic links are checked by their text: each
// one is relative and stays inside its own top folder (a chain of such links stays inside too).
export function checkTree(stage) {
  const problems = [];
  const add = (p) => { if (problems.length < 20) problems.push(p); };
  const tops = readdirSync(stage).sort();
  if (tops.join(",") !== [...TOPS].sort().join(",")) add(`the top folders are ${tops.join(", ") || "none"}, not ${TOPS.join(", ")}`);
  const walk = (top, dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const rel = relative(stage, p).split(sep).join("/");
      const st = lstatSync(p);
      const mode = st.mode & 0o7777;
      if (st.isSymbolicLink()) {
        const target = readlinkSync(p);
        if (target.startsWith("/")) { add(`${rel}: a link to an absolute path`); continue; }
        const to = posix.normalize(posix.join(posix.dirname(rel), target));
        if (to !== top && !to.startsWith(`${top}/`)) add(`${rel}: a link out of ${top}/ (${target})`);
        continue;
      }
      if (mode & 0o7000) add(`${rel}: a setuid, setgid or sticky bit`);
      if (st.isDirectory()) {
        if (mode !== 0o755) add(`${rel}: a folder of mode ${mode.toString(8)}, not 755`);
        walk(top, p);
      } else if (st.isFile()) {
        if (mode !== 0o644 && mode !== 0o755) add(`${rel}: a file of mode ${mode.toString(8)}, not 644 or 755`);
      } else {
        add(`${rel}: not a file, a folder or a link (a device, a fifo or a socket)`);
      }
    }
  };
  for (const top of tops) {
    const st = lstatSync(join(stage, top));
    if (!st.isDirectory() || st.isSymbolicLink()) { add(`${top}: not a folder`); continue; }
    walk(top, join(stage, top));
  }
  // What must never be in a release (format section 3, "NOT in the tar").
  for (const p of [".env", ".agent-data", ".services-data", ".widgets-data", ".git", ".next/cache", ".next-build", ".next-prev", ".next-failed", "install.log", "failed-step.log", ".tmp"]) {
    try { lstatSync(join(stage, "app", p)); add(`app/${p}: it must not be in a release`); } catch { /* not there: good */ }
  }
  return problems;
}

// The facts that build.sh gives, checked. `need` names the optional fields that this use needs.
export function checkFacts(f, need = []) {
  if (!f || typeof f !== "object") fail("the facts are not an object");
  if (!Number.isInteger(f.version) || f.version < 1) fail("version is not a whole number of 1 or more");
  if (typeof f.commit !== "string" || !SHA.test(f.commit)) fail("commit is not a full commit id");
  if (!CHANNELS.includes(f.channel)) fail(`channel is not one of ${CHANNELS.join(", ")}`);
  if (typeof f.builtAt !== "string" || !TIME.test(f.builtAt)) fail("builtAt is not a UTC time in seconds");
  for (const k of ["node", "pnpm", "gh"]) if (typeof f[k] !== "string" || !PLAIN.test(f[k])) fail(`${k} is not a plain version`);
  if (need.includes("file") && f.file !== tarName(f.version, f.commit)) fail(`file is not ${tarName(f.version, f.commit)}`);
  if (need.includes("sudoers") && (typeof f.sudoers !== "string" || !f.sudoers.includes("choibot-agent-exec"))) fail("sudoers is not the text of the sudoers file");
  const notes = f.notes ?? [];
  if (!Array.isArray(notes) || notes.some((n) => typeof n !== "string")) fail("notes is not a list of texts");
  return f;
}

// app/release.json (format section 6).
export function releaseJson(f) {
  checkFacts(f);
  return { v: 1, version: f.version, commit: f.commit, channel: f.channel, builtAt: f.builtAt, node: f.node, pnpm: f.pnpm, gh: f.gh };
}

// Plain text, one line, at most NOTE_CHARS: no control character reaches the person's ticket.
export const cleanNote = (s) => {
  const one = s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return one.length > NOTE_CHARS ? `${one.slice(0, NOTE_CHARS - 1)}…` : one;
};

// index.json (format section 4), from the facts, the tar and the stage. The field order is the
// format's.
export function indexJson(f, tar, stage) {
  checkFacts(f, ["file", "sudoers"]);
  const bytes = readFileSync(tar);
  if (basename(tar) !== f.file) fail(`the tar is ${basename(tar)}, not ${f.file}`);
  const rootParts = ROOT_PARTS.map(({ path, from }) => ({
    path, sha256: sha256(from === null ? Buffer.from(f.sudoers, "utf8") : readFileSync(join(stage, from))), from,
  }));
  return {
    v: 1, channel: f.channel, version: f.version, commit: f.commit, builtAt: f.builtAt, file: f.file,
    size: bytes.length, sha256: sha256(bytes), arch: "x86_64", os: "ubuntu-24.04",
    node: f.node, pnpm: f.pnpm, gh: f.gh, minFrom: 0, security: false, expires: null, claude: null,
    rootParts, revoke: [], hold: false, notes: (f.notes ?? []).map(cleanNote).filter((n) => n !== "").slice(0, NOTES_MAX),
  };
}

const FIELDS = ["v", "channel", "version", "commit", "builtAt", "file", "size", "sha256", "arch", "os", "node", "pnpm", "gh", "minFrom", "security", "expires", "claude", "rootParts", "revoke", "hold", "notes"];

// The check that C1 makes of an index (section 4: strict), here on our own output.
export function checkIndex(i) {
  const keys = Object.keys(i);
  if (keys.join(",") !== FIELDS.join(",")) fail(`the index has the fields ${keys.join(", ")}`);
  checkFacts(i, ["file"]);
  if (i.v !== 1 || i.arch !== "x86_64" || i.os !== "ubuntu-24.04") fail("v, arch or os is wrong");
  if (!Number.isInteger(i.size) || i.size < 1 || !HEX64.test(i.sha256)) fail("size or sha256 is wrong");
  if (i.minFrom !== 0 || i.security !== false || i.expires !== null || i.claude !== null || i.hold !== false || i.revoke.length !== 0) fail("a field of a later phase is set");
  if (i.rootParts.length !== ROOT_PARTS.length || i.rootParts.some((r, n) => r.path !== ROOT_PARTS[n].path || r.from !== ROOT_PARTS[n].from || !HEX64.test(r.sha256))) fail("rootParts is wrong");
  if (i.notes.length > NOTES_MAX || i.notes.some((n) => typeof n !== "string" || n.length > NOTE_CHARS)) fail("notes is wrong");
  return i;
}

// Written whole (tmp + rename), with a newline at the end.
function writeJson(file, value, max = Infinity) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(text) > max) fail(`${basename(file)} is larger than ${max} bytes`);
  writeFileSync(`${file}.tmp`, text, { mode: 0o644 });
  renameSync(`${file}.tmp`, file);
}

function main(argv) {
  const [cmd, a, b, c] = argv;
  const facts = () => JSON.parse(readFileSync(b, "utf8"));
  if (cmd === "check") {
    const problems = checkTree(resolve(a));
    for (const p of problems) console.error(`  - ${p}`);
    if (problems.length) fail("the release tree breaks the entry rules (above)");
    return;
  }
  if (cmd === "source") {
    const s = sourceVersion(readFileSync(a, "utf8"), b ? readFileSync(b, "utf8") : null);
    process.stdout.write(`${s.version} ${s.commit}\n`);
    return;
  }
  if (cmd === "release-json") return writeJson(join(resolve(a), "app", "release.json"), releaseJson(facts()));
  if (cmd === "index") {
    const f = facts();
    const out = resolve(a);
    const i = checkIndex(indexJson(f, join(out, f.file), resolve(c ?? fail("give the stage folder"))));
    return writeJson(join(out, "index.json"), i, INDEX_MAX);
  }
  fail("usage: release.mjs check <stage> | release-json <stage> <facts.json> | index <out> <facts.json> <stage> | source <file> [<parent file>]");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(`✖ ${e instanceof Error ? e.message : e}`); process.exit(1); }
}
