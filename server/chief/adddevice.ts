// server/chief/adddevice.ts — "Add a device": a paired device of the user makes the code that
// pairs one more device (the phone), with no command on the box.
//
// The code is the code of firstrun.ts (8 characters, random, one use, the hash only on disk, a
// try limit, a constant-time compare), with a shorter life. The differences:
//   - It is made by an HTTP route, so that route is USER only (gateUser): a request with an agent
//     header, or with no token of a paired device, gets no code. No other route makes one.
//   - The device that made the code must still be paired at the claim: a revoke of that device
//     ends its code. The maker is kept in memory only, so a code does not live through a
//     restart, and a code file that nobody of this process made pairs nothing.
//   - The new device is one more normal device (DeviceStore.add): the rights of a paired device
//     and nothing more. Its name never replaces a device that is there.
//
// Only a console that pairs devices "from the box" has these routes (addDeviceOn). A console
// that pairs through Telegram registers nothing: there /pair in the Master topic is the one way.
import { rm } from "node:fs/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AGENT_HEADER, AGENT_TOKEN_HEADER, DEVICE_LABEL_RE, type DeviceStore } from "./auth.js";
import { onChain } from "./files.js";
import { BoxCodes, FIRST_RUN_ERR, mintBoxCode } from "./firstrun.js";
import { gateRoute, gateUser, pairRequired, type ChiefGate } from "./gate.js";

export const ADD_CODE_TTL_MS = 300_000;
// POST: a new code (USER). DELETE: forget the code (USER).
export const ADD_DEVICE_ROUTE = "/api/chief/devices/add";
// POST { code, label }: any session. The answer holds the token of the new device, one time.
export const ADD_CLAIM_ROUTE = "/api/chief/devices/claim";
export const ADD_DEVICE_ERR = { ...FIRST_RUN_ERR, name: "invalid device name" } as const;

// The address that goes to the page with a code: an HTTPS origin, nothing more.
const ADDRESS_RE = /^https:\/\/[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;

export const addDeviceOn = (core: { userAuth: "telegram" | "log" }): boolean => core.userAuth === "log";

// `want`, or `want-2`, `want-3`…: the first name that no paired device has.
export function freeLabel(want: string, taken: string[]): string {
  for (let n = 1; ; n++) {
    const tail = n === 1 ? "" : `-${n}`;
    const label = want.slice(0, 32 - tail.length) + tail;
    if (!taken.includes(label)) return label;
  }
}

export type AddDeviceDeps = {
  gate: ChiefGate;
  devices: Pick<DeviceStore, "list" | "add">;
  // The file of the code's hash (chiefPaths().addCode).
  file: string;
  // A device was added: what a check of the set-up list reads has changed.
  changed?: () => void;
  // The private address of this console (https://<name>), or null. A device that makes the
  // code at an address of the server itself (the SSH tunnel) gets it with the code: the new
  // device, and this browser too, pair at that address.
  address?: () => Promise<string | null>;
  now?: () => number;
  log?: (s: string) => void;
};

export function registerAddDevice(app: FastifyInstance, d: AddDeviceDeps): void {
  const now = d.now ?? Date.now;
  const log = d.log ?? ((s: string) => console.warn(s));
  const codes = new BoxCodes(d.file, { now });
  // The device that made the code that is open now.
  let maker: { label: string; createdAt: number } | null = null;
  const forget = async (): Promise<void> => {
    maker = null;
    await onChain(d.file, () => rm(d.file, { force: true }));
  };

  app.post(ADD_DEVICE_ROUTE, async (req: FastifyRequest, reply: FastifyReply) => {
    const caller = await gateUser(d.gate, req, reply);
    if (!caller) return reply;
    const device = (await d.devices.list()).find((x) => x.label === caller.device);
    if (!device) return pairRequired(d.gate, reply); // revoked after the gate read it
    // A new code replaces the code before it.
    const { code, expiresAt } = await mintBoxCode(d.file, { now, ttlMs: ADD_CODE_TTL_MS });
    maker = { label: device.label, createdAt: device.createdAt };
    log(`[chief] device ${device.label} made a code to add a device`);
    // ttlMs: the page counts down on its own clock.
    const address = d.address ? await d.address().catch(() => null) : null;
    return reply.code(200).send({ code, expiresAt, ttlMs: ADD_CODE_TTL_MS, address: address && ADDRESS_RE.test(address) ? address : null });
  });

  app.delete(ADD_DEVICE_ROUTE, async (req: FastifyRequest, reply: FastifyReply) => {
    if (!(await gateUser(d.gate, req, reply))) return reply;
    await forget();
    return reply.code(200).send({ ok: true });
  });

  // The answers never hold the code.
  app.post(ADD_CLAIM_ROUTE, async (req: FastifyRequest, reply: FastifyReply) => {
    if (!gateRoute(d.gate, reply)) return reply;
    // Key presence, as in callerOf: an agent never pairs itself as the user.
    if (Object.hasOwn(req.headers, AGENT_HEADER) || Object.hasOwn(req.headers, AGENT_TOKEN_HEADER)) {
      return reply.code(403).send({ error: ADD_DEVICE_ERR.agentHeaders });
    }
    const body = (req.body ?? {}) as { code?: unknown; label?: unknown };
    // Before the code is read: a name that is not valid costs no try and no code.
    if (typeof body.label !== "string" || !DEVICE_LABEL_RE.test(body.label)) return reply.code(400).send({ error: ADD_DEVICE_ERR.name });
    // A body with no code is not a try: the code that is open stays.
    if (typeof body.code !== "string") return reply.code(410).send({ error: ADD_DEVICE_ERR.gone });
    const by = maker;
    if (!by || !(await d.devices.list()).some((x) => x.label === by.label && x.createdAt === by.createdAt)) {
      await forget();
      return reply.code(410).send({ error: ADD_DEVICE_ERR.gone });
    }
    const r = await codes.claim(body.code);
    if (r === "wrong") return reply.code(403).send({ error: ADD_DEVICE_ERR.wrong });
    if (r !== "ok") maker = null;
    if (r === "spent") return reply.code(429).send({ error: ADD_DEVICE_ERR.spent });
    if (r === "gone") return reply.code(410).send({ error: ADD_DEVICE_ERR.gone });
    maker = null;
    const label = freeLabel(body.label, (await d.devices.list()).map((x) => x.label));
    const token = await d.devices.add(label);
    log(`[chief] device ${label} was added with the code of device ${by.label}`);
    d.changed?.();
    return reply.code(200).send({ token, label });
  });
}
