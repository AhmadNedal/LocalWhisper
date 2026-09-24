// `npm run build:backend`: freezes the Python backend into a standalone folder
// (backend/dist/transcriber-backend) with PyInstaller. electron-builder then
// ships it inside the installer, so end users need no Python installation.
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BACKEND_DIR, run, venvExists, venvPython } from "./lib/python.mjs";

if (!venvExists()) {
  // First build on this computer: prepare the Python engine automatically.
  console.log("[build:backend] Python environment missing — setting it up first…");
  const setup = path.join(path.dirname(fileURLToPath(import.meta.url)), "setup-python.mjs");
  if (run(process.execPath, [setup]) !== 0 || !venvExists()) {
    console.error("[build:backend] Could not prepare the Python environment (see the messages above).");
    process.exit(1);
  }
}
const py = venvPython();

console.log("[build:backend] Installing PyInstaller…");
if (run(py, ["-m", "pip", "install", "-r", path.join(BACKEND_DIR, "requirements-build.txt"), "-q", "--disable-pip-version-check"]) !== 0) {
  process.exit(1);
}

rmSync(path.join(BACKEND_DIR, "dist"), { recursive: true, force: true });
rmSync(path.join(BACKEND_DIR, "build"), { recursive: true, force: true });

console.log("[build:backend] Freezing backend with PyInstaller (this takes a few minutes)…");
const code = run(
  py,
  ["-m", "PyInstaller", "transcriber-backend.spec", "--noconfirm", "--clean", "--distpath", "dist", "--workpath", "build"],
  { cwd: BACKEND_DIR },
);
if (code !== 0) process.exit(code);
console.log("[build:backend] Done → backend/dist/transcriber-backend");
