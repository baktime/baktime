import { redactSecrets } from "../config/secrets.js";
import type { NamedTarget, RetentionPolicy } from "../config/schema.js";
import {
  buildCheckArgs,
  buildForgetArgs,
  buildPruneArgs,
  normalizeRetentionPolicy,
  parseForgetResult,
} from "../restic/client.js";
import type { RepositoryHandle } from "../restic/repositories.js";

export interface TargetRetentionResult {
  target: string;
  repository: string;
  policy: RetentionPolicy | null;
  status: "applied" | "skipped" | "failed";
  kept?: number;
  removed?: number;
  error?: string;
}

export interface RepositoryMaintenanceResult {
  repository: string;
  status: "pruned" | "failed";
  /** Which step failed — a failed `check` after a successful prune is the more alarming one. */
  failedStep?: "prune" | "check";
  error?: string;
}

export interface RetentionReport {
  kind: "retention";
  generatedAt: string;
  dryRun: boolean;
  targets: TargetRetentionResult[];
  repositories: RepositoryMaintenanceResult[];
}

export function hasRetentionFailures(report: RetentionReport): boolean {
  return (
    report.targets.some((result) => result.status === "failed") ||
    report.repositories.some((result) => result.status === "failed")
  );
}

/** A target's own `retention` wins over `.baktimerc.yml`'s `defaults.retention`, field set as a whole. */
export function effectiveRetentionPolicy(
  target: NamedTarget,
  defaults: RetentionPolicy | undefined,
): RetentionPolicy | null {
  return normalizeRetentionPolicy(target.retention ?? defaults);
}

function errorMessage(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

export interface ApplyRetentionOptions {
  dryRun?: boolean;
  now?: Date;
}

/**
 * Enforces every target's retention policy in two phases:
 *
 * 1. `restic forget` per target, scoped to that target's tag — cheap,
 *    metadata-only, and a failure for one target never stops the others.
 * 2. `restic prune` + `restic check` once per *repository* in which phase 1
 *    actually removed something — pruning is the expensive, exclusive-lock
 *    part, so it's skipped for repositories where nothing changed and never
 *    repeated per target for a shared repository.
 *
 * Everything runs sequentially: restic locks are per repository, and
 * parallel maintenance on a shared repository would only contend.
 */
export async function applyRetention(
  targets: readonly NamedTarget[],
  defaults: RetentionPolicy | undefined,
  resolveRepository: (target: NamedTarget) => RepositoryHandle,
  options: ApplyRetentionOptions = {},
): Promise<RetentionReport> {
  const dryRun = options.dryRun ?? false;
  const report: RetentionReport = {
    kind: "retention",
    generatedAt: (options.now ?? new Date()).toISOString(),
    dryRun,
    targets: [],
    repositories: [],
  };
  const repositoriesToPrune = new Map<string, RepositoryHandle>();

  for (const target of [...targets].sort((a, b) => a.name.localeCompare(b.name))) {
    const policy = effectiveRetentionPolicy(target, defaults);
    const repository = resolveRepository(target);
    if (!policy) {
      report.targets.push({ target: target.name, repository: repository.label, policy, status: "skipped" });
      continue;
    }

    try {
      const { stdout } = await repository.run(buildForgetArgs({ tag: target.name, policy, dryRun }));
      const { kept, removed } = parseForgetResult(stdout);
      report.targets.push({
        target: target.name,
        repository: repository.label,
        policy,
        status: "applied",
        kept,
        removed,
      });
      if (removed > 0 && !dryRun) repositoriesToPrune.set(repository.key, repository);
    } catch (error) {
      report.targets.push({
        target: target.name,
        repository: repository.label,
        policy,
        status: "failed",
        error: errorMessage(error),
      });
    }
  }

  for (const repository of repositoriesToPrune.values()) {
    let step: "prune" | "check" = "prune";
    try {
      await repository.run(buildPruneArgs());
      step = "check";
      await repository.run(buildCheckArgs());
      report.repositories.push({ repository: repository.label, status: "pruned" });
    } catch (error) {
      report.repositories.push({
        repository: repository.label,
        status: "failed",
        failedStep: step,
        error: errorMessage(error),
      });
    }
  }

  return report;
}

export function formatRetentionPolicy(policy: RetentionPolicy | null): string {
  if (!policy) return "keep everything";
  const parts: string[] = [];
  if (policy.keepLast) parts.push(`last ${policy.keepLast}`);
  if (policy.keepHourly) parts.push(`${policy.keepHourly} hourly`);
  if (policy.keepDaily) parts.push(`${policy.keepDaily} daily`);
  if (policy.keepWeekly) parts.push(`${policy.keepWeekly} weekly`);
  if (policy.keepMonthly) parts.push(`${policy.keepMonthly} monthly`);
  if (policy.keepYearly) parts.push(`${policy.keepYearly} yearly`);
  return parts.join(", ");
}

function tableCell(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").replaceAll("|", "\\|");
}

/** GitHub step-summary markdown, so every run's outcome is readable from the Actions UI. */
export function formatRetentionMarkdown(report: RetentionReport): string {
  const lines = [
    `## Retention${report.dryRun ? " (dry run — nothing deleted)" : ""}`,
    "",
    "| Target | Policy | Kept | Removed | Result |",
    "|---|---|---:|---:|---|",
  ];
  for (const result of report.targets) {
    const outcome =
      result.status === "failed" ? `❌ ${result.error ?? "failed"}` : result.status === "skipped" ? "skipped" : "✅";
    lines.push(
      `| ${result.target} | ${formatRetentionPolicy(result.policy)} | ${result.kept ?? "–"} | ${result.removed ?? "–"} | ${tableCell(outcome)} |`,
    );
  }
  if (report.repositories.length > 0) {
    lines.push("", "| Repository | Prune + check |", "|---|---|");
    for (const result of report.repositories) {
      const outcome =
        result.status === "pruned" ? "✅" : `❌ ${result.failedStep} failed: ${result.error ?? ""}`;
      lines.push(`| ${result.repository} | ${tableCell(outcome)} |`);
    }
  } else if (!report.dryRun) {
    lines.push("", "Nothing was forgotten, so no repository needed pruning.");
  }
  return `${lines.join("\n")}\n`;
}
