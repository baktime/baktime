import { redactSecrets, type SecretsStore } from "../config/secrets.js";
import type { NamedTarget, ResticBackendConfig } from "../config/schema.js";
import { ensureLocalResticInstalled } from "../restic/bootstrap-local.js";
import { ensureRemoteResticInstalled } from "../restic/bootstrap-remote.js";
import { buildStatsArgs, parseResticStats, runLocalRestic, type ResticStats } from "../restic/client.js";
import { buildResticEnv } from "../restic/env.js";
import { runRemoteCommand, type SshTarget } from "../ssh/connection.js";
import type { RepositorySummary } from "./weekly.js";

interface RepositoryQuery {
  label: string;
  run(): Promise<ResticStats>;
}

function configKey(config: ResticBackendConfig): string {
  return JSON.stringify([config.backend, config.repository]);
}

function errorMessage(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

/**
 * Inspects every distinct effective repository. Network repositories are
 * queried once from the runner; local repositories are host-local by
 * definition and therefore queried over each files target's SSH connection.
 * A failed repository query is represented in the report instead of
 * suppressing the rest of the weekly notification.
 */
export async function collectRepositorySummary(
  targets: readonly NamedTarget[],
  globalConfig: ResticBackendConfig,
  secrets: SecretsStore,
): Promise<RepositorySummary> {
  const queries: RepositoryQuery[] = [];
  const networkConfigs = new Map<string, ResticBackendConfig>();
  const localRepositories = new Set<string>();
  let localResticPathPromise: Promise<string> | undefined;

  function localResticPath(): Promise<string> {
    localResticPathPromise ??= ensureLocalResticInstalled().then((result) => result.resticPath);
    return localResticPathPromise;
  }

  for (const target of targets) {
    const config = target.type === "files" ? (target.restic ?? globalConfig) : globalConfig;
    if (config.backend !== "local") {
      networkConfigs.set(configKey(config), config);
      continue;
    }

    if (target.type !== "files") {
      queries.push({
        label: target.name,
        async run() {
          throw new Error("a local restic repository cannot be inspected for a database target");
        },
      });
      continue;
    }

    const localKey = JSON.stringify([
      target.host,
      target.sshUser,
      target.sshPort,
      target.sshKeySecretName,
      configKey(config),
    ]);
    if (localRepositories.has(localKey)) continue;
    localRepositories.add(localKey);

    queries.push({
      label: target.name,
      async run() {
        const sshTarget: SshTarget = {
          host: target.host,
          user: target.sshUser,
          port: target.sshPort,
          privateKey: secrets.resolve(target.sshKeySecretName),
        };
        const bootstrap = await ensureRemoteResticInstalled(sshTarget, {
          version: target.resticVersion,
        });
        const env = buildResticEnv(config, secrets);
        const { stdout } = await runRemoteCommand(
          sshTarget,
          bootstrap.resticPath,
          buildStatsArgs(),
          { env },
        );
        return parseResticStats(stdout);
      },
    });
  }

  for (const config of networkConfigs.values()) {
    queries.push({
      label: config.repository,
      async run() {
        const resticPath = await localResticPath();
        const { stdout } = await runLocalRestic(
          buildStatsArgs(),
          buildResticEnv(config, secrets),
          resticPath,
        );
        return parseResticStats(stdout);
      },
    });
  }

  const settled = await Promise.allSettled(queries.map((query) => query.run()));
  const summary: RepositorySummary = {
    storageBytes: 0,
    snapshots: 0,
    files: 0,
    checked: 0,
    unavailable: 0,
  };
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      summary.storageBytes += result.value.totalSize;
      summary.snapshots += result.value.snapshotsCount;
      summary.files += result.value.totalFileCount;
      summary.checked += 1;
      return;
    }
    summary.unavailable += 1;
    console.error(
      `Could not inspect restic repository for "${queries[index]?.label ?? "unknown"}": ${errorMessage(result.reason)}`,
    );
  });
  return summary;
}
