/**
 * Google sign-in for the web API.
 *
 * Flow: the browser gets a Google ID token from Google Identity Services, POSTs it to
 * /api/auth/google, and we verify it (signature, audience = our client id, email verified,
 * optional allowlist). We then issue our own HMAC-signed session cookie (HttpOnly, SameSite=Lax),
 * so no server-side session store is needed (works the same locally and on Vercel).
 */
import crypto from "node:crypto";
import type http from "node:http";
import { OAuth2Client } from "google-auth-library";

export interface User {
  sub: string;
  email: string;
  name: string;
  picture?: string;
}

interface Session extends User {
  /** Expiry, seconds since epoch. */
  exp: number;
}

export interface AuthConfig {
  /** Google OAuth client id; empty disables auth (local development only). */
  clientId: string;
  sessionSecret: string;
  /** Lower-cased emails allowed to sign in. Empty + no domains = any verified Google account. */
  allowedEmails: string[];
  /** Lower-cased Google Workspace / email domains allowed to sign in, e.g. "kalvora.com". */
  allowedDomains: string[];
  sessionTtlSeconds: number;
}

export const COOKIE_NAME = "kal_session";
const list = (s: string | undefined) =>
  (s ?? "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const cfg: AuthConfig = {
    clientId: (env.GOOGLE_CLIENT_ID ?? "").trim(),
    sessionSecret: env.SESSION_SECRET ?? "",
    allowedEmails: list(env.ALLOWED_EMAILS),
    allowedDomains: list(env.ALLOWED_DOMAINS).map((d) => d.replace(/^@/, "")),
    sessionTtlSeconds: Number(env.SESSION_TTL_HOURS ?? 168) * 3600,
  };
  if (!cfg.clientId) {
    if (env.VERCEL || env.NODE_ENV === "production") {
      throw new Error("GOOGLE_CLIENT_ID is required in production. Refusing to start without sign-in.");
    }
    return cfg;
  }
  if (cfg.sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 characters when GOOGLE_CLIENT_ID is set (e.g. `openssl rand -hex 32`).");
  }
  return cfg;
}

export const authEnabled = (cfg: AuthConfig) => cfg.clientId !== "";

// ---------- session tokens ----------

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const sign = (data: string, secret: string) => crypto.createHmac("sha256", secret).update(data).digest("base64url");

export function createSessionToken(user: User, cfg: AuthConfig, now = Date.now()): string {
  const session: Session = { ...user, exp: Math.floor(now / 1000) + cfg.sessionTtlSeconds };
  const body = b64url(JSON.stringify(session));
  return `${body}.${sign(body, cfg.sessionSecret)}`;
}

export function readSessionToken(token: string | undefined, cfg: AuthConfig, now = Date.now()): User | null {
  if (!token) return null;
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expected = Buffer.from(sign(body, cfg.sessionSecret));
  const given = Buffer.from(mac);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const s = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Session;
    if (typeof s.exp !== "number" || s.exp * 1000 <= now) return null;
    // Re-check the allowlist so removing someone takes effect without rotating the secret.
    if (!isAllowed(s.email, undefined, cfg)) return null;
    return { sub: s.sub, email: s.email, name: s.name, picture: s.picture };
  } catch {
    return null;
  }
}

export function isAllowed(email: string, hostedDomain: string | undefined, cfg: AuthConfig): boolean {
  if (!cfg.allowedEmails.length && !cfg.allowedDomains.length) return true;
  const e = email.toLowerCase();
  const domain = (hostedDomain ?? e.split("@")[1] ?? "").toLowerCase();
  return cfg.allowedEmails.includes(e) || cfg.allowedDomains.includes(domain);
}

// ---------- Google ID token ----------

let googleClient: OAuth2Client | null = null;

export class AuthError extends Error {
  constructor(
    message: string,
    public status: 401 | 403 = 401,
  ) {
    super(message);
  }
}

/** Verify a Google ID token from Google Identity Services and return the user. */
export async function verifyGoogleCredential(credential: string, cfg: AuthConfig): Promise<User> {
  googleClient ??= new OAuth2Client();
  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: cfg.clientId });
    payload = ticket.getPayload();
  } catch {
    throw new AuthError("Google sign-in could not be verified. Please try again.");
  }
  if (!payload?.sub || !payload.email) throw new AuthError("Google did not return an email address.");
  if (!payload.email_verified) throw new AuthError("Your Google email address is not verified.", 403);
  if (!isAllowed(payload.email, payload.hd, cfg)) {
    throw new AuthError(`${payload.email} is not allowed to use this assistant.`, 403);
  }
  return { sub: payload.sub, email: payload.email, name: payload.name ?? payload.email, picture: payload.picture };
}

// ---------- cookies ----------

export function getCookie(req: http.IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

const isHttps = (req: http.IncomingMessage) =>
  req.headers["x-forwarded-proto"] === "https" || (req.socket as { encrypted?: boolean }).encrypted === true;

export function sessionCookie(req: http.IncomingMessage, value: string, maxAgeSeconds: number): string {
  const parts = [`${COOKIE_NAME}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSeconds}`];
  if (isHttps(req)) parts.push("Secure");
  return parts.join("; ");
}

export const currentUser = (req: http.IncomingMessage, cfg: AuthConfig): User | null =>
  readSessionToken(getCookie(req, COOKIE_NAME), cfg);
