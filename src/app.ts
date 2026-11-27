/**
 * The chat API as a plain Node (req, res) handler, shared by the local server (src/server.ts)
 * and the Vercel Function (bundled by scripts/build-vercel.mjs; the default export).
 *
 *   GET  /api/info   model, embedding model, top-k, country codes
 *   POST /api/chat   { question, state?, countries?, k? } -> NDJSON stream of ChatEvent
 *   /api/auth/*      Google sign-in (see auth.ts)
 *
 * The conversation state lives in the browser and is sent with every request, so the
 * handler is stateless. Backend clients are created on first use and reused while the
 * process (or warm serverless instance) lives.
 */
import type http from "node:http";
import { z } from "zod";
import { loadSettings } from "./config.js";
import { COUNTRY_CODES, Retriever, type Hit } from "./retriever.js";
import { Answerer, citeLabel } from "./answer.js";
import { emptyState, nextState, planSearch, type ChatState } from "./chat.js";
import {
  AuthError,
  authEnabled,
  createSessionToken,
  currentUser,
  loadAuthConfig,
  sessionCookie,
  verifyGoogleCredential,
  type User,
} from "./auth.js";

export const settings = loadSettings();
export const auth = loadAuthConfig();

/** Connections are opened on first use and reused; a failed open is retried on the next request. */
let ready: Promise<{ retriever: Retriever; answerer: Answerer }> | null = null;
function getBackend() {
  ready ??= (async () => {
    const retriever = await Retriever.open(settings);
    const answerer = new Answerer(settings);
    await answerer.init();
    return { retriever, answerer };
  })().catch((err) => {
    ready = null;
    throw err;
  });
  return ready;
}

const turnSchema = z.object({ role: z.enum(["user", "assistant"]), content: z.string() });
const chatSchema = z.object({
  question: z.string().trim().min(1).max(2000),
  state: z
    .object({
      history: z.array(turnSchema).max(20),
      lastCountries: z.array(z.string()),
      lastQuestion: z.string(),
    })
    .optional(),
  countries: z.array(z.string().toUpperCase()).optional(),
  k: z.number().int().min(1).max(30).optional(),
});

export type ChatEvent =
  | { type: "meta"; scope: string; countries: string[]; sources: Source[] }
  | { type: "token"; text: string }
  | { type: "done"; answer: string; state: ChatState }
  | { type: "error"; message: string };

interface Source {
  label: string;
  title: string;
  country: string;
  section: string;
  distance: number;
  text: string;
}

const toSource = (h: Hit): Source => ({
  label: citeLabel(h),
  title: h.title,
  country: h.country,
  section: h.sectionTitle,
  distance: h.distance,
  text: h.text,
});

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  // Vercel's Node helpers may have parsed the body already; otherwise read the stream.
  const parsed = (req as { body?: unknown }).body;
  if (parsed !== undefined) return typeof parsed === "string" ? JSON.parse(parsed || "{}") : parsed;
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 200_000) throw new Error("Request body too large");
  }
  return JSON.parse(body || "{}");
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

async function handleChat(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const parsed = chatSchema.safeParse(await readJson(req).catch(() => null));
  if (!parsed.success) return sendJson(res, 400, { error: "Invalid request", issues: parsed.error.issues });
  const { question, countries: forced = [], k = settings.topK } = parsed.data;
  const state = parsed.data.state ?? emptyState();

  const bad = forced.filter((c) => !COUNTRY_CODES.includes(c));
  if (bad.length) return sendJson(res, 400, { error: `Unknown country code(s): ${bad.join(", ")}` });

  res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" });
  const send = (e: ChatEvent) => {
    if (!res.writableEnded) res.write(JSON.stringify(e) + "\n");
  };
  // Stop generating in LM Studio when the browser disconnects (Stop button, closed tab).
  const ctrl = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) ctrl.abort();
  });

  try {
    const { retriever, answerer } = await getBackend();
    const plan = planSearch(question, state, forced);
    const hits = await retriever.retrieve(plan.searchText, k, plan.countries);
    send({ type: "meta", scope: plan.scope, countries: plan.countries, sources: hits.map(toSource) });

    const answer = await answerer.answer(question, hits, state.history, (text) => send({ type: "token", text }), ctrl.signal);
    send({ type: "done", answer, state: nextState(state, question, answer, plan.countries) });
  } catch (err) {
    if (ctrl.signal.aborted) return;
    send({
      type: "error",
      message: friendlyError(err as Error),
    });
  }
  res.end();
}

