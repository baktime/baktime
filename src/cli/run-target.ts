import { backupFilesTarget } from "../adapters/files.js";
import { backupMysqlTarget } from "../adapters/mysql.js";
import { backupPostgresTarget } from "../adapters/postgres.js";
import { discoverTargets } from "../config/discover-targets.js";
import { loadConfig } from "../config/load.js";
import type { BaktimeConfig, NamedTarget } from "../config/schema.js";
import { SecretsStore } from "../config/secrets.js";
import { appendRecord, getLastRunAt } from "../history/writer.js";
import type { HistoryRecord } from "../history/types.js";
import { discoverNotificationChannels, notifyAll } from "../notifications/dispatch.js";
import { ensureLocalResticInstalled } from "../restic/bootstrap-local.js";
import { ensureRepositoryInitialized } from "../restic/client.js";
import { buildResticEnv } from "../restic/env.js";
import { isDue } from "../scheduling/is-due.js";

interface AdapterResult {
  snapshotId: string;
  bytesAdded: number;
  verification?: "sha256";
}

async function runAdapter(
  target: NamedTarget,
  secrets: SecretsStore,
  resticConfig: BaktimeConfig["restic"],
  localResticPath: string,
): Promise<AdapterResult> {
  switch (target.type) {
    case "files":
      return backupFilesTarget(target, secrets, resticConfig);
    case "mysql":
      return backupMysqlTarget(target, secrets, resticConfig, localResticPath);
    case "postgres":
      return backupPostgresTarget(target, secrets, resticConfig, localResticPath);
  }
}

/**
 * Entrypoint for backup.yml's per-target job — used both for the
 * Worker-dispatched single-target path and the workflow_dispatch matrix
 * fallback. Re-derives the target from secrets rather than trusting
 * whatever triggered it, and re-checks due-ness against history as a cheap
 * safety net against a briefly-stale Worker KV schedule manifest.
 */
export async function runTarget(targetName: string): Promise<void> {
  const config = loadConfig(process.env.BAKTIME_CONFIG_PATH ?? ".baktimerc.yml");
  const secrets = SecretsStore.fromEnv();
  const { targets, errors } = discoverTargets(secrets);

  for (const error of errors) {
    console.error(error.message);
  }

  const target = targets.find((candidate) => candidate.name === targetName);
  if (!target) {
    const hint =
      errors.length > 0
        ? ` (${errors.length} target secret(s) also failed validation — see errors above)`
        : "";
    throw new Error(`No valid target named "${targetName}" was discovered${hint}`);
  }

  if (process.env.BAKTIME_SKIP_DUE_CHECK !== "true") {
    const lastRunAt = getLastRunAt(target.name);
    if (!isDue(target.schedule, new Date(), lastRunAt)) {
      console.log(
        `"${target.name}" is not due yet (last run: ${lastRunAt?.toISOString() ?? "never"}); skipping.`,
      );
      return;
    }
  }

  const startedAt = new Date();
  const resticEnv = buildResticEnv(config.restic, secrets);
  // restic isn't preinstalled on GitHub-hosted runners — every run needs a
  // local copy at least for this repo-setup step, and database targets need
  // it again for their own `restic backup --stdin` invocation.
  const { resticPath: localResticPath } = await ensureLocalResticInstalled();
  await ensureRepositoryInitialized(resticEnv, localResticPath);

  // Discovered once up front (cheap — just a few secret lookups) and reused
  // for whichever outcome below; a notification failure is logged, never
  // thrown, so it can't mask the backup's own success/failure.
  const notificationChannels = discoverNotificationChannels(secrets);

  try {
    const result = await runAdapter(target, secrets, config.restic, localResticPath);
    const record: HistoryRecord = {
      timestamp: startedAt.toISOString(),
      target: target.name,
      type: target.type,
      durationMs: Date.now() - startedAt.getTime(),
      status: "success",
      snapshotId: result.snapshotId,
      bytesAdded: result.bytesAdded,
      ...(result.verification ? { verification: result.verification } : {}),
    };
    appendRecord(target.name, record);
    console.log(`Backed up "${target.name}": snapshot ${result.snapshotId}, +${result.bytesAdded} bytes added`);
    await notifyAll(notificationChannels, record);
  } catch (error) {
    const record: HistoryRecord = {
      timestamp: startedAt.toISOString(),
      target: target.name,
      type: target.type,
      durationMs: Date.now() - startedAt.getTime(),
      status: "failure",
      error: error instanceof Error ? error.message : String(error),
    };
    appendRecord(target.name, record);
    await notifyAll(notificationChannels, record);
    throw error;
  }
}

async function main(): Promise<void> {
  const targetName = process.argv[2];
  if (!targetName) {
    throw new Error("Usage: run-target.js <target-name>");
  }
  await runTarget(targetName);
}

const isDirectRun = process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href;
if (isDirectRun) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  });
}
