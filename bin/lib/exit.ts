// bin/lib/exit.ts — end the CLI only after stdout and stderr are flushed.
// process.exit() drops what is still pending on a pipe: only the first pipe
// buffer (64 KB on Linux) is written at once, so a reader got cut JSON.

// A reader that closed the pipe (`choibot queue list | head -1`) is not an error:
// without a listener, EPIPE is an uncaught exception with a stack trace.
export function ignoreEpipe(): void {
  for (const s of [process.stdout, process.stderr]) {
    s.on("error", (e: NodeJS.ErrnoException) => { if (e.code !== "EPIPE") throw e; });
  }
}

// The callback of an empty write runs after all earlier writes are done (or
// have failed), on a pipe, a file and a TTY.
const flushed = (s: NodeJS.WriteStream) => new Promise<void>((done) => { s.write("", () => done()); });

// Exits explicitly, so an open socket or timer cannot keep the process alive.
export async function exitAfterFlush(code: number): Promise<never> {
  await Promise.all([flushed(process.stdout), flushed(process.stderr)]);
  process.exit(code);
}
