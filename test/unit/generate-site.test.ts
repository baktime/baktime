import { describe, expect, it, vi } from "vitest";
import type { HistoryRecord } from "../../src/history/types.js";

const readHistoryMock = vi.fn();
vi.mock("../../src/history/writer.js", () => ({
  readHistory: (...args: unknown[]) => readHistoryMock(...args),
}));

const { buildTargetStatuses, computeHealth, renderSiteHtml } = await import(
  "../../src/status/generate-site.js"
);

const NOW = new Date("2026-08-09T12:00:00Z");

function successRecord(overrides: Partial<HistoryRecord> = {}): HistoryRecord {
  return {
    timestamp: "2026-08-09T05:00:00Z",
    target: "wanda-mysql",
    type: "mysql",
    durationMs: 1234,
    status: "success",
    snapshotId: "abcdef0123456789",
    bytesAdded: 2048,
    ...overrides,
  } as HistoryRecord;
}

function failureRecord(overrides: Partial<HistoryRecord> = {}): HistoryRecord {
  return {
    timestamp: "2026-08-09T05:00:00Z",
    target: "wanda-mysql",
    type: "mysql",
    durationMs: 500,
    status: "failure",
    error: "Access denied for user",
    ...overrides,
  } as HistoryRecord;
}

describe("computeHealth", () => {
  it("is never-run when there's no history", () => {
    expect(computeHealth("0 5 * * *", NOW, null)).toBe("never-run");
  });

  it("is failing when the last recorded run failed, regardless of schedule timing", () => {
    expect(computeHealth("0 5 * * *", NOW, failureRecord())).toBe("failing");
  });

  it("is healthy when the last run succeeded and the schedule isn't due again yet", () => {
    // last run was today at 05:00 UTC, schedule is daily at 05:00 -> not due again until tomorrow
    expect(computeHealth("0 5 * * *", NOW, successRecord({ timestamp: "2026-08-09T05:00:00Z" }))).toBe(
      "healthy",
    );
  });

  it("is late when the schedule says it should have run again by now", () => {
    // last successful run was two days ago; daily schedule means it's overdue
    expect(computeHealth("0 5 * * *", NOW, successRecord({ timestamp: "2026-08-07T05:00:00Z" }))).toBe(
      "late",
    );
  });
});

describe("buildTargetStatuses", () => {
  it("sorts targets by name and caps recent runs, newest first", () => {
    const manyRuns = Array.from({ length: 15 }, (_, i) =>
      successRecord({ timestamp: `2026-08-0${(i % 9) + 1}T05:00:00Z`, snapshotId: `snap-${i}` }),
    );
    readHistoryMock.mockImplementation((name: string) => (name === "zebra-target" ? manyRuns : []));

    const statuses = buildTargetStatuses(
      [
        { name: "zebra-target", type: "mysql", schedule: "0 5 * * *" } as never,
        { name: "alpha-target", type: "files", schedule: "0 3 * * *" } as never,
      ],
      NOW,
    );

    expect(statuses.map((s) => s.name)).toEqual(["alpha-target", "zebra-target"]);
    const zebra = statuses.find((s) => s.name === "zebra-target")!;
    expect(zebra.recentRuns).toHaveLength(10);
    const [mostRecent] = zebra.recentRuns;
    expect(mostRecent?.status).toBe("success");
    expect(mostRecent?.status === "success" && mostRecent.snapshotId).toBe("snap-14"); // most recent first
    expect(zebra.lastRun?.status === "success" && zebra.lastRun.snapshotId).toBe("snap-14");
  });

  it("reports never-run for a target with no history at all", () => {
    readHistoryMock.mockReturnValue([]);
    const [status] = buildTargetStatuses([{ name: "fresh-target", type: "postgres", schedule: "0 6 * * *" } as never], NOW);
    expect(status?.health).toBe("never-run");
    expect(status?.lastRun).toBeNull();
  });
});

describe("renderSiteHtml", () => {
  it("renders each target's name, health badge, and last result", () => {
    const html = renderSiteHtml(
      [
        {
          name: "wanda-mysql",
          type: "mysql",
          schedule: "0 5 * * *",
          health: "healthy",
          lastRun: successRecord(),
          recentRuns: [successRecord()],
        },
        {
          name: "wanda-postgres",
          type: "postgres",
          schedule: "0 6 * * *",
          health: "failing",
          lastRun: failureRecord(),
          recentRuns: [failureRecord()],
        },
      ],
      NOW,
    );

    expect(html).toContain("wanda-mysql");
    expect(html).toContain("healthy");
    expect(html).toContain("wanda-postgres");
    expect(html).toContain("failing");
    expect(html).toContain("Access denied for user");
  });

  it("escapes error messages so they can't inject markup into the page", () => {
    const html = renderSiteHtml(
      [
        {
          name: "target",
          type: "mysql",
          schedule: "0 5 * * *",
          health: "failing",
          lastRun: failureRecord({ error: "<script>alert(1)</script>" }),
          recentRuns: [failureRecord({ error: "<script>alert(1)</script>" })],
        },
      ],
      NOW,
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders a friendly message when there are no targets", () => {
    expect(renderSiteHtml([], NOW)).toContain("No targets configured");
  });
});
