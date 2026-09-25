// Before building the installer: make sure every Node package the installed app
// needs at run time (package.json "dependencies", e.g. electron-updater) is
// present, and run `npm install` once if one is missing (after pulling a new version).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./lib/python.mjs";

const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const missing = Object.keys(pkg.dependencies || {}).filter(
  (name) => !existsSync(path.join(ROOT, "node_modules", ...name.split("/"), "package.json")),
);
if (missing.length) {
  console.log(`[deps] Installing missing packages: ${missing.join(", ")}`);
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const r = spawnSync(npm, ["install", "--no-audit", "--no-fund"], { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) {
    console.error("[deps] npm install failed — run it yourself, then try again.");
    process.exit(r.status || 1);
  }
}
