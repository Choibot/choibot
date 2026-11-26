// server/guide/secret.ts — the guard that stops a secret a user types into the guide's chat.
// A secret (a token, a password, a key) goes only into the form of its step. This file says if
// a text holds something that looks like one, and where that kind belongs.
//
// The guard runs two times on the same patterns: in the chat box, before the text leaves the
// browser, and on the server, before the text reaches the model, the thread file or a log. A
// hit is never stored and never quoted: the answer names the kind, not the value.
//
// What it covers (the secret kinds this product uses, and the common ones next to them):
//   telegram   a Telegram bot token                       123456789:AAF…
//   github     a GitHub token                             ghp_… gho_… ghu_… ghs_… ghr_… github_pat_…
//   anthropic  an Anthropic key or a Claude login token   sk-ant-…
//   key        a key of another service                   sk-… (OpenAI and the like), tskey-… (Tailscale),
//                                                         a private key block, a long random text
//   password   a password, or a secret with its name      "password: …", "token=…", user:pass@ in an address
// It does not cover: a short password with no name next to it. No pattern can know that one.
//
// A leaf module with no import: the browser bundle loads it too.

export type SecretKind = "telegram" | "github" | "anthropic" | "key" | "password";

// The step whose form takes this kind of secret, when the list has one.
export type SecretStep = "telegram" | "github" | "claude";

export type SecretHit = {
  kind: SecretKind;
  // "a Telegram bot token": how the kind is named to the user.
  what: string;
  // Where it belongs, in plain words.
  where: string;
  step?: SecretStep;
};

const WHAT: Record<SecretKind, string> = {
  telegram: "a Telegram bot token",
  github: "a GitHub token",
  anthropic: "an Anthropic key",
  key: "a key or a token",
  password: "a password or a token",
};

const WHERE: Record<SecretKind, string> = {
  telegram: "A Telegram bot token goes into the form of the step “Telegram”.",
  github: "GitHub needs no token here. The step “Connect GitHub” uses a one-time code.",
  anthropic: "The console works with the Claude login of your server. It needs no key.",
  key: "The set-up needs no key in this chat. A secret goes only into the form of its step.",
  password: "The set-up needs no password in this chat. A secret goes only into the form of its step.",
};

const STEP: Partial<Record<SecretKind, SecretStep>> = { telegram: "telegram", github: "github", anthropic: "claude" };

// The first pattern that matches gives the kind, so the named kinds are before the wide ones.
const PATTERNS: readonly [SecretKind, RegExp][] = [
  // The lookbehind keeps a long run of digits linear.
  ["telegram", /(?<!\d)\d{6,}:[A-Za-z0-9_-]{30,}/],
  ["github", /\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/],
  ["anthropic", /\bsk-ant-[A-Za-z0-9_-]{8,}/],
  ["key", /\bsk-[A-Za-z0-9_-]{20,}/],
  ["key", /\btskey-[A-Za-z0-9-]{8,}/],
  ["key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  // user:password@ in an address (the user part has no ":", so the match is linear).
  ["password", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]*:[^\s/@]+@/i],
  // A secret with its name: the value has 8 characters or more and a digit in it, so "token:
  // expired" and "password = missing" pass.
  ["password", /\b(?:password|passwd|pwd|passphrase|secret|token|api[ _-]?key)\b\s*[:=]\s*["']?(?=[^\s"']*\d)[^\s"']{8,}/i],
];

// The tokens of a known kind (the first five patterns): the file browser of the Server page
// refuses a file that holds one next to a secret name (server/files/keylike.ts).
export const TOKEN_RES: readonly RegExp[] = PATTERNS.slice(0, 5).map(([, re]) => re);

// A long random text: 32 characters or more of letters, digits, "-" and "_", with an upper-case
// letter, a lower-case letter and a digit in it. A commit id (lower-case hex) and a normal word
// do not match.
const LONG_RUN = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g;
const random = (run: string): boolean => /[A-Z]/.test(run) && /[a-z]/.test(run) && /\d/.test(run);

// The patterns read this much of a text. A longer text is refused by its length before this.
export const SECRET_SCAN_MAX = 20_000;

const hitOf = (kind: SecretKind): SecretHit => ({ kind, what: WHAT[kind], where: WHERE[kind], ...(STEP[kind] ? { step: STEP[kind] } : {}) });

// What the user reads for a kind, or null for a word that is not a kind.
export const secretOfKind = (kind: string): SecretHit | null => (Object.hasOwn(WHAT, kind) ? hitOf(kind as SecretKind) : null);

// The kind of secret in a text, or null. The answer holds no part of the text.
export function findSecret(text: string): SecretHit | null {
  const t = text.slice(0, SECRET_SCAN_MAX);
  let kind: SecretKind | null = null;
  for (const [k, re] of PATTERNS) if (re.test(t)) { kind = k; break; }
  if (!kind) for (const m of t.matchAll(LONG_RUN)) if (random(m[0])) { kind = "key"; break; }
  return kind ? hitOf(kind) : null;
}

// The line the user reads when a message is stopped.
export function stoppedLine(hit: Pick<SecretHit, "what" | "where">): string {
  return `This message was not sent: it looks like it holds ${hit.what}. It was not stored. ${hit.where}`;
}
