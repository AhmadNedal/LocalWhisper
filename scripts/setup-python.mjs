// Creates backend/.venv and installs the Python dependencies.
//
// Runs automatically after `npm install` (postinstall) and can be re-run with
// `npm run setup`, `npm run setup:gpu` (force NVIDIA libraries) or
// `npm run setup:cpu` (skip them). It is incremental: when the requirement
// files have not changed since the last successful run, it finishes instantly.
//
// Environment:
//   PYTHON=<path>                    use a specific Python interpreter
//   LOCAL_TRANSCRIBER_SKIP_PYTHON=1  skip entirely (e.g. CI that only builds the UI)
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BACKEND_DIR, VENV_DIR, findPython, hasNvidiaGpu, run, venvExists, venvPython } from "./lib/python.mjs";

const args = new Set(process.argv.slice(2));
const invokedByNpmInstall = process.env.npm_lifecycle_event === "postinstall";
const forceGpu = args.has("--gpu");
const forceCpu = args.has("--cpu");

const c = { bold: "\x1b[1m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", reset: "\x1b[0m" };
const log = (msg) => console.log(`${c.bold}[setup]${c.reset} ${msg}`);

function fail(message) {
  console.error(`\n${c.red}${c.bold}[setup] ${message}${c.reset}\n`);
  // Don't break `npm install` for the JavaScript side; the app shows the same
  // guidance on screen. An explicit `npm run setup` does fail loudly.
  process.exit(invokedByNpmInstall ? 0 : 1);
}

if (process.env.LOCAL_TRANSCRIBER_SKIP_PYTHON === "1") {
  log("LOCAL_TRANSCRIBER_SKIP_PYTHON=1 → skipping Python setup.");
  process.exit(0);
}

const requirementFiles = ["requirements.txt"];
const gpuName = forceCpu ? null : hasNvidiaGpu();
const wantGpu = forceGpu || (!forceCpu && Boolean(gpuName));
if (wantGpu) requirementFiles.push("requirements-gpu.txt");

const stampFile = path.join(VENV_DIR, ".local-transcriber-stamp");
const fingerprint = createHash("sha256")
  .update(requirementFiles.map((f) => f + readFileSync(path.join(BACKEND_DIR, f), "utf8")).join("\n"))
  .digest("hex");

if (venvExists() && existsSync(stampFile) && readFileSync(stampFile, "utf8") === fingerprint) {
  log(`${c.green}Python environment is up to date${c.reset} (${wantGpu ? "GPU" : "CPU"} packages).`);
  process.exit(0);
}

// 1) Virtual environment -----------------------------------------------------
if (!venvExists()) {
  const python = findPython();
  if (!python) {
    fail(
      "Python 3.10–3.13 was not found.\n" +
        "  Install Python 3.12 from https://www.python.org/downloads/windows/ (tick “Add python.exe to PATH”),\n" +
        "  or: winget install Python.Python.3.12\n" +
        "  then run: npm run setup",
    );
  }
  log(`Creating virtual environment with Python ${python.version} → backend/.venv`);
  if (run(python.command, [...python.args, "-m", "venv", VENV_DIR]) !== 0) fail("Could not create the virtual environment.");
}

const py = venvPython();

// 2) Dependencies --------------------------------------------------------------
log("Upgrading pip…");
run(py, ["-m", "pip", "install", "--upgrade", "pip", "--disable-pip-version-check", "-q"]);

log("Installing backend dependencies (faster-whisper, CTranslate2, FastAPI, fpdf2)…");
if (run(py, ["-m", "pip", "install", "-r", path.join(BACKEND_DIR, "requirements.txt"), "--disable-pip-version-check"]) !== 0) {
  fail("pip install failed. Check your internet connection and try `npm run setup` again.");
}

if (wantGpu) {
  log(`NVIDIA GPU ${gpuName ? `detected (${gpuName})` : "requested"} → installing CUDA 12 cuBLAS + cuDNN 9 runtime…`);
  if (run(py, ["-m", "pip", "install", "-r", path.join(BACKEND_DIR, "requirements-gpu.txt"), "--disable-pip-version-check"]) !== 0) {
    console.warn(`${c.yellow}[setup] GPU libraries could not be installed; the app will use the CPU.${c.reset}`);
  }
} else {
  log("No NVIDIA GPU detected → CPU mode (run `npm run setup:gpu` later if you add one).");
}

// 3) Quick self-check --------------------------------------------------------------
const check = run(py, [
  "-c",
  "import faster_whisper, ctranslate2, fpdf, uharfbuzz, fastapi; print('faster-whisper', faster_whisper.__version__, '| CTranslate2', ctranslate2.__version__, '| CUDA devices:', ctranslate2.get_cuda_device_count())",
], { cwd: BACKEND_DIR });
if (check !== 0) fail("The Python environment was created but the self-check failed.");

writeFileSync(stampFile, fingerprint);
log(`${c.green}Python backend ready.${c.reset} Start the app with: npm run dev`);
