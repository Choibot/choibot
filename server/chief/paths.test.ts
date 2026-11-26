import { describe, expect, it } from "vitest";
import {
  CHIEF_PROMPT_REV, agentIdentityEnv, chiefActive, chiefCli, chiefFlag, chiefMisconfigured,
  chiefPaths, chiefTunables, chiefUserAuth, resolveChiefDataDir, telegramReady,
} from "./paths.js";

const LOG = { CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "http://127.0.0.1:4999" };
const TG = { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_ISSUES_USER_ID: "42", TELEGRAM_MASTER_CHAT_ID: "-100", TELEGRAM_MASTER_THREAD_ID: "2" };

describe("chief paths", () => {
  it("resolves the data dir", () => {
    expect(resolveChiefDataDir({ CHIEF_DATA_DIR: "/x" })).toBe("/x");
    expect(resolveChiefDataDir({ XDG_DATA_HOME: "/d" })).toBe("/d/choibot/chief");
  });
  it("lays out the tree", () => {
    expect(chiefPaths("/c")).toMatchObject({ root: "/c", devices: "/c/user-devices.json", rules: "/c/brain/rules.jsonl",
      decisions: "/c/brain/decisions.jsonl", classified: "/c/brain/classified.jsonl", brain: "/c/brain/BRAIN.md",
      proposed: "/c/brain/BRAIN.proposed.md", versionsDir: "/c/brain/versions", cards: "/c/brain/cards.json",
      runDir: "/c/brain/run", suggest: "/c/brain/suggest.json", queueDir: "/c/queue", mediaDir: "/c/queue/media", brainDir: "/c/brain",
      auditAuto: "/c/audit/auto.jsonl", leadsDir: "/c/leads", areas: "/c/areas.json", reminders: "/c/reminders.json" });
  });
  it("flag and predicates", () => {
    expect(chiefFlag({ CHIEF_ENABLED: "true" })).toBe(false);
    expect(chiefFlag({ CHIEF_ENABLED: "1" })).toBe(true);
    expect(chiefMisconfigured({})).toBeNull();
    expect(chiefActive({})).toBe(false);
    expect(chiefMisconfigured(LOG)).toBeNull();
    expect(chiefActive(LOG)).toBe(true);
    expect(chiefMisconfigured({ ...LOG, CHIEF_CONSOLE_URL: undefined })).toBe("CHIEF_CONSOLE_URL is not set");
    expect(chiefMisconfigured({ CHIEF_ENABLED: "1", CHIEF_CONSOLE_URL: "https://c" }))
      .toBe("CHIEF_USER_AUTH=telegram but the Master topic is not configured");
    // Devices pair from the server and the Master topic is set: sound (no dead end for a
    // console installed with no Telegram). Auto-answer stays off there (eligibility.ts).
    expect(chiefMisconfigured({ ...LOG, ...TG })).toBeNull();
    expect(chiefActive({ ...LOG, ...TG })).toBe(true);
    expect(chiefMisconfigured({ ...LOG, CHIEF_USER_AUTH: "sms" })).toBe("CHIEF_USER_AUTH must be telegram or log");
    expect(chiefActive({ CHIEF_ENABLED: "1", CHIEF_CONSOLE_URL: "https://c", ...TG })).toBe(true);
    expect(chiefUserAuth({})).toBe("telegram");
    expect(chiefUserAuth({ CHIEF_USER_AUTH: "log" })).toBe("log");
    expect(telegramReady({ ...TG, TELEGRAM_MASTER_THREAD_ID: undefined })).toBe(false);
    expect(telegramReady(TG)).toBe(true);
  });
  it("cli, rev, identity env", () => {
    expect(chiefCli("/r")).toBe("/r/node_modules/.bin/tsx /r/bin/choibot.ts");
    expect(CHIEF_PROMPT_REV).toBe(16);
    expect(agentIdentityEnv({ id: "a", hookToken: "h" })).toEqual({ CHOIBOT_AGENT_ID: "a", CHOIBOT_AGENT_PASS: "h" });
  });
});

describe("chiefTunables", () => {
  const DEFAULTS = { undoMs: 600_000, autoThreshold: 0.85, telegramAuto: true, distillAt: "03:30" };

  it("defaults", () => {
    expect(chiefTunables({})).toEqual(DEFAULTS);
  });

  it("an invalid value → the default", () => {
    expect(chiefTunables({ CHIEF_AUTO_THRESHOLD: "abc", CHIEF_UNDO_MINUTES: "-1", CHIEF_DISTILL_AT: "25:00" })).toEqual(DEFAULTS);
    for (const v of ["", "0", "1.5", "-0.5", "0x1", "1e-1", "Infinity", "NaN"]) {
      expect(chiefTunables({ CHIEF_AUTO_THRESHOLD: v }).autoThreshold).toBe(0.85);
    }
    for (const v of ["", "0", "2.5", "abc", "1e3", "0x10", "99999999999999999"]) {
      expect(chiefTunables({ CHIEF_UNDO_MINUTES: v }).undoMs).toBe(600_000);
    }
    for (const v of ["", "3:30", "03:60", "24:00", "0330", "03:30:00", " 03:30x"]) {
      expect(chiefTunables({ CHIEF_DISTILL_AT: v }).distillAt).toBe("03:30");
    }
  });

  it("valid values", () => {
    expect(chiefTunables({ CHIEF_TELEGRAM_AUTO: "0", CHIEF_UNDO_MINUTES: "5" }))
      .toEqual({ ...DEFAULTS, telegramAuto: false, undoMs: 300_000 });
    expect(chiefTunables({ CHIEF_AUTO_THRESHOLD: "1", CHIEF_DISTILL_AT: "23:59", CHIEF_TELEGRAM_AUTO: "1" }))
      .toEqual({ ...DEFAULTS, autoThreshold: 1, distillAt: "23:59" });
    expect(chiefTunables({ CHIEF_AUTO_THRESHOLD: "0.5", CHIEF_DISTILL_AT: "00:00" }))
      .toEqual({ ...DEFAULTS, autoThreshold: 0.5, distillAt: "00:00" });
    expect(chiefTunables({ CHIEF_AUTO_THRESHOLD: ".9" }).autoThreshold).toBe(0.9);
  });
});
