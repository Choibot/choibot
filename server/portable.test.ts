// server/portable.test.ts — a clean clone must work under any Unix user and in any directory,
// and must not carry anybody's own set-up. This test fails when a shipped file names a real
// home dir, a real tailnet host or a real e-mail address. The repo holds only these generic
// patterns. An owner adds their own private words (an org, an account, a share host, a skill
// name) in a file outside the repo, named by OWNER_MARKS_FILE: one word per line, `#` starts a
// comment, matched in any case. Unset = only the generic patterns run.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// Shipped = the tracked files in these dirs and at the repo root. Not shipped: tests and their
// fixtures, and docs/ (the record of past plans and specs).
const SHIPPED_DIRS = ["server", "src", "bin", "scripts", "deploy", "plugins"];
const NOT_SHIPPED = /(^|\/)testdata\/|\.test\.tsx?$|\.fixtures\.ts$|(^|\/)testkit\.ts$/;

type Mark = { what: string; found: (line: string) => boolean; quote: boolean };

// A tailnet name of the docs' placeholders (console.your-tailnet.ts.net).
const PLACEHOLDER_TAILNETS = ["your-tailnet", "example"];

// Reserved or not personal: example and .invalid/.test domains, noreply senders, git URLs.
function placeholderEmail(local: string, domain: string): boolean {
  const d = domain.toLowerCase();
  return /(^|\.)(example\.(com|org|net)|invalid|example|test|localhost)$/.test(d)
    || /^no-?reply$/i.test(local) || d.endsWith("users.noreply.github.com")
    || (d === "github.com" && (local === "git" || local === "token"));
}

const GENERIC_MARKS: Mark[] = [
  // /home/you is the placeholder of every example; choibot-agent is the agent user strong mode makes,
  // choibot-chief its second account (the persistent agents', server/chief/chiefaccount.ts).
  { what: "a real home dir (use os.homedir(), $HOME or /home/you)", quote: true,
    found: (l) => /\/home\/(?!you\b|choibot-agent\b|choibot-chief\b)[a-z_][a-z0-9_-]*/.test(l) },
  { what: "a real tailnet host (use <machine-name>.<your-tailnet>.ts.net)", quote: true,
    found: (l) => [...l.matchAll(/([a-z0-9-]+)\.ts\.net\b/gi)].some((m) => !PLACEHOLDER_TAILNETS.includes(m[1].toLowerCase())) },
  { what: "a real e-mail address (use someone@example.invalid)", quote: true,
    found: (l) => [...l.matchAll(/([A-Za-z0-9._%+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g)]
      .some((m) => !placeholderEmail(m[1], m[2])) },
];

// The owner's words. A hit names the word's line number in the file, never the word itself or
// the line it was found on, so a test log does not repeat a private word.
function ownerWordMarks(file: string | undefined): Mark[] {
  if (!file?.trim()) return [];
  const words = readFileSync(file.trim(), "utf8").split("\n").map((l, i) => [l.trim().toLowerCase(), i + 1] as const);
  return words.filter(([w]) => w && !w.startsWith("#"))
    .map(([w, n]) => ({ what: `word ${n} of OWNER_MARKS_FILE`, quote: false, found: (l: string) => l.toLowerCase().includes(w) }));
}

function shippedFiles(): string[] {
  const all = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
  return all.filter((f) => (!f.includes("/") || SHIPPED_DIRS.includes(f.split("/")[0])) && !NOT_SHIPPED.test(f));
}

function hits(text: string, marks: Mark[]): string[] {
  const out: string[] = [];
  text.split("\n").forEach((line, i) => {
    for (const m of marks) if (m.found(line)) out.push(`${i + 1}: ${m.what}${m.quote ? `: ${line.trim().slice(0, 120)}` : ""}`);
  });
  return out;
}

describe("portable core", () => {
  it("each generic mark catches its sample and spares the placeholders", () => {
    expect(hits("cd /home/alice/workspace", GENERIC_MARKS)).toHaveLength(1);
    expect(hits("ROOT=/home/ops/x; /home/admin", GENERIC_MARKS)).toHaveLength(1);
    expect(hits("https://console.tail1234ab.ts.net", GENERIC_MARKS)).toHaveLength(1);
    expect(hits("mail alice.smith@gmail.com", GENERIC_MARKS)).toHaveLength(1);
    expect(hits('"/home/you/workspace", "/home/choibot-agent/.claude", "$ROOT/home/.config"', GENERIC_MARKS)).toEqual([]);
    expect(hits("https://console.your-tailnet.ts.net and https://<machine-name>.<your-tailnet>.ts.net", GENERIC_MARKS)).toEqual([]);
    expect(hits("chief-test@example.invalid, git@github.com:a/b, https://token@github.com/a/b, noreply@anthropic.com", GENERIC_MARKS)).toEqual([]);
    expect(hits('"@fastify/cookie": "^11", next@15.5.29', GENERIC_MARKS)).toEqual([]);
  });

  it("OWNER_MARKS_FILE adds its words, in any case, and a hit does not repeat the word", () => {
    const dir = mkdtempSync(join(tmpdir(), "owner-marks-"));
    try {
      const file = join(dir, "marks.txt");
      writeFileSync(file, "# the owner's words\n\nAcme-Corp\nshare.acme.test\n");
      const marks = ownerWordMarks(file);
      expect(marks).toHaveLength(2);
      expect(hits("git clone https://github.com/ACME-corp/x", marks)).toEqual(["1: word 3 of OWNER_MARKS_FILE"]);
      expect(hits("nothing here", marks)).toEqual([]);
      expect(ownerWordMarks(undefined)).toEqual([]);
      expect(ownerWordMarks(" ")).toEqual([]);
      expect(() => ownerWordMarks(join(dir, "missing.txt"))).toThrow(); // a set key must name a real file
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the scan sees the shipped code and skips tests and docs", () => {
    const files = shippedFiles();
    for (const f of ["server/index.ts", "bin/choibot.ts", "scripts/console-watchdog.sh", "deploy/RUNBOOK.md", ".env.example"]) {
      expect(files, f).toContain(f);
    }
    expect(files.some((f) => /\.test\.tsx?$|^docs\//.test(f))).toBe(false);
  });

  it("no shipped file carries a real home dir, tailnet host, e-mail address or an owner's word", () => {
    const marks = [...GENERIC_MARKS, ...ownerWordMarks(process.env.OWNER_MARKS_FILE)];
    const found: string[] = [];
    for (const f of shippedFiles()) {
      let text: string;
      try {
        text = readFileSync(join(ROOT, f), "utf8");
      } catch {
        continue; // a deleted but still tracked file
      }
      if (text.includes("\0")) continue; // binary (fonts, images)
      for (const h of hits(text, marks)) found.push(`${f}:${h}`);
    }
    expect(found).toEqual([]);
  });
});
