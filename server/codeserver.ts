// server/codeserver.ts
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { FastifyInstance } from "fastify";
import httpProxy from "@fastify/http-proxy";
import { hardenedDeployment } from "./chief/hardened.js";

const BIND = process.env.CODE_SERVER_BIND ?? "127.0.0.1:8081";
const WORKSPACE = process.env.WORKSPACE_DIR ?? process.cwd();

// Overview decision 45: a hardened deployment has no editor — no code-server
// and no /editor proxy. code-server's own terminal is a console-uid shell, and
// window.open('/editor/…') cannot carry x-choibot-user.
export function editorOff(env: Record<string, string | undefined> = process.env): boolean {
  return hardenedDeployment(env);
}

export function startCodeServer(env: Record<string, string | undefined> = process.env): ChildProcess | null {
  if (editorOff(env)) {
    console.log("[code-server] hardened deployment — /editor off");
    return null;
  }
  // Not every host has code-server installed; spawning it anyway only produces
  // an ENOENT error line on every boot. Probe first and disable /editor quietly.
  if (spawnSync("sh", ["-c", "command -v code-server"]).status !== 0) {
    console.log("[code-server] not installed — /editor disabled");
    return null;
  }
  // Strip PORT from the child env: code-server treats $PORT as its own listen
  // port, which would override --bind-addr and collide with the console's port.
  const { PORT: _consolePort, ...childEnv } = process.env;
  const child = spawn(
    "code-server",
    ["--auth", "none", "--bind-addr", BIND, "--abs-proxy-base-path", "/editor", WORKSPACE],
    { stdio: "inherit", env: childEnv },
  );
  child.on("error", (e) => console.error(`[code-server] ${e.message}`));
  // Kill code-server when the console process exits, so it doesn't orphan and
  // hold :8081 — otherwise the next start hits EADDRINUSE and the proxy ends up
  // pointing at a stale instance.
  const stop = () => { try { child.kill("SIGTERM"); } catch { /* already gone */ } };
  process.once("exit", stop);
  process.once("SIGINT", () => { stop(); process.exit(0); });
  process.once("SIGTERM", () => { stop(); process.exit(0); });
  return child;
}

// The address of the editor on the console.
const EDITOR_PREFIX = "/editor";
const underEditor = (url: string | undefined): boolean => {
  const path = (url ?? "").split("?")[0];
  return path === EDITOR_PREFIX || path.startsWith(`${EDITOR_PREFIX}/`);
};

export function registerEditorProxy(
  app: FastifyInstance, env: Record<string, string | undefined> = process.env, upstream = `http://${BIND}`,
): void {
  if (editorOff(env)) return;
  // A plugin of its own, so the code below runs right after the proxy plugin has loaded.
  app.register(async (scope) => {
    const before = new Set(scope.server.listeners("upgrade"));
    // code-server serves its workbench at the upstream root ("/"), while
    // --abs-proxy-base-path=/editor makes it EMIT asset URLs already prefixed with
    // /editor. So strip the /editor prefix before forwarding upstream.
    await scope.register(httpProxy, {
      upstream,
      prefix: EDITOR_PREFIX,
      rewritePrefix: "/",
      websocket: true,
      // Disable per-message-deflate on BOTH legs of the WS proxy. The browser
      // negotiates compression with the proxy's ws-server, and the proxy
      // separately negotiates with code-server's ws — a mismatch corrupts the
      // binary frames of code-server's connection handshake, so the workbench
      // upgrades (101) but never completes its management connection
      // ("workbench failed to connect / Time limit reached"). Forcing no
      // compression on both sides keeps the frames byte-identical end to end.
      wsServerOptions: { perMessageDeflate: false },
      wsClientOptions: { perMessageDeflate: false },
    });
    // Two plugins listen to EVERY socket upgrade of the server and each one sends it through
    // the router: the console's own socket plugin (registered before this one) and this proxy.
    // The second one found the socket taken and threw outside every handler: an
    // "uncaughtException … ERR_HTTP_SOCKET_ASSIGNED" line in the log for each socket (the
    // console went on, by the safety net of index.ts). Now each socket has one owner: the
    // sockets of the editor go to the proxy, every other socket to the console's own plugin.
    type Upgrade = (...a: unknown[]) => void;
    const reroute = (listener: Upgrade, mine: (url: string | undefined) => boolean): void => {
      scope.server.removeListener("upgrade", listener);
      scope.server.on("upgrade", (req, socket, head) => { if (mine(req.url)) listener.call(scope.server, req, socket, head); });
    };
    for (const listener of scope.server.listeners("upgrade") as Upgrade[]) {
      if (before.has(listener)) reroute(listener, (url) => !underEditor(url));
      else reroute(listener, underEditor);
    }
  });
}
