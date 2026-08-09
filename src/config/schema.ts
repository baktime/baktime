import { CronExpressionParser } from "cron-parser";
import { z } from "zod";

/**
 * Target names come from a GitHub secret suffix (`BAKTIME_TARGET_<NAME>`) and
 * are reused as history filenames, restic tags, and workflow matrix ids, so
 * they're constrained to a safe, lowercase, filesystem/URL-friendly charset.
 */
export const TargetNameSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9_-]{0,63}$/,
    "must be lowercase alphanumeric, '-' or '_', 1-64 chars, starting with a letter or digit",
  );

/** Name of a GitHub Actions secret (never a secret value itself). */
export const SecretNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be a valid GitHub secret name");

export const CronScheduleSchema = z.string().refine(
  (value) => {
    try {
      CronExpressionParser.parse(value, { tz: "UTC" });
      return true;
    } catch {
      return false;
    }
  },
  { message: "must be a valid cron expression" },
);

export const RetentionPolicySchema = z
  .object({
    keepLast: z.number().int().positive().optional(),
    keepHourly: z.number().int().nonnegative().optional(),
    keepDaily: z.number().int().nonnegative().optional(),
    keepWeekly: z.number().int().nonnegative().optional(),
    keepMonthly: z.number().int().nonnegative().optional(),
    keepYearly: z.number().int().nonnegative().optional(),
  })
  .strict();
export type RetentionPolicy = z.infer<typeof RetentionPolicySchema>;

function createResticBackendConfigSchema() {
  return z
    .object({
      backend: z.enum(["r2", "s3", "local", "custom"]).default("r2"),
      repository: z.string().min(1),
      passwordSecretName: SecretNameSchema,
      accessKeyIdSecretName: SecretNameSchema.optional(),
      secretAccessKeySecretName: SecretNameSchema.optional(),
    })
    .strict()
    .refine(
      (config) =>
        config.backend !== "r2" && config.backend !== "s3"
          ? true
          : Boolean(config.accessKeyIdSecretName && config.secretAccessKeySecretName),
      {
        message:
          'accessKeyIdSecretName and secretAccessKeySecretName are required when backend is "r2" or "s3"',
        path: ["accessKeyIdSecretName"],
      },
    );
}

export const ResticBackendConfigSchema = createResticBackendConfigSchema();
export type ResticBackendConfig = z.infer<typeof ResticBackendConfigSchema>;

export const SqliteBackupSchema = z
  .object({
    source: z.string().startsWith("/", "must be an absolute path"),
    destination: z.string().startsWith("/", "must be an absolute path"),
  })
  .strict()
  .refine((entry) => entry.source !== entry.destination, {
    message: "source and destination must be different paths",
    path: ["destination"],
  });
export type SqliteBackup = z.infer<typeof SqliteBackupSchema>;

export const FilesTargetSchema = z
  .object({
    type: z.literal("files"),
    host: z.string().min(1),
    sshUser: z.string().min(1),
    sshPort: z.number().int().positive().max(65535).default(22),
    sshKeySecretName: SecretNameSchema,
    paths: z.array(z.string().min(1)).min(1),
    excludes: z.array(z.string().min(1)).optional(),
    /** Optional target-specific backend, e.g. a local disk while DB targets keep using global R2. */
    restic: ResticBackendConfigSchema.optional(),
    /** Create transactionally consistent SQLite copies before restic snapshots the file tree. */
    sqliteBackups: z.array(SqliteBackupSchema).optional(),
    resticVersion: z.string().min(1).optional(),
    schedule: CronScheduleSchema,
    retention: RetentionPolicySchema.optional(),
  })
  .strict();
export type FilesTarget = z.infer<typeof FilesTargetSchema>;

const DirectConnectionSchema = z
  .object({
    mode: z.literal("direct"),
    host: z.string().min(1),
    port: z.number().int().positive().max(65535),
    tls: z.boolean().default(true),
  })
  .strict();

const TunnelConnectionSchema = z
  .object({
    mode: z.literal("tunnel"),
    jumpHost: z.string().min(1),
    jumpUser: z.string().min(1),
    jumpPort: z.number().int().positive().max(65535).default(22),
    jumpSshKeySecretName: SecretNameSchema,
    remoteHost: z.string().min(1),
    remotePort: z.number().int().positive().max(65535),
  })
  .strict();

export const DatabaseConnectionSchema = z.discriminatedUnion("mode", [
  DirectConnectionSchema,
  TunnelConnectionSchema,
]);
export type DatabaseConnection = z.infer<typeof DatabaseConnectionSchema>;

const databaseTargetShape = {
  database: z.string().min(1),
  connection: DatabaseConnectionSchema,
  userSecretName: SecretNameSchema,
  passwordSecretName: SecretNameSchema,
  schedule: CronScheduleSchema,
  retention: RetentionPolicySchema.optional(),
};

export const MysqlTargetSchema = z
  .object({ type: z.literal("mysql"), ...databaseTargetShape })
  .strict();
export type MysqlTarget = z.infer<typeof MysqlTargetSchema>;

export const PostgresTargetSchema = z
  .object({ type: z.literal("postgres"), ...databaseTargetShape })
  .strict();
export type PostgresTarget = z.infer<typeof PostgresTargetSchema>;

export const TargetSchema = z.discriminatedUnion("type", [
  FilesTargetSchema,
  MysqlTargetSchema,
  PostgresTargetSchema,
]);
export type Target = z.infer<typeof TargetSchema>;

/** A `Target` with its name attached from the `BAKTIME_TARGET_<NAME>` secret suffix. */
export type NamedTarget = Target & { name: string };

/**
 * Generic in `T` so that calling this with an already-narrowed target type
 * (e.g. a `FilesTarget` literal) returns `FilesTarget & { name: string }`,
 * not the widened `Target` union — discover-targets.ts, which only knows
 * the member type at runtime, still gets back the general `NamedTarget`.
 */
export function withName<T extends Target>(target: T, name: string): T & { name: string } {
  return { ...target, name };
}

export const StatusSiteConfigSchema = z
  .object({
    name: z.string().optional(),
    baseUrl: z.string().optional(),
    logoUrl: z.string().optional(),
    theme: z.enum(["light", "dark", "auto"]).optional(),
  })
  .strict();

/**
 * Instance-wide, non-sensitive settings only. Targets are never listed here —
 * see src/config/discover-targets.ts for why they're discovered from secrets
 * instead (mirrors upptime's notification config, not its `sites:` list).
 */
export const BaktimeConfigSchema = z
  .object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    restic: ResticBackendConfigSchema,
    defaults: z
      .object({
        retention: RetentionPolicySchema.optional(),
      })
      .strict()
      .optional(),
    /** Bare target names, for docs/CI-lint only — never authoritative for discovery. */
    knownTargets: z.array(TargetNameSchema).optional(),
    /**
     * Same field name and purpose as upptime's own `secrets:` allowlist:
     * bare GitHub secret *names* (e.g. "NOTIFICATION_DISCORD",
     * "NOTIFICATION_DISCORD_WEBHOOK_URL") for documentation only — never
     * authoritative, never a value. See docs/secrets.md.
     */
    secrets: z.array(SecretNameSchema).optional(),
    statusSite: StatusSiteConfigSchema.optional(),
  })
  .strict();
export type BaktimeConfig = z.infer<typeof BaktimeConfigSchema>;
