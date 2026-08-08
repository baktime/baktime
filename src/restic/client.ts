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
 */
export async function runLocalRestic(args: readonly string[], env: ResticEnv, resticPath = "restic") {
  return execFile(resticPath, args, { env });
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
