import { appendFileSync } from "node:fs";
import { discoverTargets } from "../config/discover-targets.js";
import { loadConfig } from "../config/load.js";
import { SecretsStore } from "../config/secrets.js";
import { discoverNotificationChannels, notifyAll } from "../notifications/dispatch.js";
import {
  applyRetention,
  formatRetentionMarkdown,
  formatRetentionPolicy,
  hasRetentionFailures,
  type RetentionReport,
} from "../retention/apply.js";
import { createRepositoryResolver } from "../restic/repositories.js";

/**
 * Entrypoint for prune.yml. Discovers targets from secrets exactly like
 * backup.yml does, then forgets/prunes per each target's retention policy
 * (see retention/apply.ts). Notifies only on failure — a routine daily
 * "old snapshots removed" message would be noise; the per-run outcome is
 * always in the workflow's step summary instead.
 *
 * `BAKTIME_RETENTION_DRY_RUN=true` reports what would be removed without
 * removing (or pruning) anything.
 */
export async function runApplyRetention(): Promise<RetentionReport> {
  const config = loadConfig(process.env.BAKTIME_CONFIG_PATH ?? ".baktimerc.yml");
  const secrets = SecretsStore.fromEnv();
  const { targets, errors } = discoverTargets(secrets);
  for (const error of errors) {
    console.error(error.message);
  }

  const dryRun = process.env.BAKTIME_RETENTION_DRY_RUN === "true";
  const report = await applyRetention(
    targets,
    config.defaults?.retention,
    createRepositoryResolver(config.restic, secrets),
    { dryRun },
  );

  for (const result of report.targets) {
    const policy = formatRetentionPolicy(result.policy);
    if (result.status === "failed") {
      console.error(`"${result.target}" (${policy}): forget failed: ${result.error}`);
    } else if (result.status === "skipped") {
      console.log(`"${result.target}": no retention policy, keeping every snapshot`);
    } else {
      console.log(
        `"${result.target}" (${policy}): kept ${result.kept}, ${dryRun ? "would remove" : "removed"} ${result.removed}`,
      );
    }
  }
  for (const result of report.repositories) {
    if (result.status === "failed") {
      console.error(`${result.repository}: ${result.failedStep} failed: ${result.error}`);
    } else {
      console.log(`${result.repository}: pruned and checked`);
    }
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, formatRetentionMarkdown(report));
  }

  if (hasRetentionFailures(report)) {
    await notifyAll(discoverNotificationChannels(secrets), report);
    process.exitCode = 1;
  }
  return report;
}

const isDirectRun = process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href;
if (isDirectRun) {
  runApplyRetention().catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  });
}
