import type { RetentionPolicy } from "../config/schema.js";
import { execFile } from "../util/exec.js";
import type { ResticEnv } from "./env.js";

/**
 * Argument builders are invocation-agnostic on purpose: the exact same
 * `string[]` is used whether restic actually runs locally (`runLocalRestic`,
 * used for DB targets and for one-time repository setup) or remotely over
 * SSH (adapters/files.ts, via ssh/connection.ts's `runRemoteCommand`) — only
 * the executor differs.
 */

export function buildInitArgs(): string[] {
  return ["init", "--json"];
}

export function buildSnapshotsArgs(options: { tag?: string; latest?: number } = {}): string[] {
  const args = ["snapshots", "--json"];
  if (options.tag) args.push("--tag", options.tag);
  if (options.latest !== undefined) args.push("--latest", String(options.latest));
  return args;
}

export function buildCheckArgs(): string[] {
  return ["check"];
}

/**
 * How long forget/prune wait for a lock held by a concurrent backup instead
 * of failing immediately — maintenance runs on its own schedule and must
 * never race a backup into a spurious failure (or vice versa).
 */
export const MAINTENANCE_RETRY_LOCK = "30m";

const RETENTION_FLAGS = [
  ["keepLast", "--keep-last"],
  ["keepHourly", "--keep-hourly"],
  ["keepDaily", "--keep-daily"],
  ["keepWeekly", "--keep-weekly"],
  ["keepMonthly", "--keep-monthly"],
  ["keepYearly", "--keep-yearly"],
] as const satisfies readonly (readonly [keyof RetentionPolicy, string])[];

