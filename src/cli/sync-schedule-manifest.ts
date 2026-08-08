import { discoverTargets } from "../config/discover-targets.js";
import { SecretsStore } from "../config/secrets.js";
import { execFile } from "../util/exec.js";

export interface ScheduleManifestEntry {
  name: string;
  type: "files" | "mysql" | "postgres";
  schedule: string;
}

/** Projects each discovered target down to only what the Worker needs to decide *when* to fire — never host/paths/db name/credentials. */
export function buildScheduleManifest(
  targets: readonly { name: string; type: ScheduleManifestEntry["type"]; schedule: string }[],
): ScheduleManifestEntry[] {
  return targets
    .map((target) => ({ name: target.name, type: target.type, schedule: target.schedule }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface SyncOptions {
  wranglerConfigPath?: string;
  kvBindingName?: string;
  kvKey?: string;
}

/**
 * Entrypoint for sync-cloudflare-schedule.yml. Pushes the schedule manifest
 * into the Worker's Cloudflare KV namespace via `wrangler kv key put`,
 * resolving the namespace from the binding declared in
 * cloudflare-worker/wrangler.toml rather than tracking a separate namespace
 * ID secret. Requires CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID in the
 * environment (wrangler reads them itself) — verify the exact `wrangler kv`
 * subcommand syntax against the pinned wrangler version before relying on
 * this in production; CLI syntax has changed across wrangler major versions.
 */
export async function syncScheduleManifest(options: SyncOptions = {}): Promise<ScheduleManifestEntry[]> {
  const secrets = SecretsStore.fromEnv();
  const { targets, errors } = discoverTargets(secrets);

  for (const error of errors) {
    console.error(error.message);
  }

  const manifest = buildScheduleManifest(targets);
  const wranglerConfigPath = options.wranglerConfigPath ?? "cloudflare-worker/wrangler.toml";
  const kvBindingName = options.kvBindingName ?? "BAKTIME_SCHEDULES";
  const kvKey = options.kvKey ?? "manifest";

  await execFile("npx", [
    "wrangler",
    "kv",
    "key",
    "put",
    "--binding",
    kvBindingName,
    "--config",
    wranglerConfigPath,
    "--remote",
    kvKey,
    JSON.stringify(manifest),
  ]);

  if (errors.length > 0) {
    process.exitCode = 1;
  }

  return manifest;
}

async function main(): Promise<void> {
  const manifest = await syncScheduleManifest();
  console.log(`Synced schedule manifest for ${manifest.length} target(s) to Cloudflare KV.`);
}

const isDirectRun = process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href;
if (isDirectRun) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  });
}
