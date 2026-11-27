import type { HistoryRecord } from "../../src/history/types.js";
import type { RetentionReport } from "../../src/retention/apply.js";
import type { WeeklySummaryEvent, WeeklyTargetSummary } from "../../src/summary/weekly.js";

/** Shared sample events for the chat-provider tests (Slack, Telegram, webhook). */

export const successEvent: HistoryRecord = {
  timestamp: "2026-08-08T03:00:00.000Z",
  target: "webserver1",
  type: "files",
  durationMs: 4200,
  status: "success",
  snapshotId: "abc123",
  bytesAdded: 1536,
  verification: "sha256",
};

export const failureEvent: HistoryRecord = {
  timestamp: "2026-08-08T03:00:00.000Z",
  target: "webserver1",
  type: "files",
  durationMs: 1000,
  status: "failure",
  error: "ssh: connection <refused> & reset",
};

export function weeklyTarget(overrides: Partial<WeeklyTargetSummary> = {}): WeeklyTargetSummary {
  return {
    name: "database",
    type: "postgres",
    schedule: "0 5 * * *",
    health: "healthy",
    lastRunAt: "2026-08-21T05:00:00.000Z",
    lastRunStatus: "success",
    successfulBackups: 7,
    successesThisWeek: 3,
    failuresThisWeek: 0,
    ...overrides,
  };
}

export function weeklyEvent(targets: WeeklyTargetSummary[] = [weeklyTarget()]): WeeklySummaryEvent {
  const failing = targets.filter((target) => target.health === "failing").length;
  return {
    kind: "weekly-summary",
    generatedAt: "2026-08-21T08:17:00.000Z",
    periodStart: "2026-08-14T08:17:00.000Z",
    repository: { storageBytes: 1_073_741_824, snapshots: 12, checked: 1, unavailable: 0 },
    totals: {
      targets: targets.length,
      healthy: targets.length - failing,
      late: 0,
      failing,
      neverRun: 0,
      successfulBackups: 12,
      successesThisWeek: 5,
      failuresThisWeek: 1,
    },
    targets,
  };
}

export const retentionEvent: RetentionReport = {
  kind: "retention",
  generatedAt: "2026-09-27T05:23:00.000Z",
  dryRun: false,
  targets: [
    { target: "db", repository: "r2", policy: { keepDaily: 14 }, status: "applied", kept: 14, removed: 1 },
    { target: "web", repository: "vps", policy: { keepLast: 3 }, status: "failed", error: "ssh timeout" },
  ],
  repositories: [{ repository: "r2", status: "failed", failedStep: "prune", error: "lock held" }],
};
