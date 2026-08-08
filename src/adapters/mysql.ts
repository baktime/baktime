import type { MysqlTarget, ResticBackendConfig } from "../config/schema.js";
import type { SecretsStore } from "../config/secrets.js";
import {
  backupDatabaseTarget,
  type DatabaseBackupResult,
  type DatabaseConnectionInfo,
  type DatabaseDumpSpec,
} from "./database-common.js";

export function buildMysqldumpArgs(
  connection: DatabaseConnectionInfo,
  user: string,
  database: string,
): string[] {
  return [
    "--single-transaction",
    "-h",
    connection.host,
    "-P",
    String(connection.port),
    "-u",
    user,
    database,
  ];
}

const MYSQL_DUMP_SPEC: DatabaseDumpSpec = {
  dumpCommand: "mysqldump",
  passwordEnvVar: "MYSQL_PWD",
  buildDumpArgs: buildMysqldumpArgs,
  fileExtension: "sql",
};

export async function backupMysqlTarget(
  target: MysqlTarget & { name: string },
  secrets: SecretsStore,
  resticConfig: ResticBackendConfig,
  localResticPath: string,
): Promise<DatabaseBackupResult> {
  return backupDatabaseTarget(MYSQL_DUMP_SPEC, target, secrets, resticConfig, localResticPath);
}
