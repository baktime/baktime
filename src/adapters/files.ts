import type { SecretsStore } from "../config/secrets.js";
import type { FilesTarget, ResticBackendConfig } from "../config/schema.js";
import { buildBackupArgs, parseBackupSummary } from "../restic/client.js";
import { buildResticEnv, type ResticEnv } from "../restic/env.js";
import { ensureRemoteResticInstalled, type BootstrapResult } from "../restic/bootstrap-remote.js";
import { runRemoteCommand, type SshTarget } from "../ssh/connection.js";

export interface FilesBackupResult {
  snapshotId: string;
  bytesAdded: number;
  filesNew: number;
  filesChanged: number;
  totalBytesProcessed: number;
  verification: "sha256";
  bootstrapAction: BootstrapResult["action"];
}

/**
 * Backs up a "files" target: bootstraps a verified restic binary on the
 * target host (see restic/bootstrap-remote.ts), then runs `restic backup`
 * *on that host*, over SSH, against the shared repository — file bytes
 * never transit the GitHub Actions runner, and restic's chunk-level dedup
 * carries over between runs. Repository credentials are exported into that
 * one remote invocation's environment only (see
 * ssh/shell-quote.ts#buildRemoteCommandWithEnv) — never written to a remote
 * dotfile.
 */
export async function backupFilesTarget(
  target: FilesTarget & { name: string },
  secrets: SecretsStore,
  resticConfig: ResticBackendConfig,
): Promise<FilesBackupResult> {
  const sshTarget: SshTarget = {
    host: target.host,
    user: target.sshUser,
    port: target.sshPort,
    privateKey: secrets.resolve(target.sshKeySecretName),
  };

  const bootstrap = await ensureRemoteResticInstalled(sshTarget, {
    version: target.resticVersion,
  });

  const env: ResticEnv = buildResticEnv(resticConfig, secrets);
  const args = buildBackupArgs(target.paths, {
    tag: target.name,
    excludes: target.excludes,
  });

  const { stdout } = await runRemoteCommand(sshTarget, bootstrap.resticPath, args, { env });
  const summary = parseBackupSummary(stdout);

  return {
    snapshotId: summary.snapshotId,
    bytesAdded: summary.dataAdded,
    filesNew: summary.filesNew,
    filesChanged: summary.filesChanged,
    totalBytesProcessed: summary.totalBytesProcessed,
    verification: "sha256",
    bootstrapAction: bootstrap.action,
  };
}
