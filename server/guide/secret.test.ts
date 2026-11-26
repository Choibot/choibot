// server/guide/secret.test.ts — the guard: each kind of secret the product uses is found, and
// the things a user writes in a set-up chat are not.
import { describe, expect, it } from "vitest";
import { findSecret, stoppedLine } from "./secret.js";
import { FAKE } from "./testkit.js";


describe("findSecret", () => {
  it("finds each kind of secret the product uses, also inside a sentence", () => {
    expect(findSecret(FAKE.telegram)?.kind).toBe("telegram");
    expect(findSecret(`ok I have the token: ${FAKE.telegram} do I paste it here?`)?.kind).toBe("telegram");
    expect(findSecret(FAKE.githubClassic)?.kind).toBe("github");
    expect(findSecret(FAKE.githubOauth)?.kind).toBe("github");
    expect(findSecret(`my pat is ${FAKE.githubFine}`)?.kind).toBe("github");
    expect(findSecret(FAKE.anthropic)?.kind).toBe("anthropic");
    expect(findSecret(FAKE.claudeLogin)?.kind).toBe("anthropic");
    expect(findSecret(FAKE.openai)?.kind).toBe("key");
    expect(findSecret(FAKE.tailscale)?.kind).toBe("key");
    expect(findSecret(`${FAKE.privateKey}\nb3BlbnNz`)?.kind).toBe("key");
    expect(findSecret(`here: ${FAKE.random}`)?.kind).toBe("key");
  });

  it("finds a password or a secret that comes with its name", () => {
    expect(findSecret("password: hunter22x")?.kind).toBe("password");
    expect(findSecret("my API key = abcd1234efgh")?.kind).toBe("password");
    expect(findSecret("TOKEN=\"x9y8z7w6v5\"")?.kind).toBe("password");
    expect(findSecret("clone https://ada:s3cretpass@github.com/acme/shop.git")?.kind).toBe("password");
    expect(findSecret("postgres://app:pw12345678@db.example.invalid/app")?.kind).toBe("password");
  });

  it("lets through what a user writes in a set-up chat", () => {
    for (const text of [
      "done, I approved it",
      "can I get the tickets on telegram?",
      "ok I have the token, do I paste it here?",
      "the token is not accepted",
      "token: expired",
      "password = missing?",
      "the code is 7F2A-9C41",
      "I opened https://github.com/login/device and typed the code",
      "use acme/shop please, https://github.com/acme/shop/pull/128",
      "commit 3f9a2b1c4d5e6f708192a3b4c5d6e7f8091a2b3c is the one",
      "what does a lead do? and what is the Queue?",
      "my GitHub login is ada-dev and the port is 3100",
      "supercalifragilisticexpialidocious_and_more_words_here",
    ]) expect(findSecret(text), text).toBeNull();
  });

  it("says where the kind belongs, and names the step that has its form", () => {
    expect(findSecret(FAKE.telegram)).toMatchObject({ what: "a Telegram bot token", step: "telegram" });
    expect(findSecret(FAKE.telegram)?.where).toMatch(/form of the step “Telegram”/);
    expect(findSecret(FAKE.githubClassic)).toMatchObject({ step: "github" });
    expect(findSecret(FAKE.githubClassic)?.where).toMatch(/one-time code/);
    expect(findSecret(FAKE.anthropic)?.where).toMatch(/Claude login of your server/);
    expect(findSecret("password: hunter22x")?.step).toBeUndefined();
  });

  it("never gives back a part of the text", () => {
    for (const secret of Object.values(FAKE)) {
      const hit = findSecret(`look: ${secret}`)!;
      const out = JSON.stringify(hit) + stoppedLine(hit);
      expect(out).not.toContain(secret);
      expect(out).not.toContain(secret.slice(0, 12));
    }
  });

  it("stays fast on a long text", () => {
    const t0 = Date.now();
    expect(findSecret("1".repeat(200_000))).toBeNull();
    expect(findSecret(`${"a:".repeat(50_000)}`)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
