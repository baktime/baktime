import type { NamedTarget } from "../config/schema.js";
import type { HistoryRecord } from "../history/types.js";
import type { Health } from "../status/generate-site.js";
import { computeHealth } from "../status/generate-site.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface RepositorySummary {
  /** Sum of raw-data bytes across every repository that could be inspected. */
  storageBytes: number;
  snapshots: number;
  files: number;
  checked: number;
  unavailable: number;
}

export interface WeeklyTargetSummary {
  name: string;
  type: NamedTarget["type"];
  schedule: string;
  health: Health;
  lastRunAt: string | null;
  lastRunStatus: HistoryRecord["status"] | null;
  successfulBackups: number;
  successesThisWeek: number;
  failuresThisWeek: number;
}

export interface WeeklySummaryEvent {
  kind: "weekly-summary";
  generatedAt: string;
  periodStart: string;
  repository: RepositorySummary;
  totals: {
    targets: number;
    healthy: number;
    late: number;
    failing: number;
    neverRun: number;
    successfulBackups: number;
    successesThisWeek: number;
    failuresThisWeek: number;
  };
  targets: WeeklyTargetSummary[];
}

export function buildWeeklySummary(
  targets: readonly NamedTarget[],
  histories: ReadonlyMap<string, readonly HistoryRecord[]>,
  repository: RepositorySummary,
  generatedAt: Date,
): WeeklySummaryEvent {
  const periodStart = new Date(generatedAt.getTime() - WEEK_MS);
  const targetSummaries = targets
    .map((target): WeeklyTargetSummary => {
      const history = histories.get(target.name) ?? [];
      const lastRun = history.at(-1) ?? null;
      const thisWeek = history.filter((record) => {
        const timestamp = new Date(record.timestamp).getTime();
        return (
          Number.isFinite(timestamp) &&
          timestamp >= periodStart.getTime() &&
          timestamp <= generatedAt.getTime()
        );
      });
      return {
        name: target.name,
        type: target.type,
        schedule: target.schedule,
        health: computeHealth(target.schedule, generatedAt, lastRun),
        lastRunAt: lastRun?.timestamp ?? null,
        lastRunStatus: lastRun?.status ?? null,
        successfulBackups: history.filter((record) => record.status === "success").length,
        successesThisWeek: thisWeek.filter((record) => record.status === "success").length,
        failuresThisWeek: thisWeek.filter((record) => record.status === "failure").length,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    kind: "weekly-summary",
    generatedAt: generatedAt.toISOString(),
    periodStart: periodStart.toISOString(),
    repository,
    totals: {
      targets: targetSummaries.length,
      healthy: targetSummaries.filter((target) => target.health === "healthy").length,
      late: targetSummaries.filter((target) => target.health === "late").length,
      failing: targetSummaries.filter((target) => target.health === "failing").length,
      neverRun: targetSummaries.filter((target) => target.health === "never-run").length,
      successfulBackups: targetSummaries.reduce((sum, target) => sum + target.successfulBackups, 0),
      successesThisWeek: targetSummaries.reduce((sum, target) => sum + target.successesThisWeek, 0),
      failuresThisWeek: targetSummaries.reduce((sum, target) => sum + target.failuresThisWeek, 0),
    },
    targets: targetSummaries,
  };
}
