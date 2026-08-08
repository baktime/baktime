import { CronExpressionParser } from "cron-parser";

/**
 * All schedules are evaluated in UTC — the same timezone GitHub Actions
 * runners and Cloudflare Workers both run in — so a `schedule` string means
 * the same instant regardless of where it's evaluated (the Worker deciding
 * whether to dispatch, or the Actions job double-checking before it runs).
 */
const SCHEDULE_TZ = "UTC";

/**
 * The most recent time `schedule` was/is scheduled to fire, at or before
 * `asOf`. `CronExpressionParser`'s `.prev()` is exclusive of the exact
 * `currentDate` instant, so we nudge the query 1s into the future to treat
 * an exact-boundary match (asOf landing precisely on a scheduled tick) as
 * "already due", not "due next time".
 */
export function mostRecentOccurrence(schedule: string, asOf: Date): Date {
  const cron = CronExpressionParser.parse(schedule, {
    currentDate: new Date(asOf.getTime() + 1000),
    tz: SCHEDULE_TZ,
  });
  return cron.prev().toDate();
}

/**
 * A target is due if its schedule's most recent occurrence is more recent
 * than its last recorded run. Only the single most recent occurrence is
 * considered — after an outage that missed several ticks, this catches up
 * with one run, not one run per missed tick.
 */
export function isDue(schedule: string, now: Date, lastRunAt: Date | null): boolean {
  const due = mostRecentOccurrence(schedule, now);
  if (due.getTime() > now.getTime()) {
    return false; // defensive: shouldn't happen given the +1s nudge above
  }
  if (lastRunAt === null) {
    return true;
  }
  return due.getTime() > lastRunAt.getTime();
}
