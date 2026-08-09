import { discoverTargets } from "../config/discover-targets.js";
import { loadConfig } from "../config/load.js";
import type { MysqlTarget, NamedTarget, PostgresTarget } from "../config/schema.js";
import { SecretsStore } from "../config/secrets.js";
import { ensureLocalResticInstalled } from "../restic/bootstrap-local.js";
import { runLocalRestic } from "../restic/client.js";
import { buildResticEnv } from "../restic/env.js";
import { execFile, spawnPipeline } from "../util/exec.js";

interface ResticLsEntry {
  path?: string;
  type?: string;
}

interface ResticSnapshot {
  short_id?: string;
}

function parseJsonLines(stdout: string): unknown[] {
  return stdout
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

/**
 * A `--stdin` backup (src/adapters/database-common.ts) stores exactly one
 * file per snapshot — this finds its path so it can be `restic dump`ed back
 * out without the caller needing to know the timestamped filename restic
 * chose for it at backup time.
 */
export function findSoleFilePath(lsOutput: unknown[]): string {
  const fileEntries = lsOutput.filter(
    (entry): entry is ResticLsEntry =>
      typeof entry === "object" && entry !== null && (entry as ResticLsEntry).type === "file",
  );
  if (fileEntries.length !== 1) {
    throw new Error(
      `Expected exactly one file in this snapshot (it should be a database --stdin backup), found ${fileEntries.length}`,
    );
  }
  const path = fileEntries[0]?.path;
  if (!path) {
    throw new Error("restic ls returned a file entry with no path");
  }
  return path;
}

interface ImportSpec {
  /** e.g. "mysql" | "psql" */
  importCommand: string;
  passwordEnvVar: string;
  buildImportArgs(host: string, port: number, user: string, database: string): string[];
  /** Query run (as one statement) to list existing table names, for the pre-import drop. */
  listTablesArgs(host: string, port: number, user: string, database: string): string[];
  parseTableNames(stdout: string): string[];
  buildDropArgs(host: string, port: number, user: string, database: string, tableNames: string[]): string[];
}

export const MYSQL_IMPORT_SPEC: ImportSpec = {
  importCommand: "mysql",
  passwordEnvVar: "MYSQL_PWD",
  buildImportArgs: (host, port, user, database) => ["-h", host, "-P", String(port), "-u", user, database],
  listTablesArgs: (host, port, user, database) => [
    "-h",
    host,
    "-P",
    String(port),
    "-u",
    user,
    "-N",
    "-e",
    "SHOW TABLES",
    database,
  ],
  parseTableNames: (stdout) => stdout.split("\n").map((line) => line.trim()).filter(Boolean),
  buildDropArgs: (host, port, user, database, tableNames) => [
    "-h",
    host,
    "-P",
    String(port),
    "-u",
    user,
    "-e",
    `SET FOREIGN_KEY_CHECKS=0; ${tableNames.map((name) => `DROP TABLE IF EXISTS \`${name}\`;`).join(" ")}`,
    database,
  ],
};

export const PSQL_IMPORT_SPEC: ImportSpec = {
  importCommand: "psql",
  passwordEnvVar: "PGPASSWORD",
  buildImportArgs: (host, port, user, database) => [
    "-h",
    host,
    "-p",
    String(port),
    "-U",
    user,
    "-v",
    "ON_ERROR_STOP=1",
    "-d",
    database,
  ],
  listTablesArgs: (host, port, user, database) => [
    "-h",
    host,
    "-p",
    String(port),
    "-U",
    user,
    "-Atqc",
    "select schemaname || '.' || tablename from pg_tables where schemaname not in ('pg_catalog', 'information_schema')",
    database,
  ],
  parseTableNames: (stdout) => stdout.split("\n").map((line) => line.trim()).filter(Boolean),
  buildDropArgs: (host, port, user, database, tableNames) => [
    "-h",
    host,
    "-p",
    String(port),
    "-U",
    user,
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    tableNames.map((name) => `DROP TABLE IF EXISTS ${name} CASCADE;`).join(" "),
    "-d",
    database,
  ],
};

function importSpecFor(target: NamedTarget): ImportSpec {
  if (target.type === "mysql") return MYSQL_IMPORT_SPEC;
  if (target.type === "postgres") return PSQL_IMPORT_SPEC;
  throw new Error(`Target "${target.name}" is a "${target.type}" target, not mysql/postgres — can't restore into it`);
}

