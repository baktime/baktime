import { redactSecrets, type SecretsStore } from "../config/secrets.js";
import type { NamedTarget, ResticBackendConfig } from "../config/schema.js";
import { buildStatsArgs, parseResticStats } from "../restic/client.js";
import { createRepositoryResolver, type RepositoryHandle } from "../restic/repositories.js";
import type { RepositorySummary } from "./weekly.js";

function errorMessage(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

/**
 * Inspects every distinct effective repository. Network repositories are
 * queried once from the runner; local repositories are host-local by
 * definition and therefore queried over each files target's SSH connection
 * (see restic/repositories.ts). A failed repository query is represented in
 * the report instead of suppressing the rest of the weekly notification.
 */
export async function collectRepositorySummary(
  targets: readonly NamedTarget[],
  globalConfig: ResticBackendConfig,
  secrets: SecretsStore,
): Promise<RepositorySummary> {
  const resolve = createRepositoryResolver(globalConfig, secrets);
  const handles = new Map<string, RepositoryHandle>();
  for (const target of targets) {
    const handle = resolve(target);
    if (!handles.has(handle.key)) handles.set(handle.key, handle);
  }
  const queries = [...handles.values()];

  const settled = await Promise.allSettled(
    queries.map(async (handle) => parseResticStats((await handle.run(buildStatsArgs())).stdout)),
  );
  const summary: RepositorySummary = {
    storageBytes: 0,
    snapshots: 0,
    checked: 0,
    unavailable: 0,
  };
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      summary.storageBytes += result.value.totalSize;
      summary.snapshots += result.value.snapshotsCount;
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
