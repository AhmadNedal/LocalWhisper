// `npm run update:youtube`: upgrades yt-dlp (+ its YouTube JavaScript solver).
// YouTube changes frequently; when links stop working, this usually fixes it.
import { BACKEND_DIR, run, venvExists, venvPython } from "./lib/python.mjs";

if (!venvExists()) {
  console.error("[update:youtube] backend/.venv missing — run `npm run setup` first.");
  process.exit(1);
}
const code = run(venvPython(), ["-m", "pip", "install", "-U", "yt-dlp[default]", "deno", "--disable-pip-version-check"], {
  cwd: BACKEND_DIR,
});
if (code === 0) console.log("[update:youtube] yt-dlp is up to date. Restart the app.");
process.exit(code);
