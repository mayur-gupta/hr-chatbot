// Starts a local Chroma server on :8000 that saves to ./data/chroma.
//   node scripts/chroma-server.mjs           -> Python server from .chroma-venv (run `npm run chroma:setup` once)
//   node scripts/chroma-server.mjs --docker  -> official Docker image
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dataDir = path.join(root, "data", "chroma");
fs.mkdirSync(dataDir, { recursive: true });

let cmd, args;
if (process.argv.includes("--docker")) {
  cmd = "docker";
  args = ["run", "--rm", "-p", "8000:8000", "-v", `${dataDir}:/data`, "chromadb/chroma:1.5.9"];
} else {
  const bin = process.platform === "win32" ? ".chroma-venv/Scripts/chroma.exe" : ".chroma-venv/bin/chroma";
  cmd = path.join(root, bin);
  if (!fs.existsSync(cmd)) {
    console.error(`Chroma server not installed at ${cmd}.\nRun: npm run chroma:setup   (or use: npm run chroma:docker)`);
    process.exit(1);
  }
  args = ["run", "--path", dataDir, "--port", "8000"];
}
const child = spawn(cmd, args, { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
