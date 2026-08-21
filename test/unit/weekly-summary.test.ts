import { describe, expect, it } from "vitest";
import type { NamedTarget } from "../../src/config/schema.js";
import type { HistoryRecord } from "../../src/history/types.js";
import { buildWeeklySummary } from "../../src/summary/weekly.js";

const NOW = new Date("2026-08-21T12:00:00.000Z");

function target(name: string, type: NamedTarget["type"] = "files"): NamedTarget {
  return { name, type, schedule: "0 5 * * *" } as NamedTarget;
}

function success(name: string, timestamp: string): HistoryRecord {
  return {
    timestamp,
    target: name,
    type: "files",
    durationMs: 1000,
    status: "success",
    snapshotId: `${name}-snapshot`,
    bytesAdded: 1024,
  };
}

function failure(name: string, timestamp: string): HistoryRecord {
  return {
    timestamp,
    target: name,
    type: "files",
    durationMs: 500,
    status: "failure",
    error: "unreachable",
  };
}

describe("buildWeeklySummary", () => {
  it("summarizes schedule-aware health, all-time backups, and seven-day outcomes", () => {
    const targets = [target("healthy"), target("late"), target("failing"), target("new", "postgres")];
    const histories = new Map<string, HistoryRecord[]>([
      [
        "healthy",
        [
          success("healthy", "2026-08-01T05:00:00.000Z"),
          success("healthy", "2026-08-21T05:00:00.000Z"),
        ],
      ],
      ["late", [success("late", "2026-08-18T05:00:00.000Z")]],
      [
        "failing",
        [
          success("failing", "2026-08-20T05:00:00.000Z"),
          failure("failing", "2026-08-21T05:00:00.000Z"),
        ],
      ],
    ]);
    const repository = {
      storageBytes: 10_000,
      snapshots: 4,
      files: 100,
      checked: 1,
      unavailable: 0,
    };

    const summary = buildWeeklySummary(targets, histories, repository, NOW);

    expect(summary.periodStart).toBe("2026-08-14T12:00:00.000Z");
    expect(summary.repository).toEqual(repository);
    expect(summary.totals).toEqual({
      targets: 4,
      healthy: 1,
      late: 1,
      failing: 1,
      neverRun: 1,
      successfulBackups: 4,
      successesThisWeek: 3,
      failuresThisWeek: 1,
    });
    expect(summary.targets.map((entry) => entry.name)).toEqual(["failing", "healthy", "late", "new"]);
    expect(summary.targets.find((entry) => entry.name === "healthy")).toMatchObject({
      health: "healthy",
      successfulBackups: 2,
      successesThisWeek: 1,
    });
    expect(summary.targets.find((entry) => entry.name === "new")).toMatchObject({
      health: "never-run",
      lastRunAt: null,
      lastRunStatus: null,
    });
  });

  it("returns zeroed totals for an empty instance", () => {
    const summary = buildWeeklySummary(
      [],
      new Map(),
      { storageBytes: 0, snapshots: 0, files: 0, checked: 0, unavailable: 0 },
      NOW,
    );
    expect(summary.totals.targets).toBe(0);
    expect(summary.targets).toEqual([]);
  });
});
