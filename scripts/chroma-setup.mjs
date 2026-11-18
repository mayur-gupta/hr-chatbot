// One-time install of the Python Chroma server into .chroma-venv
import { execFileSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const venv = path.join(root, ".chroma-venv");
const py = process.platform === "win32" ? path.join(venv, "Scripts", "python.exe") : path.join(venv, "bin", "python");
const run = (c, a) => execFileSync(c, a, { stdio: "inherit", cwd: root });
run(process.platform === "win32" ? "python" : "python3", ["-m", "venv", venv]);
run(py, ["-m", "pip", "install", "--disable-pip-version-check", "-r", "chroma-server-requirements.txt"]);
console.log("Chroma server installed. Start it with: npm run chroma");
