import { describe, expect, it } from "vitest";
import { createSessionToken, isAllowed, loadAuthConfig, readSessionToken, type AuthConfig } from "../src/auth.js";

const cfg: AuthConfig = {
  clientId: "test.apps.googleusercontent.com",
  sessionSecret: "x".repeat(32),
  allowedEmails: [],
  allowedDomains: [],
  sessionTtlSeconds: 3600,
};
const user = { sub: "123", email: "a@kalvora.com", name: "A" };

describe("session tokens", () => {
  it("round-trips a valid token", () => {
    expect(readSessionToken(createSessionToken(user, cfg), cfg)).toEqual(user);
  });

  it("rejects a tampered payload", () => {
    const [, mac] = createSessionToken(user, cfg).split(".");
    const forged = Buffer.from(JSON.stringify({ ...user, email: "evil@x.com", exp: 9e9 })).toString("base64url");
    expect(readSessionToken(`${forged}.${mac}`, cfg)).toBeNull();
  });

  it("rejects a token signed with another secret", () => {
    const other = createSessionToken(user, { ...cfg, sessionSecret: "y".repeat(32) });
    expect(readSessionToken(other, cfg)).toBeNull();
  });

  it("rejects an expired token", () => {
    const t = createSessionToken(user, cfg, Date.now() - 2 * 3600 * 1000);
    expect(readSessionToken(t, cfg)).toBeNull();
  });

  it("rejects garbage", () => {
    for (const t of [undefined, "", "abc", "a.b", "a.b.c"]) expect(readSessionToken(t, cfg)).toBeNull();
  });

  it("drops sessions of users removed from the allowlist", () => {
    const t = createSessionToken(user, cfg);
    expect(readSessionToken(t, { ...cfg, allowedEmails: ["someone@else.com"] })).toBeNull();
  });
});

describe("allowlist", () => {
  it("allows anyone when no list is set", () => {
    expect(isAllowed("x@gmail.com", undefined, cfg)).toBe(true);
  });
  it("matches domains and emails case-insensitively", () => {
    const c = { ...cfg, allowedDomains: ["kalvora.com"], allowedEmails: ["boss@gmail.com"] };
    expect(isAllowed("A@Kalvora.com", undefined, c)).toBe(true);
    expect(isAllowed("Boss@gmail.com", undefined, c)).toBe(true);
    expect(isAllowed("x@gmail.com", undefined, c)).toBe(false);
    expect(isAllowed("x@notkalvora.com", undefined, c)).toBe(false);
  });
});

describe("loadAuthConfig", () => {
  it("disables auth locally without a client id", () => {
    expect(loadAuthConfig({}).clientId).toBe("");
  });
  it("refuses to run on Vercel without a client id", () => {
    expect(() => loadAuthConfig({ VERCEL: "1" })).toThrow(/GOOGLE_CLIENT_ID/);
  });
  it("requires a long session secret", () => {
    expect(() => loadAuthConfig({ GOOGLE_CLIENT_ID: "id", SESSION_SECRET: "short" })).toThrow(/SESSION_SECRET/);
  });
  it("parses allowlists", () => {
    const c = loadAuthConfig({ GOOGLE_CLIENT_ID: "id", SESSION_SECRET: "s".repeat(32), ALLOWED_DOMAINS: "@Kalvora.com, x.org" });
    expect(c.allowedDomains).toEqual(["kalvora.com", "x.org"]);
  });
});
