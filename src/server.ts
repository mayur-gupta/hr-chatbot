/**
 * Local server: the chat API plus the built UI.
 *   npm run server            -> http://localhost:3001
 *
 * If web/dist exists (npm run build:web), it is served at "/". In development use
 * `npm run web` (Vite on :5173, proxying /api here).
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "./config.js";
import { auth, handleApi, settings } from "./app.js";
import { authEnabled } from "./auth.js";

const PORT = Number(process.env.PORT ?? 3001);

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
  if (await handleApi(req, res)) return;
  if (req.method === "GET") return serveStatic(new URL(req.url ?? "/", "http://localhost").pathname, res);
  res.writeHead(405, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Method not allowed" }));
});

server.listen(PORT, () => {
  console.log(`Kalvora HR chat API on http://localhost:${PORT}`);
  console.log(`  chat: ${settings.chatModel || "(auto)"} @ ${settings.chat.baseUrl} | embed: ${settings.embedModel} | store: ${settings.vectorStore}`);
  if (!authEnabled(auth)) {
    console.warn("  WARNING: sign-in is OFF (GOOGLE_CLIENT_ID not set). Anyone who can reach this port can use the API.");
  } else if (!auth.allowedEmails.length && !auth.allowedDomains.length) {
    console.warn("  Note: any verified Google account can sign in. Set ALLOWED_DOMAINS or ALLOWED_EMAILS to restrict.");
  }
  console.log(`  UI: run \`npm run web\` (dev, http://localhost:5173) or \`npm run build:web\` to serve it from here.`);
});
