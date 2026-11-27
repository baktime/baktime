import { formatRetentionPolicy, hasRetentionFailures, type RetentionReport } from "../retention/apply.js";
import type { WeeklySummaryEvent, WeeklyTargetSummary } from "../summary/weekly.js";
import { formatBytes, formatDuration, truncate } from "./format.js";
import {
  isRetentionReportEvent,
  isWeeklySummaryEvent,
  type BackupNotificationEvent,
  type NotificationEvent,
} from "./types.js";

/**
 * How a provider marks up text. Every piece of event data (target names,
 * error messages, ...) goes through `escape` or `bold`, so a target named
 * `<db>` or an error containing `*` can never break a provider's markup.
 */
export interface Markup {
  escape(text: string): string;
  /** Escapes `text` itself, then makes it bold. */
  bold(text: string): string;
}

export type MessageLevel = "success" | "warning" | "failure";

/**
 * A provider-neutral rendering of one notification event — the same
 * content Discord's embeds carry, already marked up for the target
 * provider, so chat providers (Slack, Telegram, ...) only decide layout.
 */
export interface NotificationMessage {
  level: MessageLevel;
  /** Plain text, unescaped — providers escape it for their own markup. */
  title: string;
  /** Short name/value facts. Names are plain text; values are already marked up. */
  fields: { name: string; value: string }[];
  /** Longer per-item lines (targets, retention results), already marked up. */
  lines: string[];
  /** Plain text, unescaped. */
  footer: string;
  timestamp: string;
}

/** Error text is capped before markup so a cut can never land inside a tag. */
const ERROR_TEXT_LIMIT = 1000;

const HEALTH_ICON: Record<WeeklyTargetSummary["health"], string> = {
  healthy: "✅",
  late: "⚠️",
  failing: "❌",
  "never-run": "⏺️",
};

function buildBackupMessage(event: BackupNotificationEvent, markup: Markup): NotificationMessage {
  const fields = [
    { name: "Type", value: markup.escape(event.type) },
    { name: "Duration", value: markup.escape(formatDuration(event.durationMs)) },
  ];
  if (event.status === "success") {
    fields.push({ name: "Snapshot", value: markup.escape(event.snapshotId) });
    fields.push({ name: "Data added", value: markup.escape(formatBytes(event.bytesAdded)) });
  } else {
    fields.push({ name: "Error", value: markup.escape(truncate(event.error, ERROR_TEXT_LIMIT)) });
  }
  return {
    level: event.status === "success" ? "success" : "failure",
    title:
      event.status === "success"
        ? `✅ Backup succeeded: ${event.target}`
        : `❌ Backup failed: ${event.target}`,
    fields,
    lines: [],
    footer: "baktime",
    timestamp: event.timestamp,
  };
}

function buildWeeklyMessage(event: WeeklySummaryEvent, markup: Markup): NotificationMessage {
  const { totals, repository } = event;
  const hasFailure = totals.failing > 0;
  const hasWarning =
    totals.late > 0 || totals.neverRun > 0 || totals.targets === 0 || repository.unavailable > 0;
  const repositoryNote =
    repository.unavailable > 0
      ? ` · ${repository.unavailable} repositor${repository.unavailable === 1 ? "y" : "ies"} unavailable`
      : "";
  const storage =
    repository.checked > 0
      ? `${formatBytes(repository.storageBytes)} raw data · ${repository.snapshots} snapshots${repositoryNote}`
      : `Unavailable${repositoryNote}`;

  return {
    level: hasFailure ? "failure" : hasWarning ? "warning" : "success",
    title: hasFailure
      ? "❌ Weekly backup report needs attention"
      : hasWarning
        ? "⚠️ Weekly backup report"
        : "✅ Weekly backup report: all healthy",
    fields: [
      {
        name: "Backup state",
        value: markup.escape(
          `${totals.healthy} healthy · ${totals.late} late · ${totals.failing} failing · ${totals.neverRun} never run`,
        ),
      },
      { name: "Repository storage", value: markup.escape(storage) },
      {
        name: "Last 7 days",
        value: markup.escape(`${totals.successesThisWeek} succeeded · ${totals.failuresThisWeek} failed`),
      },
      { name: "Recorded backups", value: markup.escape(String(totals.successfulBackups)) },
    ],
    lines: event.targets.map((target) => {
      const lastRun = target.lastRunAt ? target.lastRunAt.slice(0, 10) : "never";
      return `${HEALTH_ICON[target.health]} ${markup.bold(target.name)} ${markup.escape(
        `(${target.type}) — last: ${lastRun}; backups: ${target.successfulBackups}; week: ${target.successesThisWeek}✅/${target.failuresThisWeek}❌`,
      )}`;
    }),
    footer: "baktime · repository storage uses restic raw-data statistics",
    timestamp: event.generatedAt,
  };
}

function buildRetentionMessage(event: RetentionReport, markup: Markup): NotificationMessage {
  const failed = hasRetentionFailures(event);
  const removed = event.targets.reduce((sum, result) => sum + (result.removed ?? 0), 0);
  const lines = [
    ...event.targets.map((result) => {
      const name = markup.bold(result.target);
      if (result.status === "failed") {
        return `❌ ${name} ${markup.escape(`— ${truncate(result.error ?? "failed", ERROR_TEXT_LIMIT)}`)}`;
      }
      if (result.status === "skipped") {
        return `⏺️ ${name} ${markup.escape("— no retention policy, keeping everything")}`;
      }
      return `✅ ${name} ${markup.escape(
        `(${formatRetentionPolicy(result.policy)}) — kept ${result.kept ?? 0}, removed ${result.removed ?? 0}`,
      )}`;
    }),
    ...event.repositories
      .filter((result) => result.status === "failed")
      .map(
        (result) =>
          `❌ ${markup.bold(result.repository)} ${markup.escape(
            `— ${result.failedStep} failed: ${truncate(result.error ?? "", ERROR_TEXT_LIMIT)}`,
          )}`,
      ),
  ];
  return {
    level: failed ? "failure" : "success",
    title: failed
      ? "❌ Backup retention needs attention"
      : `🧹 Backup retention applied: ${removed} snapshot${removed === 1 ? "" : "s"} removed`,
    fields: [],
    lines,
    footer: `baktime${event.dryRun ? " · dry run" : ""}`,
    timestamp: event.generatedAt,
  };
}

export function buildNotificationMessage(event: NotificationEvent, markup: Markup): NotificationMessage {
  if (isWeeklySummaryEvent(event)) return buildWeeklyMessage(event, markup);
  if (isRetentionReportEvent(event)) return buildRetentionMessage(event, markup);
  return buildBackupMessage(event, markup);
}

/** Groups lines into chunks of at most `maxLength` characters (joined by newlines), never splitting a line. */
export function chunkLines(lines: readonly string[], maxLength: number): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    if (current && current.length + line.length + 1 > maxLength) {
      chunks.push(current);
      current = "";
    }
    current += `${current ? "\n" : ""}${line}`;
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Shared by providers that POST JSON and treat any non-2xx response as a failure. */
export async function postJson(
  doFetch: typeof fetch,
  url: string,
  body: unknown,
  providerLabel: string,
  extraHeaders: Record<string, string> = {},
): Promise<void> {
  const response = await doFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`${providerLabel} responded with HTTP ${response.status}${text ? `: ${text}` : ""}`);
  }
}
