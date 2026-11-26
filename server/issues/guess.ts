// server/issues/guess.ts — guess the repo of an issue with TypeSafe's Jev
// (`jev choice`, a typed one-of-N decision in < 1 s). The best guess is always
// kept, even when jev is unsure: the card marks it and the Fix tap confirms it.
// A failure degrades to "no guess" and never blocks the card.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type RepoGuess = { repo: string | null; confidence: number };
export type JevRunner = (args: string[]) => Promise<string>;

// Below this the card shows the repo as a guess for the user to check.
export const GUESS_MIN_CONFIDENCE = 0.7;
export const JEV_TEXT_MAX = 4000; // keeps argv far below the kernel's per-arg limit
const QUESTION = "Which workspace repository does this issue report belong to?";

// The console runs as a systemd user service whose PATH may lack ~/.local/bin.
function jevBin(): string {
  const p = join(homedir(), ".local", "bin", "jev");
  return existsSync(p) ? p : "jev";
}

export const defaultJev: JevRunner = (args) =>
  new Promise((resolve, reject) => {
    execFile(jevBin(), args, { timeout: 15_000, maxBuffer: 1024 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(String(stdout)));
  });

export async function guessRepo(text: string, repos: string[], run: JevRunner = defaultJev): Promise<RepoGuess> {
  const names = [...new Set(repos.filter((r) => r && !r.includes("=")))];
  if (names.length === 0) return { repo: null, confidence: 0 };
  if (names.length === 1) return { repo: names[0], confidence: 1 }; // jev needs ≥ 2 options
  const body = text.trim().slice(0, JEV_TEXT_MAX) || "(no text — screenshot only)";
  const args = ["choice", QUESTION, ...names.map((n) => `--option=${n}`), `--text=${body}`, "--raw"];
  try {
    const out = JSON.parse(await run(args)) as { answers?: Record<string, { choice?: unknown; confidence?: unknown }> };
    const a = Object.values(out.answers ?? {})[0];
    const choice = typeof a?.choice === "string" ? a.choice : null;
    const confidence = typeof a?.confidence === "number" && Number.isFinite(a.confidence) ? a.confidence : 0;
    if (!choice || !names.includes(choice)) return { repo: null, confidence };
    return { repo: choice, confidence };
  } catch {
    return { repo: null, confidence: 0 };
  }
}
