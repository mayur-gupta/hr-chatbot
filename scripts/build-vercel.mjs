#!/usr/bin/env node
/**
 * Build the Vercel deployment with the Build Output API (v3), ready for `vercel deploy --prebuilt`:
 *   npm run build:vercel
 *
 *   .vercel/output/static/                     the React UI (web/dist)
 *   .vercel/output/functions/api/index.func/   one Node function
 *       src/app.mjs        src/app.ts and its dependencies, bundled by esbuild
 *       data/index/        only with BUNDLE_INDEX=1, for deployments that run VECTOR_STORE=file
 *   .vercel/output/config.json                 routes: files first, /api/* -> function, else index.html
 *
 * The deployed app reads its vectors from Supabase (VECTOR_STORE=supabase, the Vercel default), so
 * the function ships no index. It runs in VERCEL_FUNCTION_REGION (default bom1, Mumbai), next to
 * the Supabase project in ap-south-1: each question makes one database round trip.
 *
 * Building the function ourselves means Vercel never compiles TypeScript (this project uses
 * TypeScript 7, which has no compiler JS API) and the function contents are exactly what CI built.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, ".vercel", "output");
const func = path.join(out, "functions", "api", "index.func");
const webDist = path.join(root, "web", "dist");
const indexDir = path.join(root, "data", "index");
const bundleIndex = process.env.BUNDLE_INDEX === "1";
const region = process.env.VERCEL_FUNCTION_REGION || "bom1";

for (const [p, hint] of [
  [path.join(webDist, "index.html"), "npm run build:web"],
  ...(bundleIndex ? [[path.join(indexDir, "index.json"), "VECTOR_STORE=file npm run ingest"]] : []),
]) {
  if (!fs.existsSync(p)) throw new Error(`${path.relative(root, p)} is missing. Run: ${hint}`);
}

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(webDist, path.join(out, "static"), { recursive: true });

// Bundle at src/app.mjs so PROJECT_ROOT (one level up from src/) is the function root.
await build({
  entryPoints: [path.join(root, "src", "app.ts")],
  outfile: path.join(func, "src", "app.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  // Only used with VECTOR_STORE=chroma (lazy import); the deployed app uses Supabase.
  external: ["chromadb"],
  // Some CommonJS dependencies call require() for Node built-ins.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  legalComments: "none",
  logLevel: "warning",
});
if (bundleIndex) fs.cpSync(indexDir, path.join(func, "data", "index"), { recursive: true });
fs.writeFileSync(path.join(func, "package.json"), JSON.stringify({ type: "module" }));
fs.writeFileSync(
  path.join(func, ".vc-config.json"),
  JSON.stringify(
    {
      runtime: "nodejs24.x",
      handler: "src/app.mjs",
      launcherType: "Nodejs",
      shouldAddHelpers: false, // the handler reads the request body itself
      supportsResponseStreaming: true, // answers stream as NDJSON
      maxDuration: 120,
      regions: [region], // next to the database (Hobby allows one region)
    },
    null,
    2,
  ),
);

const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  // Needed for the Google sign-in popup to talk back to the page.
  "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
};
fs.writeFileSync(
  path.join(out, "config.json"),
  JSON.stringify(
    {
      version: 3,
      routes: [
        { src: "/(.*)", headers: securityHeaders, continue: true },
        { src: "/assets/(.*)", headers: { "Cache-Control": "public, max-age=31536000, immutable" }, continue: true },
        { handle: "filesystem" },
        { src: "/api/(.*)", dest: "/api/index?__path=$1" },
        { src: "/(.*)", dest: "/index.html" },
      ],
    },
    null,
    2,
  ),
);

const size = (dir) =>
  fs.readdirSync(dir, { recursive: true, withFileTypes: true }).reduce((n, e) => (e.isFile() ? n + fs.statSync(path.join(e.parentPath, e.name)).size : n), 0);
console.log(
  `Built ${path.relative(root, out)}: static ${(size(path.join(out, "static")) / 1e6).toFixed(1)} MB, ` +
    `function ${(size(func) / 1e6).toFixed(1)} MB in ${region}${bundleIndex ? " (with data/index)" : ""}`,
);
