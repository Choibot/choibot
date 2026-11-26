// bin/lib/install.test.ts — install.sh, read as text. The script itself runs in
// scripts/install-test/run.sh (a throwaway folder with fakes); here are the rules that a read
// of the file can hold.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLI_NAME, CLI_SHORT_NAME, DISPLAY_NAME } from "../../server/brand.js";
import { NODE_MIN } from "../../server/setup/steps.js";

const FILE = fileURLToPath(new URL("../../install.sh", import.meta.url));
const whole = readFileSync(FILE, "utf8");
// Without the here-document: the command file that the script writes, not lines of the script.
const text = whole.replace(/<<EOF\n[\s\S]*?\nEOF\n/, "<<EOF\nEOF\n");
const value = (name: string): string => text.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1] ?? "";
// The lines that run: no comment line, and no text of a here-document that is only printed.
const code = text.split("\n").filter((l) => !/^\s*#/.test(l));

describe("install.sh", () => {
  it("takes its names from the brand constants", () => {
    expect(value("NAME")).toBe(DISPLAY_NAME);
    expect(value("CLI")).toBe(CLI_NAME);
    expect(value("CLI_SHORT")).toBe(CLI_SHORT_NAME);
    // Every other place uses the variables.
    expect(code.filter((l) => /ChoiBot|choibot/.test(l.replace(/CHOIBOT_[A-Z]+/g, "")) && !/^(NAME|CLI)=/.test(l))).toEqual([]);
  });

  it("parses as sh and as bash, and runs nothing when the download was cut", () => {
    for (const sh of ["sh", "bash"]) execFileSync(sh, ["-n", FILE]);
    expect(whole).not.toBe(text);
    expect(text.trimEnd().split("\n").pop()).toBe('main "$@"');
    // Everything above the last line is a function, a constant or a comment.
    const top = text.split("\n").filter((l) => /^[a-z]/.test(l) && !/^[a-z_]+\(\) \{/.test(l));
    expect(top).toEqual(["set -eu", 'main "$@"']);
  });

  it("never runs sudo: the word is only in a text that the script prints", () => {
    const withSudo = code.filter((l) => /\bsudo\b/.test(l));
    expect(withSudo.length).toBeGreaterThan(0);
    // A printed text, an argument of need_root (which prints it), or the removal of the word.
    for (const l of withSudo) expect(l, l).toMatch(/^\s*(printf '|"|need_root )|sudo loginctl enable-linger \$USER_NAME" services_ready$|sed 's\/\^sudo \/\/'/);
    // No way to run a text as a command.
    expect(code.filter((l) => /\beval\b|\bsh -c\b/.test(l))).toEqual([]);
  });

  it("pins its Node: a version the console can run, and a SHA-256 for each archive", () => {
    expect(Number(value("NODE_VERSION").split(".")[0])).toBeGreaterThanOrEqual(NODE_MIN);
    expect(value("NODE_SHA256_x64")).toMatch(/^[0-9a-f]{64}$/);
    expect(value("NODE_SHA256_arm64")).toMatch(/^[0-9a-f]{64}$/);
    expect(value("PNPM_VERSION")).toMatch(/^\d+\.\d+\.\d+$/);
    expect(value("GH_SHA256_amd64")).toMatch(/^[0-9a-f]{64}$/);
    expect(value("GH_SHA256_arm64")).toMatch(/^[0-9a-f]{64}$/);
    // Both downloads go through the one function that checks, and each gives its pinned value.
    expect(text).toContain('if [ "$(sha256sum "$TMP/$2" | cut -d\' \' -f1)" != "$3" ]; then');
    expect(text.match(/fetch_checked "https:[^"]+" "\$g[ng]_file" "\$(NODE|GH)_SHA256"/g)).toHaveLength(2);
    expect(text.match(/curl [^\n]*-o /g)).toHaveLength(3);
  });

  it("uses the gh of the server only when it knows the words of the repo copy", () => {
    // "Pick a repo" runs `gh repo clone … --no-upstream`; the gh 2.45 of Ubuntu 24.04 has no such word.
    const repopick = readFileSync(fileURLToPath(new URL("../../server/setup/repopick.ts", import.meta.url)), "utf8");
    expect(repopick).toContain('"repo", "clone", slug, dest, "--no-upstream"');
    expect(text).toContain("gh repo clone --help 2>/dev/null | grep -q -e '--no-upstream'");
    // get_gh decides with that test, not with "a gh is there".
    const getGh = text.slice(text.indexOf("get_gh() {"), text.indexOf("# The set-up, with its output kept"));
    expect(getGh).toMatch(/^get_gh\(\) \{\n {2}if gh_ready; then\n/);
    // Its own copy never goes over a file of the person.
    expect(getGh).toContain('if [ -e "$gg_link" ] && [ ! -L "$gg_link" ]; then');
  });

  it("has no download address of its own: the code comes from the one variable", () => {
    const urls = [...text.matchAll(/https?:\/\/[^\s"')]+/g)].map((m) => m[0].replace(/[.,;]$/, ""));
    expect([...new Set(urls)].sort()).toEqual([
      "https://$cn_host",
      "https://claude.ai/install.sh",
      "https://code.claude.com/docs/en/setup",
      "https://github.com/cli/cli/releases/download/v$GH_VERSION/$gg_file",
      "https://nodejs.org/dist/v$NODE_VERSION/$gn_file",
      "https://nodejs.org/dist/v<version>/SHASUMS256.txt",
    ]);
  });
});
