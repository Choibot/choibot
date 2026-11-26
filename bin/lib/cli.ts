// bin/lib/cli.ts
export type Cli = { command: string; target?: string; rest: string[]; flags: Record<string, string | true>; help: boolean };

// Flags that never take a value: `--open x` leaves `x` positional.
export const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(["dry-run", "open", "mine", "force", "help", "apply", "no-jev", "details", "auto", "brief", "print-facts", "accept-used-server"]);

export function parseCli(argv: string[]): Cli {
  const help = argv.length === 0 || argv.includes("--help") || argv.includes("-h");
  const words: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--") && a.length > 2) {
      const eq = a.indexOf("=");
      if (eq > 2) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const name = a.slice(2);
      const next = argv[i + 1];
      if (!BOOLEAN_FLAGS.has(name) && next !== undefined && !next.startsWith("-")) { flags[name] = next; i++; }
      else flags[name] = true;
    } else if (!a.startsWith("-")) words.push(a);
    // other `-x` words (e.g. -h) are dropped, as before
  }
  return { command: words[0] ?? "help", target: words[1], rest: words.slice(2), flags, help };
}
