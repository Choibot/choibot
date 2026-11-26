// The one writer every chief store uses: one promise chain per path, atomic
// tmp+rename for JSON files, append for JSONL files. Files 0600, dirs 0700.
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const chains = new Map<string, Promise<unknown>>();

// Run fn after every earlier fn for this key has settled (same pattern as
// IssueStore.queue). A throw never blocks the chain.
export function onChain<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => { /* a failed step must not block the chain */ });
  chains.set(key, tail);
  void tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  return next;
}

export async function atomicWrite(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, data, { mode: 0o600 });
  await rename(tmp, path);
}

export function writeJson(path: string, value: unknown): Promise<void> {
  return onChain(path, () => atomicWrite(path, JSON.stringify(value, null, 2)));
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (err) {
    // Missing or corrupt file reads as null. Any other error (EMFILE, EIO,
    // EACCES) must surface, or updateJson would overwrite good data.
    if (isEnoent(err) || err instanceof SyntaxError) return null;
    throw err;
  }
}

export function updateJson<T>(path: string, fallback: T, fn: (cur: T) => T): Promise<T> {
  return onChain(path, async () => {
    const next = fn((await readJson<T>(path)) ?? fallback);
    await atomicWrite(path, JSON.stringify(next, null, 2));
    return next;
  });
}

export function appendJsonl(path: string, obj: unknown): Promise<void> {
  return onChain(path, () => appendJsonlRaw(path, [obj]));
}

// Append objs as JSONL lines in one write. Takes no chain: the caller holds
// onChain(path). A crash mid-append leaves a torn last line with no "\n":
// start a new line first, so the torn line stays alone (parseJsonl skips it)
// and these lines survive.
export async function appendJsonlRaw(path: string, objs: readonly unknown[]): Promise<void> {
  if (objs.length === 0) return;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const fh = await open(path, "a+", 0o600);
  try {
    const { size } = await fh.stat();
    const last = size > 0 ? (await fh.read(Buffer.alloc(1), 0, 1, size - 1)).buffer[0] : undefined;
    const sep = last !== undefined && last !== 0x0a ? "\n" : "";
    await fh.appendFile(sep + objs.map((o) => JSON.stringify(o) + "\n").join(""));
  } finally {
    await fh.close();
  }
}

// The file's text; a missing file reads as "".
export async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (isEnoent(err)) return "";
    throw err;
  }
}

export async function readJsonl<T>(path: string): Promise<T[]> {
  return parseJsonl<T>(await readText(path));
}

export function parseJsonl<T>(text: string): T[] {
  const out: T[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as T); } catch { /* skip a torn line */ }
  }
  return out;
}
