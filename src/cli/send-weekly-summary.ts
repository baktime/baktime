import { discoverTargets } from "../config/discover-targets.js";
import { loadConfig } from "../config/load.js";
import { SecretsStore } from "../config/secrets.js";
import { readHistory } from "../history/writer.js";
import { discoverNotificationChannels, notifyAll } from "../notifications/dispatch.js";
import { collectRepositorySummary } from "../summary/repositories.js";
import { buildWeeklySummary } from "../summary/weekly.js";

export async function sendWeeklySummary(): Promise<void> {
  const config = loadConfig(process.env.BAKTIME_CONFIG_PATH ?? ".baktimerc.yml");
  const secrets = SecretsStore.fromEnv();
  const { targets, errors } = discoverTargets(secrets);
  for (const error of errors) {
    console.error(error.message);
  }

  const generatedAt = new Date();
  const histories = new Map(targets.map((target) => [target.name, readHistory(target.name)]));
  const repository = await collectRepositorySummary(targets, config.restic, secrets);
  const summary = buildWeeklySummary(targets, histories, repository, generatedAt);
  const channels = discoverNotificationChannels(secrets);

  await notifyAll(channels, summary);
  console.log(
    `Processed weekly summary for ${channels.length} configured channel(s): ${summary.totals.healthy}/${summary.totals.targets} healthy, ${summary.repository.snapshots} snapshots, ${summary.repository.storageBytes} bytes stored`,
  );
}

async function main(): Promise<void> {
  await sendWeeklySummary();
}

const isDirectRun = process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href;
if (isDirectRun) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  });
}
