/**
 * Guard against local/dev lockfiles.
 *
 * A `node_modules` containing symlinks (for example to a globally installed
 * pi) makes npm record `"link": true` plus absolute paths in package-lock.json.
 * Those entries cannot be installed on CI or another machine. Fail loudly.
 */
import { readFileSync } from "node:fs";

const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const allowed = ["https://registry.npmjs.org/", "git+", "https://github.com/"];

const bad = Object.entries(lock.packages ?? {}).filter(([, entry]) => {
  if (entry.link) return true;
  if (!entry.resolved) return false;
  return !allowed.some((prefix) => entry.resolved.startsWith(prefix));
});

if (bad.length > 0) {
  console.error("package-lock.json contains non-portable entries:");
  for (const [name, entry] of bad.slice(0, 20)) {
    console.error(`  ${name} -> ${entry.resolved ?? "(link)"}`);
  }
  console.error(`\n${bad.length} bad entr${bad.length === 1 ? "y" : "ies"}. Recreate the lockfile with a clean`);
  console.error("`rm -rf node_modules package-lock.json && npm install`.");
  process.exit(1);
}

console.log(`lockfile ok: ${Object.keys(lock.packages ?? {}).length} entries, all registry-resolved`);
