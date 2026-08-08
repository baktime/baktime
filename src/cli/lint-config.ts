import { loadConfig } from "../config/load.js";

/**
 * Entrypoint for ci.yml's lint-config job. `.baktimerc.yml` is the one part
 * of baktime's configuration that's actually committed (targets live only
 * in secrets — see config/discover-targets.ts), so it's the one part a PR
 * check can validate without any secrets access at all.
 */
const path = process.argv[2] ?? ".baktimerc.yml";
loadConfig(path);
console.log(`${path} is valid.`);
