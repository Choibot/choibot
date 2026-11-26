import { describe, it, expect } from "vitest";
import { isAllowedUpdate, isCommand, forwardedFromOf, largestPhoto } from "./updates.js";
import { tgMessage, USER_ID } from "./testkit.js";

describe("isAllowedUpdate", () => {
  it("accepts a message from the user in the private chat", () => {
    expect(isAllowedUpdate({ update_id: 1, message: tgMessage(1) }, USER_ID)).toBe(true);
  });
  it("drops another user", () => {
    expect(isAllowedUpdate({ update_id: 1, message: tgMessage(1, { from: { id: 7 } }) }, USER_ID)).toBe(false);
  });
  it("drops the user writing in a group", () => {
    const m = tgMessage(1, { chat: { id: -100, type: "supergroup", title: "Notify" } });
    expect(isAllowedUpdate({ update_id: 1, message: m }, USER_ID)).toBe(false);
  });
  it("checks both sender and chat for a callback", () => {
    const ok = { id: "c", from: { id: USER_ID }, message: tgMessage(5), data: "f:t1" };
    const group = { ...ok, message: tgMessage(5, { chat: { id: -1, type: "group" as const } }) };
    const other = { ...ok, from: { id: 9 } };
    expect(isAllowedUpdate({ update_id: 1, callback_query: ok }, USER_ID)).toBe(true);
    expect(isAllowedUpdate({ update_id: 1, callback_query: group }, USER_ID)).toBe(false);
    expect(isAllowedUpdate({ update_id: 1, callback_query: other }, USER_ID)).toBe(false);
  });
  it("drops updates of any other type", () => {
    expect(isAllowedUpdate({ update_id: 1 }, USER_ID)).toBe(false);
  });
});

describe("message helpers", () => {
  it("detects a leading bot command only", () => {
    expect(isCommand(tgMessage(1, { text: "/start", entities: [{ type: "bot_command", offset: 0, length: 6 }] }))).toBe(true);
    expect(isCommand(tgMessage(1, { text: "see /start", entities: [{ type: "bot_command", offset: 4, length: 6 }] }))).toBe(false);
    expect(isCommand(tgMessage(1, { text: "plain" }))).toBe(false);
  });
  it("names the forward origin", () => {
    expect(forwardedFromOf({ type: "user", sender_user: { id: 1, first_name: "Ann", last_name: "Lee" } })).toBe("Ann Lee");
    expect(forwardedFromOf({ type: "hidden_user", sender_user_name: "Bob" })).toBe("Bob");
    expect(forwardedFromOf({ type: "chat", sender_chat: { id: 1, type: "group", title: "Ops" } })).toBe("Ops");
    expect(forwardedFromOf({ type: "channel", chat: { id: 1, type: "channel", title: "News" } })).toBe("News");
    expect(forwardedFromOf(undefined)).toBeUndefined();
  });
  it("picks the largest photo size", () => {
    const p = largestPhoto([
      { file_id: "s", width: 90, height: 90 },
      { file_id: "l", width: 1280, height: 960 },
      { file_id: "m", width: 320, height: 240 },
    ]);
    expect(p?.file_id).toBe("l");
    expect(largestPhoto(undefined)).toBeUndefined();
  });
});
