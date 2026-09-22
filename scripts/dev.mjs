// `npm run dev`: starts the Next.js dev server, waits for it, then launches
// Electron pointing at it. Electron itself starts the Python backend.
// Closing the app window stops everything.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import http from "node:http";
import path from "node:path";
import { ROOT, venvExists } from "./lib/python.mjs";

const require = createRequire(import.meta.url);

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  console.error(
    `[dev] Node.js ${process.versions.node} is too old — Electron needs Node 22.12 or newer.\n` +
      "      Install Node 22 LTS (e.g. `winget install OpenJS.NodeJS.LTS`), then delete node_modules and run `npm install`.",
  );
  process.exit(1);
}
const PORT = Number(process.env.UI_PORT || 3123);
const URL = `http://localhost:${PORT}`;

if (!venvExists()) {
  console.warn("[dev] backend/.venv not found — run `npm run setup`. The UI will show setup instructions.");
}

const nextBin = path.join(path.dirname(require.resolve("next/package.json")), "dist", "bin", "next");
const next = spawn(process.execPath, [nextBin, "dev", "frontend", "--port", String(PORT)], {
  cwd: ROOT,
  stdio: "inherit",
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
});

function waitForServer(timeoutMs = 120_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(URL, (res) => {
        res.resume();
        resolve(undefined);
      });
      req.on("error", () => {
        if (Date.now() - started > timeoutMs) reject(new Error("Next.js dev server did not start"));
        else setTimeout(attempt, 400);
      });
    };
    attempt();
  });
}

let electron = null;
function shutdown(code = 0) {
  if (electron && electron.exitCode === null) electron.kill();
  if (next.exitCode === null) next.kill();
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
next.on("exit", (code) => {
  if (electron === null) shutdown(code ?? 1);
});

try {
  await waitForServer();
} catch (err) {
  console.error(`[dev] ${err.message}`);
  shutdown(1);
}

const electronBinary = require("electron"); // path to the Electron executable
electron = spawn(electronBinary, ["."], {
  cwd: ROOT,
  stdio: "inherit",
  env: { ...process.env, ELECTRON_START_URL: URL, NODE_ENV: "development" },
});
electron.on("exit", (code) => shutdown(code ?? 0));
