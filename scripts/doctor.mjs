// `npm run doctor`: prints a diagnostic report (Python env, FFmpeg, GPU/CUDA,
// models). Useful when something doesn't work — nothing is sent anywhere.
import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { BACKEND_DIR, ROOT, capture, findPython, hasNvidiaGpu, run, venvExists, venvPython } from "./lib/python.mjs";

const require = createRequire(import.meta.url);
const ok = (b) => (b ? "\x1b[32m✔\x1b[0m" : "\x1b[31m✘\x1b[0m");

console.log("\nLocal Transcriber — environment report\n");
console.log(`${ok(true)} Node.js ${process.version} (${process.platform}/${process.arch})`);

const sys = findPython();
console.log(`${ok(Boolean(sys))} System Python: ${sys ? `${sys.version} (${[sys.command, ...sys.args].join(" ")})` : "not found (need 3.10–3.13)"}`);
console.log(`${ok(venvExists())} backend/.venv: ${venvExists() ? venvPython() : "missing → npm run setup"}`);

let ffmpeg = "";
try {
  ffmpeg = require("ffmpeg-static") || "";
} catch {
  /* not installed */
}
const ffmpegVersion = ffmpeg && existsSync(ffmpeg) ? capture(ffmpeg, ["-version"])?.split("\n")[0] : null;
console.log(`${ok(Boolean(ffmpegVersion))} FFmpeg: ${ffmpegVersion ?? "missing → npm install"}`);

const gpu = hasNvidiaGpu();
console.log(`${ok(Boolean(gpu))} NVIDIA driver: ${gpu ?? "none detected (CPU mode)"}`);

const modelsDir = path.join(ROOT, "models");
const models = existsSync(modelsDir)
  ? readdirSync(modelsDir).filter((d) => existsSync(path.join(modelsDir, d, ".complete")))
  : [];
console.log(`${ok(models.length > 0)} Downloaded models: ${models.length ? models.join(", ") : "none yet (downloaded on first use)"}`);

if (venvExists()) {
  console.log("\nBackend self-check:");
  run(
    venvPython(),
    [
      "-c",
      [
        "import json",
        "from app.system_info import detect_devices",
        "import faster_whisper, ctranslate2",
        "print('  faster-whisper', faster_whisper.__version__, '| CTranslate2', ctranslate2.__version__)",
        "print('  ' + json.dumps(detect_devices().to_dict(), indent=2).replace(chr(10), chr(10) + '  '))",
      ].join("; "),
    ],
    { cwd: BACKEND_DIR },
  );
}
console.log("");