/** Drops unset and zero fields (restic treats 0 as "no rule"); `null` if nothing is left to enforce. */
export function normalizeRetentionPolicy(policy: RetentionPolicy | undefined): RetentionPolicy | null {
  if (!policy) return null;
  const normalized: RetentionPolicy = {};
  for (const [key] of RETENTION_FLAGS) {
    const value = policy[key];
    if (value !== undefined && value > 0) normalized[key] = value;
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

export interface ForgetArgsOptions {
  tag: string;
  policy: RetentionPolicy;
  dryRun?: boolean;
}

/**
 * `--group-by tags` is load-bearing, not cosmetic: restic's default grouping
 * is `host,paths`, but database snapshots get a unique timestamped
 * `--stdin-filename` path and a random GitHub runner hostname on every run,
 * so each would sit alone in its own group and never be forgotten. Every
 * baktime snapshot carries its target's name as its tag, which is the
 * grouping the retention policy is actually meant for.
 *
 * Deliberately without `--prune`: pruning is done once per repository
 * afterwards (see retention/apply.ts), not once per target.
 */
export function buildForgetArgs(options: ForgetArgsOptions): string[] {
  const args = [
    "forget",
    "--json",
    "--tag",
    options.tag,
    "--group-by",
    "tags",
    "--retry-lock",
    MAINTENANCE_RETRY_LOCK,
  ];
  for (const [key, flag] of RETENTION_FLAGS) {
    const value = options.policy[key];
    if (value !== undefined && value > 0) args.push(flag, String(value));
  }
  if (options.dryRun) args.push("--dry-run");
  return args;
}

export function buildPruneArgs(): string[] {
  return ["prune", "--retry-lock", MAINTENANCE_RETRY_LOCK];
}

export interface ForgetResult {
  kept: number;
  removed: number;
}

/**
 * Parses `restic forget --json`: an array of snapshot groups, each with a
 * `keep` and a `remove` list (`remove` is `null` when nothing is removed).
 */
export function parseForgetResult(stdout: string): ForgetResult {
  const trimmed = stdout.trim();
  if (trimmed === "" || trimmed === "null") return { kept: 0, removed: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (cause) {
    // Tolerate stray status lines around the JSON document (restic prints
    // e.g. "removed snapshot ..." notices on some versions) — the policy
    // result is the one line that is a JSON array.
    const jsonLine = trimmed
      .split("\n")
      .reverse()
      .find((line) => line.trimStart().startsWith("["));
    if (jsonLine === undefined) {
      throw new Error("restic forget output is not valid JSON", { cause });
    }
    try {
      parsed = JSON.parse(jsonLine);
    } catch {
      throw new Error("restic forget output is not valid JSON", { cause });
    }
  }
  if (!Array.isArray(parsed)) {
    throw new Error("restic forget output must be a JSON array");
  }
  const result: ForgetResult = { kept: 0, removed: 0 };
  for (const group of parsed) {
    if (!isRecord(group)) continue;
    if (Array.isArray(group.keep)) result.kept += group.keep.length;
    if (Array.isArray(group.remove)) result.removed += group.remove.length;
  }
  return result;
}

/**
 * `raw-data` counts each stored blob once, so the result reflects the
 * repository data retained after restic's deduplication rather than the
 * much larger sum of every snapshot's restore size.
 */
export function buildStatsArgs(): string[] {
  return ["stats", "--mode", "raw-data", "--json"];
}

export interface ResticStats {
  totalSize: number;
  snapshotsCount: number;
}

export interface BackupArgsOptions {
  tag: string;
  excludes?: string[];
}

export function buildBackupArgs(paths: readonly string[], options: BackupArgsOptions): string[] {
  const args = ["backup", "--json", "--tag", options.tag];
  for (const exclude of options.excludes ?? []) {
    args.push("--exclude", exclude);
  }
  args.push(...paths);
  return args;
}

export interface BackupStdinArgsOptions {
  tag: string;
  stdinFilename: string;
}

export function buildBackupStdinArgs(options: BackupStdinArgsOptions): string[] {
  return [
    "backup",
    "--json",
    "--tag",
    options.tag,
    "--stdin",
    "--stdin-filename",
    options.stdinFilename,
  ];
}

/**
 * Runs restic locally (on the GH Actions runner) — used for repository
 * setup and for DB `--stdin` backups. `resticPath` defaults to bare
 * `"restic"` (resolved via PATH) but callers should normally pass the path
 * resolved by `restic/bootstrap-local.ts`'s `ensureLocalResticInstalled`,
 * since restic isn't preinstalled on GitHub-hosted runners.
 *
 * `HOME` (or `XDG_CACHE_HOME`) must be present in the child's environment —
 * restic hard-requires a writable cache directory for `backup` specifically
 * (though not, it turns out, for `snapshots`/`init`) and fails fast with
 * "unable to open cache" without one. Since passing an explicit `env` to
 * `execFile` replaces the environment rather than extending it, this has to
 * be threaded through deliberately rather than relying on inheritance.
 */
export async function runLocalRestic(args: readonly string[], env: ResticEnv, resticPath = "restic") {
  return execFile(resticPath, args, { env: { HOME: process.env.HOME, PATH: process.env.PATH, ...env } });
}

/**
 * Idempotent: initializes the restic repository if `restic snapshots` can't
 * open it yet (its error in that case is indistinguishable-enough from "not
 * initialized" for our purposes — a real backend outage will also fail the
 * subsequent `init` call and surface clearly).
 */
export async function ensureRepositoryInitialized(
  env: ResticEnv,
  resticPath = "restic",
): Promise<"already-initialized" | "initialized"> {
  try {
    await runLocalRestic(buildSnapshotsArgs({ latest: 1 }), env, resticPath);
    return "already-initialized";
  } catch {
    await runLocalRestic(buildInitArgs(), env, resticPath);
    return "initialized";
  }
}

export interface BackupSummary {
  snapshotId: string;
  filesNew: number;
  filesChanged: number;
  filesUnmodified: number;
  dataAdded: number;
  totalBytesProcessed: number;
  totalDurationSeconds: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredNonNegativeNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`restic stats output has an invalid ${key}`);
  }
  return value;
}

/**
 * Parses the single JSON object emitted by `restic stats --json`. Only
 * fields common to every `--mode` are read — in particular `raw-data` mode
 * (the only mode this codebase uses, see `buildStatsArgs`) never emits
 * `total_file_count`, so that field isn't parsed here.
 */
export function parseResticStats(stdout: string): ResticStats {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (cause) {
    throw new Error("restic stats output is not valid JSON", { cause });
  }
  if (!isRecord(parsed)) {
    throw new Error("restic stats output must be a JSON object");
  }
  return {
    totalSize: requiredNonNegativeNumber(parsed, "total_size"),
    snapshotsCount: requiredNonNegativeNumber(parsed, "snapshots_count"),
  };
}

/**
 * `restic backup --json` prints one JSON object per line (progress updates,
 * then a final `"message_type":"summary"` line) — this scans from the end
 * for that summary line, since it's the only one carrying the final totals
 * and the resulting snapshot id.
 */
export function parseBackupSummary(stdout: string): BackupSummary {
  const lines = stdout
    .trim()
    .split("\n")
    .filter((line) => line.length > 0);

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (isRecord(parsed) && parsed.message_type === "summary") {
      return {
        snapshotId: String(parsed.snapshot_id ?? ""),
        filesNew: Number(parsed.files_new ?? 0),
        filesChanged: Number(parsed.files_changed ?? 0),
        filesUnmodified: Number(parsed.files_unmodified ?? 0),
        dataAdded: Number(parsed.data_added ?? 0),
        totalBytesProcessed: Number(parsed.total_bytes_processed ?? 0),
        totalDurationSeconds: Number(parsed.total_duration ?? 0),
      };
    }
  }

  throw new Error("restic backup output did not include a summary line");
}