const DEV_USER: User = { sub: "dev", email: "dev@localhost", name: "Local developer" };

async function handleAuth(pathname: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method === "GET" && pathname === "/api/auth/config") {
    return sendJson(res, 200, { enabled: authEnabled(auth), clientId: auth.clientId || null });
  }
  if (req.method === "GET" && pathname === "/api/auth/me") {
    if (!authEnabled(auth)) return sendJson(res, 200, { user: DEV_USER });
    const user = currentUser(req, auth);
    return user ? sendJson(res, 200, { user }) : sendJson(res, 401, { error: "Not signed in" });
  }
  if (req.method === "POST" && pathname === "/api/auth/google") {
    if (!authEnabled(auth)) return sendJson(res, 400, { error: "Google sign-in is not configured" });
    const body = (await readJson(req).catch(() => ({}))) as { credential?: unknown };
    if (typeof body.credential !== "string" || !body.credential) return sendJson(res, 400, { error: "Missing credential" });
    try {
      const user = await verifyGoogleCredential(body.credential, auth);
      res.setHeader("Set-Cookie", sessionCookie(req, createSessionToken(user, auth), auth.sessionTtlSeconds));
      console.log(`sign-in: ${user.email}`);
      return sendJson(res, 200, { user });
    } catch (err) {
      if (err instanceof AuthError) return sendJson(res, err.status, { error: err.message });
      throw err;
    }
  }
  if (req.method === "POST" && pathname === "/api/auth/logout") {
    res.setHeader("Set-Cookie", sessionCookie(req, "", 0));
    return sendJson(res, 200, { ok: true });
  }
  sendJson(res, 404, { error: "Not found" });
}

/** Turn provider errors into something a user can act on, without leaking request details. */
function friendlyError(err: Error): string {
  const status = (err as { status?: number }).status;
  if (status === 429) return "The AI provider's rate limit was reached (free tier). Wait a minute and try again.";
  if (status === 401 || status === 403) return "The server's AI provider key was rejected. Ask the administrator to check CHAT_API_KEY / EMBED_API_KEY.";
  if (err.message === "terminated") return "The model connection closed before the answer finished. Please try again.";
  return err.message;
}

/**
 * Handle one request. Returns false for non-/api paths so the caller can serve the UI
 * (the local server serves web/dist; on Vercel the CDN does).
 */
export async function handleApi(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/api/")) return false;
  try {
    if (url.pathname.startsWith("/api/auth/")) {
      await handleAuth(url.pathname, req, res);
      return true;
    }

    // Everything else under /api needs a signed-in user.
    if (authEnabled(auth) && !currentUser(req, auth)) {
      sendJson(res, 401, { error: "Not signed in" });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/info") {
      try {
        const { answerer } = await getBackend();
        sendJson(res, 200, {
          ok: true,
          model: answerer.model,
          embedModel: settings.embedModel,
          topK: settings.topK,
          countries: COUNTRY_CODES,
        });
      } catch (err) {
        sendJson(res, 503, { ok: false, error: (err as Error).message, countries: COUNTRY_CODES });
      }
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/chat") {
      await handleChat(req, res);
      return true;
    }
    sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { error: (err as Error).message });
    else res.end();
  }
  return true;
}

/** Vercel Function entry. The route config rewrites /api/<path> to /api/index?__path=<path>. */
export default async function handler(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const original = url.searchParams.get("__path");
  if (url.pathname === "/api/index" && original !== null) {
    url.searchParams.delete("__path");
    req.url = `/api/${original}${url.search}`;
  }
  if (!(await handleApi(req, res))) sendJson(res, 404, { error: "Not found" });
}