/**
 * Restores the latest `--stdin` database snapshot tagged `fromTag` into the
 * live `into` target, overwriting its current contents. Destructive by
 * design — callers are expected to have already taken (or be about to take)
 * a fresh backup of `into` first, so the overwrite is recoverable. Existing
 * tables are dropped before the import runs (a plain mysqldump/pg_dump
 * doesn't emit its own DROP statements), so this is a clean replace, not a
 * merge.
 */
export async function restoreSnapshot(fromTag: string, intoTargetName: string): Promise<void> {
  const secrets = SecretsStore.fromEnv();
  const { targets, errors } = discoverTargets(secrets);
  for (const error of errors) {
    console.error(error.message);
  }

  const target = targets.find((candidate) => candidate.name === intoTargetName);
  if (!target) {
    throw new Error(`No valid target named "${intoTargetName}" was discovered`);
  }
  const spec = importSpecFor(target);
  const dbTarget = target as (MysqlTarget | PostgresTarget) & { name: string };
  if (dbTarget.connection.mode !== "direct") {
    throw new Error(`Target "${target.name}": restore-snapshot only supports "direct" connections for now`);
  }
  const { host, port } = dbTarget.connection;
  const user = secrets.resolve(dbTarget.userSecretName);
  const password = secrets.resolve(dbTarget.passwordSecretName);
  const database = dbTarget.database;

  const config = loadConfig(process.env.BAKTIME_CONFIG_PATH ?? ".baktimerc.yml");
  const resticEnv = buildResticEnv(config.restic, secrets);
  const { resticPath } = await ensureLocalResticInstalled();

  const { stdout: snapshotsJson } = await runLocalRestic(
    ["snapshots", "--tag", fromTag, "--json", "--latest", "1"],
    resticEnv,
    resticPath,
  );
  const snapshots = JSON.parse(snapshotsJson) as ResticSnapshot[];
  const snapshot = snapshots[0];
  if (!snapshot?.short_id) {
    throw new Error(`No snapshot found tagged "${fromTag}" in the restic repository`);
  }
  console.log(`Found snapshot ${snapshot.short_id} tagged "${fromTag}"`);

  const { stdout: lsJson } = await runLocalRestic(["ls", snapshot.short_id, "--json"], resticEnv, resticPath);
  const filePath = findSoleFilePath(parseJsonLines(lsJson));
  console.log(`Snapshot file: ${filePath}`);

  const { stdout: tablesStdout } = await execFile(spec.importCommand, spec.listTablesArgs(host, port, user, database), {
    env: { PATH: process.env.PATH, [spec.passwordEnvVar]: password },
  });
  const existingTables = spec.parseTableNames(tablesStdout);
  console.log(`Dropping ${existingTables.length} existing table(s) in "${target.name}" before import: ${existingTables.join(", ") || "(none)"}`);
  if (existingTables.length > 0) {
    await execFile(spec.importCommand, spec.buildDropArgs(host, port, user, database, existingTables), {
      env: { PATH: process.env.PATH, [spec.passwordEnvVar]: password },
    });
  }

  console.log(`Restoring snapshot ${snapshot.short_id} into "${target.name}"...`);
  await spawnPipeline(
    { command: resticPath, args: ["dump", snapshot.short_id, filePath], env: { HOME: process.env.HOME, PATH: process.env.PATH, ...resticEnv } },
    {
      command: spec.importCommand,
      args: spec.buildImportArgs(host, port, user, database),
      env: { PATH: process.env.PATH, [spec.passwordEnvVar]: password },
    },
  );
  console.log(`Restore complete: "${fromTag}" -> "${target.name}"`);
}

async function main(): Promise<void> {
  const fromTag = process.argv[2];
  const intoTargetName = process.argv[3];
  if (!fromTag || !intoTargetName) {
    throw new Error("Usage: restore-snapshot.js <from-tag> <into-target-name>");
  }
  await restoreSnapshot(fromTag, intoTargetName);
}

const isDirectRun = process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href;
if (isDirectRun) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  });
}
