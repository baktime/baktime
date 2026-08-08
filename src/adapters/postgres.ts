import type { PostgresTarget, ResticBackendConfig } from "../config/schema.js";
import type { SecretsStore } from "../config/secrets.js";
import {
  backupDatabaseTarget,
  type DatabaseBackupResult,
  type DatabaseConnectionInfo,
  type DatabaseDumpSpec,
} from "./database-common.js";

export function buildPgDumpArgs(
  connection: DatabaseConnectionInfo,
  user: string,
  database: string,
): string[] {
  return [
    "-h",
    connection.host,
    "-p",
    String(connection.port),
    "-U",
    user,
    "-d",
    database,
    // Forces a clear failure instead of an interactive password prompt —
    // the password is always supplied via PGPASSWORD (see database-common.ts).
    "--no-password",
  ];
}

const PG_DUMP_SPEC: DatabaseDumpSpec = {
  dumpCommand: "pg_dump",
  passwordEnvVar: "PGPASSWORD",
  buildDumpArgs: buildPgDumpArgs,
  fileExtension: "sql",
};

export async function backupPostgresTarget(
  target: PostgresTarget & { name: string },
  secrets: SecretsStore,
  resticConfig: ResticBackendConfig,
  localResticPath: string,
): Promise<DatabaseBackupResult> {
  return backupDatabaseTarget(PG_DUMP_SPEC, target, secrets, resticConfig, localResticPath);
}
