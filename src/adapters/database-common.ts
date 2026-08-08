import type { MysqlTarget, PostgresTarget, ResticBackendConfig } from "../config/schema.js";
import type { SecretsStore } from "../config/secrets.js";
import { buildBackupStdinArgs, parseBackupSummary } from "../restic/client.js";
import { buildResticEnv } from "../restic/env.js";
import type { SshTarget } from "../ssh/connection.js";
import { openTunnel, type SshTunnel } from "../ssh/tunnel.js";
import { spawnPipeline } from "../util/exec.js";

export interface DatabaseConnectionInfo {
  host: string;
  port: number;
}

export interface DatabaseDumpSpec {
  /** e.g. "mysqldump" | "pg_dump" */
  dumpCommand: string;
  /** Env var the dump tool reads its password from ("MYSQL_PWD" | "PGPASSWORD") — never passed as a CLI argument, which would be visible in process listings. */
  passwordEnvVar: string;
  buildDumpArgs(connection: DatabaseConnectionInfo, user: string, database: string): string[];
  /** File extension recorded in the stdin filename restic stores the snapshot under (e.g. "sql"). */
  fileExtension: string;
}

export interface DatabaseBackupResult {
  snapshotId: string;
  bytesAdded: number;
}

type DatabaseTarget = (MysqlTarget | PostgresTarget) & { name: string };

async function resolveConnection(
  target: DatabaseTarget,
  secrets: SecretsStore,
): Promise<{ connection: DatabaseConnectionInfo; tunnel: SshTunnel | null }> {
  if (target.connection.mode === "direct") {
    return {
      connection: { host: target.connection.host, port: target.connection.port },
      tunnel: null,
    };
  }

  const jumpTarget: SshTarget = {
    host: target.connection.jumpHost,
    user: target.connection.jumpUser,
    port: target.connection.jumpPort,
    privateKey: secrets.resolve(target.connection.jumpSshKeySecretName),
  };
  const tunnel = await openTunnel(
    jumpTarget,
    target.connection.remoteHost,
    target.connection.remotePort,
  );
  return { connection: { host: "127.0.0.1", port: tunnel.localPort }, tunnel };
}

function timestampedFilename(targetName: string, extension: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${targetName}-${timestamp}.${extension}`;
}

/**
 * Shared orchestration for mysql/postgres targets: resolve the connection
 * (direct TCP, or via an SSH tunnel through a jump host — see
 * ssh/tunnel.ts), run the dump tool locally on the runner, and stream its
 * output straight into `restic backup --stdin` (src/util/exec.ts's
 * spawnPipeline) — no dump is ever buffered whole in memory or written to
 * disk before restic sees it.
 */
export async function backupDatabaseTarget(
  spec: DatabaseDumpSpec,
  target: DatabaseTarget,
  secrets: SecretsStore,
  resticConfig: ResticBackendConfig,
  localResticPath: string,
): Promise<DatabaseBackupResult> {
  if (resticConfig.backend === "local") {
    throw new Error(
      `Target "${target.name}": a "local" restic backend isn't reachable from the GitHub Actions ` +
        `runner, so it can't back up database targets — only "files" targets, which run restic on ` +
        `the target host itself. Use "r2", "s3", or a network-reachable "custom" repository instead.`,
    );
  }

  const { connection, tunnel } = await resolveConnection(target, secrets);

  try {
    const user = secrets.resolve(target.userSecretName);
    const password = secrets.resolve(target.passwordSecretName);
    const resticEnv = buildResticEnv(resticConfig, secrets);

    const dumpArgs = spec.buildDumpArgs(connection, user, target.database);
    const resticArgs = buildBackupStdinArgs({
      tag: target.name,
      stdinFilename: timestampedFilename(target.name, spec.fileExtension),
    });

    const { stdout } = await spawnPipeline(
      {
        command: spec.dumpCommand,
        args: dumpArgs,
        env: { PATH: process.env.PATH, [spec.passwordEnvVar]: password },
      },
      {
        command: localResticPath,
        args: resticArgs,
        env: { PATH: process.env.PATH, ...resticEnv },
      },
    );

    const summary = parseBackupSummary(stdout);
    return { snapshotId: summary.snapshotId, bytesAdded: summary.dataAdded };
  } finally {
    if (tunnel) {
      await tunnel.close();
    }
  }
}
