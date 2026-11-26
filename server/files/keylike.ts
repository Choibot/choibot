// server/files/keylike.ts — does the text of a file look like a key? The path rules (./wide.ts)
// know a secret by its place and its name. A key in a file with a plain name (payer.json,
// notes.txt) is known only by its content, so the content route checks the bytes it read before
// it sends them. Pure: a text in, yes or no out. Nothing of the text goes anywhere else.
//
// It says yes for:
//   - a private key block (-----BEGIN … PRIVATE KEY-----),
//   - a Solana keypair: the whole file is a JSON list of exactly 64 numbers from 0 to 255,
//   - a seed phrase: the whole file is 12, 15, 18, 21 or 24 lower-case words (a number before a
//     word is allowed) and nothing else,
//   - a token of a known kind (Telegram, GitHub, Anthropic, sk-…, tskey-…: server/guide/secret.ts)
//     on a line that also has the name of a secret (token, key, secret, password, auth, bearer).
//   - a file that is ONE text and nothing else: 64 or 128 hex characters (a private key of an
//     Ethereum-style chain) or 80 to 90 base58 characters (a Solana secret key as text),
//   - a line with the NAME of a secret (private_key, secret_key, mnemonic, seed, passphrase,
//     api_key and the like), then "=" or ":", then one long value (32 or more characters of
//     base58, hex or base64), also when the kind of the token is not known.
// It says no for a lock file, a list of hashes and a public key: a name like "integrity",
// "sha256", "checksum" or "public_key" is not the name of a secret.
// It cannot know: a password or a key of an unknown form with no mark around it.
import { TOKEN_RES } from "../guide/secret.js";

const KEY_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/;
const NUMBER_LIST = /^\[\s*\d{1,3}(\s*,\s*\d{1,3}){63}\s*\]$/;
const SEED_COUNTS = new Set([12, 15, 18, 21, 24]);
const SECRET_NAME = /token|key|secret|passw|pwd|auth|bearer|credential/i;
// A longer line is cut: the patterns stay fast on a file that is one long line.
const LINE_MAX = 4000;

function solanaKeypair(text: string): boolean {
  const t = text.trim();
  return t.length < 400 && NUMBER_LIST.test(t) && t.slice(1, -1).split(",").every((n) => Number(n) <= 255);
}

function seedPhrase(text: string): boolean {
  if (text.length > 600) return false;
  // "1. word" and "1) word": the number is not a word.
  const words = text.trim().split(/\s+/).filter((w) => !/^\d{1,2}[.):]?$/.test(w));
  return SEED_COUNTS.has(words.length) && words.every((w) => /^[a-z]{3,8}$/.test(w));
}

function namedToken(text: string): boolean {
  for (const raw of text.split("\n")) {
    const line = raw.length > LINE_MAX ? raw.slice(0, LINE_MAX) : raw;
    if (SECRET_NAME.test(line) && TOKEN_RES.some((re) => re.test(line))) return true;
  }
  return false;
}

const ONE_HEX = /^(0x)?([0-9a-fA-F]{64}|[0-9a-fA-F]{128})$/;
const ONE_BASE58 = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;
const oneText = (text: string): boolean => {
  if (text.length > 200) return false;
  const t = text.trim();
  return ONE_HEX.test(t) || ONE_BASE58.test(t);
};

// The name of a secret as a whole name (private_key, SECRET_KEY, apiKey, seed, mnemonic), then
// "=" or ":", then one long value. "public_key", "key_id" and "integrity" are no such name.
const NAMED_VALUE = /(?<![A-Za-z0-9])["']?(?:[A-Za-z0-9]+[_-])*(?:private[_-]?key|secret[_-]?key|secret|mnemonic|seed(?:[_-]?phrase)?|passphrase|api[_-]?key|access[_-]?key|auth[_-]?token|access[_-]?token)["']?\s*[:=]\s*["']?([A-Za-z0-9+/_-]{32,}={0,2})(?![A-Za-z0-9+/_=-])/i;
const PUBLIC_NAME = /public|pub[_-]?key|key[_-]?id|integrity|checksum|sha\d*|hash|digest|commit|fingerprint/i;

function namedValue(text: string): boolean {
  for (const raw of text.split("\n")) {
    const line = raw.length > LINE_MAX ? raw.slice(0, LINE_MAX) : raw;
    const m = NAMED_VALUE.exec(line);
    if (m && !PUBLIC_NAME.test(line.slice(0, m.index + m[0].length - m[1].length))) return true;
  }
  return false;
}

export function looksLikeKey(text: string): boolean {
  return KEY_BLOCK.test(text) || solanaKeypair(text) || seedPhrase(text) || oneText(text) || namedToken(text) || namedValue(text);
}
