// server/chief/remind/setup.ts — index.ts's one call for reminders. With a
// chief core (the flag on; a misconfigured core too, whose routes answer 503)
// it registers the /api/reminders routes and returns the deliverer, which the
// chief boot starts on an active core only. With no core (the flag off) it
// does nothing: no route (404), no deliverer, no timer.
import type { FastifyInstance } from "fastify";
import type { SessionStore } from "../../agents/store.js";
import type { ChiefCore } from "../boot.js";
import { registerRemindApi } from "./api.js";
import { ReminderDeliverer, type ReminderDelivererDeps } from "./deliver.js";

export type SetupRemindersDeps = {
  agents: Pick<SessionStore, "load" | "exists">;
  deliverer: Omit<ReminderDelivererDeps, "store" | "agents">;
};

export function setupReminders(
  app: FastifyInstance, chief: Pick<ChiefCore, "gate" | "reminders"> | undefined, d: SetupRemindersDeps,
): ReminderDeliverer | undefined {
  if (!chief) return undefined;
  registerRemindApi(app, { gate: chief.gate, store: chief.reminders, agents: d.agents });
  return new ReminderDeliverer({ ...d.deliverer, store: chief.reminders, agents: d.agents });
}
