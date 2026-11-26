import type { WebSocket } from "@fastify/websocket";

// Close code for a server-side "nothing to stream" close (no live terminal, no
// such shell…). The client reconnects on any other close, but not on this one,
// so a dead agent's tab doesn't loop on the same message. See termSocket.ts.
export const WS_CLOSE_FINAL = 4000;

// Ping every interval and terminate a socket that missed the previous pong.
// Keeps idle terminals alive through proxies (tailscale serve drops idle
// connections) and frees half-open sockets left by a sleeping laptop.
export function keepAlive(socket: WebSocket, intervalMs = 25_000): () => void {
  let alive = true;
  socket.on("pong", () => { alive = true; });
  const timer = setInterval(() => {
    if (socket.readyState !== socket.OPEN) return;
    if (!alive) { socket.terminate(); return; }
    alive = false;
    socket.ping();
  }, intervalMs);
  timer.unref?.();
  const stop = () => clearInterval(timer);
  socket.on("close", stop);
  return stop;
}
