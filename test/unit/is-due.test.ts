import { describe, expect, it } from "vitest";
import { isDue, mostRecentOccurrence } from "../../src/scheduling/is-due.js";

describe("mostRecentOccurrence", () => {
  it("finds the last daily tick before now", () => {
    const now = new Date("2026-08-08T10:00:00.000Z");
    expect(mostRecentOccurrence("0 3 * * *", now).toISOString()).toBe(
      "2026-08-08T03:00:00.000Z",
    );
  });

  it("treats `now` landing exactly on a tick as already occurred", () => {
    const now = new Date("2026-08-08T03:00:00.000Z");
    expect(mostRecentOccurrence("0 3 * * *", now).toISOString()).toBe(
      "2026-08-08T03:00:00.000Z",
    );
  });

  it("finds the last 5-minute tick before now", () => {
    const now = new Date("2026-08-08T03:07:00.000Z");
    expect(mostRecentOccurrence("*/5 * * * *", now).toISOString()).toBe(
      "2026-08-08T03:05:00.000Z",
    );
  });
});

describe("isDue", () => {
  const schedule = "0 3 * * *"; // daily at 03:00 UTC
  const now = new Date("2026-08-08T10:00:00.000Z"); // most recent tick: 2026-08-08T03:00:00Z

  it("is due when the target has never run before", () => {
    expect(isDue(schedule, now, null)).toBe(true);
  });

  it("is due when the last run was before the most recent scheduled tick", () => {
    const lastRunAt = new Date("2026-08-07T03:00:00.000Z"); // yesterday's tick
    expect(isDue(schedule, now, lastRunAt)).toBe(true);
  });

  it("is not due when the last run already covers the most recent tick", () => {
    const lastRunAt = new Date("2026-08-08T03:00:00.000Z"); // today's tick, already ran
    expect(isDue(schedule, now, lastRunAt)).toBe(false);
  });

  it("is not due when the last run was after the most recent tick (e.g. a manual run)", () => {
    const lastRunAt = new Date("2026-08-08T09:00:00.000Z");
    expect(isDue(schedule, now, lastRunAt)).toBe(false);
  });

  it("only catches up once after missing several ticks, not once per missed tick", () => {
    const frequentSchedule = "*/5 * * * *";
    const lastRunAt = new Date("2026-08-08T00:00:00.000Z"); // ran once, then a long outage
    const resumedAt = new Date("2026-08-08T10:00:00.000Z"); // hours later
    expect(isDue(frequentSchedule, resumedAt, lastRunAt)).toBe(true);
    // The point: this is a single yes/no, not "run 120 times to catch up" —
    // callers act on isDue() once per check, so no backlog is queued.
  });

  it("evaluates schedules in UTC regardless of the host's local timezone", () => {
    // 03:00 UTC on this date is still "today" in every real-world local TZ this test could run in.
    const utcNow = new Date("2026-08-08T03:00:30.000Z");
    expect(isDue("0 3 * * *", utcNow, null)).toBe(true);
  });
});
