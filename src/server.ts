/**
 * HTTP API for the web chat UI.
 *   npm run server            -> http://localhost:3001
 *
 *   GET  /api/info   model, embedding model, top-k, country codes
 *   POST /api/chat   { question, state?, countries?, k? } -> NDJSON stream of ChatEvent
 *
 * The conversation state lives in the browser and is sent with every request, so the
 * server is stateless. If web/dist exists (npm run build:web), it is served at "/".
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { PROJECT_ROOT, loadSettings } from "./config.js";
import { COUNTRY_CODES, Retriever, type Hit } from "./retriever.js";
import { Answerer, citeLabel } from "./answer.js";
import { emptyState, nextState, planSearch, type ChatState } from "./chat.js";

const PORT = Number(process.env.PORT ?? 3001);
const settings = loadSettings();

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
    const message = (err as Error).message;
    send({
      type: "error",
      message: message === "terminated" ? "The model connection was closed before the answer finished (LM Studio may have been busy with another request). Please try again." : message,
    });
  }
  res.end();
}

const WEB_DIST = path.join(PROJECT_ROOT, "web", "dist");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function serveStatic(urlPath: string, res: http.ServerResponse): void {
  const rel = path.normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, "");
  let file = path.join(WEB_DIST, rel);
  if (!file.startsWith(WEB_DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(WEB_DIST, "index.html");
  }
  if (!fs.existsSync(file)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("UI not built. Run `npm run build:web`, or use `npm run web` for the dev server.");
    return;
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/api/info") {
      try {
        const { answerer } = await getBackend();
        return sendJson(res, 200, {
          ok: true,
          model: answerer.model,
          embedModel: settings.embedModel,
          topK: settings.topK,
          countries: COUNTRY_CODES,
        });
      } catch (err) {
        return sendJson(res, 503, { ok: false, error: (err as Error).message, countries: COUNTRY_CODES });
      }
    }
    if (req.method === "POST" && url.pathname === "/api/chat") return await handleChat(req, res);
    if (url.pathname.startsWith("/api/")) return sendJson(res, 404, { error: "Not found" });
    if (req.method === "GET") return serveStatic(url.pathname, res);
    sendJson(res, 405, { error: "Method not allowed" });
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { error: (err as Error).message });
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`Kalvora HR chat API on http://localhost:${PORT}`);
  console.log(`  UI: run \`npm run web\` (dev, http://localhost:5173) or \`npm run build:web\` to serve it from here.`);
});
