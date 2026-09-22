// Shared helpers for locating Python and the project's virtual environment.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BACKEND_DIR = path.join(ROOT, "backend");
export const VENV_DIR = path.join(BACKEND_DIR, ".venv");
export const IS_WINDOWS = process.platform === "win32";

/** Supported Python versions (faster-whisper / CTranslate2 wheels exist for these). */
const MIN = [3, 10];
const MAX = [3, 13];

export function venvPython() {
  return IS_WINDOWS ? path.join(VENV_DIR, "Scripts", "python.exe") : path.join(VENV_DIR, "bin", "python");
}

export function venvExists() {
  return existsSync(venvPython());
}

/** Run a command, streaming output. Returns the exit code. */
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", cwd: ROOT, ...options });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

/** Run a command and capture stdout (null if it fails). */
export function capture(command, args) {
  try {
    const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, timeout: 20_000 });
    if (result.status !== 0 || result.error) return null;
    return (result.stdout || "").trim();
  } catch {
    return null;
  }
}

function versionOk(version) {
  const [major, minor] = version.split(".").map(Number);
  const v = major * 100 + minor;
  return v >= MIN[0] * 100 + MIN[1] && v <= MAX[0] * 100 + MAX[1];
}

/**
 * Find a suitable system Python.
 * Order: $PYTHON → Windows "py" launcher (3.12, 3.11, 3.13, 3.10) → python → python3.
 * @returns {{ command: string, args: string[], version: string } | null}
 */
export function findPython() {
  /** @type {{ command: string, args: string[] }[]} */
  const candidates = [];
  if (process.env.PYTHON) candidates.push({ command: process.env.PYTHON, args: [] });
  if (IS_WINDOWS) {
    for (const v of ["3.12", "3.11", "3.13", "3.10"]) candidates.push({ command: "py", args: [`-${v}`] });
  }
  candidates.push({ command: "python", args: [] }, { command: "python3", args: [] });

  for (const candidate of candidates) {
    const out = capture(candidate.command, [
      ...candidate.args,
      "-c",
      "import sys; print('%d.%d.%d' % sys.version_info[:3])",
    ]);
    if (out && /^\d+\.\d+\.\d+$/.test(out) && versionOk(out)) {
      return { ...candidate, version: out };
    }
  }
  return null;
}

/** True if an NVIDIA driver is installed (nvidia-smi works). */
export function hasNvidiaGpu() {
  const out = capture("nvidia-smi", ["--query-gpu=name,driver_version", "--format=csv,noheader"]);
  return out ? out.split("\n")[0].trim() : null;
}
