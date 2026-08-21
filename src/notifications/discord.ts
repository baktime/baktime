import type { WeeklyTargetSummary } from "../summary/weekly.js";
import {
  isWeeklySummaryEvent,
  type BackupNotificationEvent,
  type NotificationChannel,
  type NotificationEvent,
} from "./types.js";

const COLOR_SUCCESS = 0x2ecc71; // green
const COLOR_FAILURE = 0xe74c3c; // red
const COLOR_WARNING = 0xf1c40f; // yellow

const DISCORD_FIELD_VALUE_LIMIT = 1000; // Discord's embed field value limit is 1024; leave headroom for the ellipsis.
const DISCORD_FIRST_TARGET_FIELDS = 4;
const DISCORD_CONTINUATION_TARGET_FIELDS = 5;
const DISCORD_MAX_EMBEDS = 10;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/**
 * A Discord "embed" — richer than a plain message (color-coded, structured
 * fields) but still just a JSON payload to a webhook URL, no bot/OAuth
 * setup required. Exported separately from the send call so the formatting
 * itself is pure and unit-testable without a network mock.
 */
export function buildDiscordPayload(event: BackupNotificationEvent): Record<string, unknown> {
  const isSuccess = event.status === "success";
  const fields: { name: string; value: string; inline: boolean }[] = [
    { name: "Type", value: event.type, inline: true },
    { name: "Duration", value: formatDuration(event.durationMs), inline: true },
  ];

  if (event.status === "success") {
    fields.push({ name: "Snapshot", value: event.snapshotId, inline: true });
    fields.push({ name: "Data added", value: formatBytes(event.bytesAdded), inline: true });
  } else {
    fields.push({
      name: "Error",
      value: truncate(event.error, DISCORD_FIELD_VALUE_LIMIT),
      inline: false,
    });
  }

  return {
    embeds: [
      {
        title: isSuccess ? `✅ Backup succeeded: ${event.target}` : `❌ Backup failed: ${event.target}`,
        color: isSuccess ? COLOR_SUCCESS : COLOR_FAILURE,
        fields,
        timestamp: event.timestamp,
        footer: { text: "baktime" },
      },
    ],
  };
}

const HEALTH_ICON: Record<WeeklyTargetSummary["health"], string> = {
  healthy: "✅",
  late: "⚠️",
  failing: "❌",
  "never-run": "⏺️",
};

function chunkTargetLines(targets: readonly WeeklyTargetSummary[]): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const target of targets) {
    const lastRun = target.lastRunAt ? target.lastRunAt.slice(0, 10) : "never";
    const line = `${HEALTH_ICON[target.health]} **${target.name}** (${target.type}) — last: ${lastRun}; backups: ${target.successfulBackups}; week: ${target.successesThisWeek}✅/${target.failuresThisWeek}❌`;
    if (current && current.length + line.length + 1 > DISCORD_FIELD_VALUE_LIMIT) {
      chunks.push(current);
      current = "";
    }
    current += `${current ? "\n" : ""}${truncate(line, DISCORD_FIELD_VALUE_LIMIT)}`;
  }
  if (current) chunks.push(current);
  return chunks;
}

export function buildWeeklyDiscordPayload(
  event: Extract<NotificationEvent, { kind: "weekly-summary" }>,
): Record<string, unknown> {
  const { totals, repository } = event;
  const hasFailure = totals.failing > 0;
  const hasWarning =
    totals.late > 0 || totals.neverRun > 0 || totals.targets === 0 || repository.unavailable > 0;
  const color = hasFailure ? COLOR_FAILURE : hasWarning ? COLOR_WARNING : COLOR_SUCCESS;
  const state = [
    `${totals.healthy} healthy`,
    `${totals.late} late`,
    `${totals.failing} failing`,
    `${totals.neverRun} never run`,
  ].join(" · ");
  const repositoryNote =
    repository.unavailable > 0
      ? ` · ${repository.unavailable} repositor${repository.unavailable === 1 ? "y" : "ies"} unavailable`
      : "";
  const fields: { name: string; value: string; inline: boolean }[] = [
    { name: "Backup state", value: state, inline: false },
    {
      name: "Repository storage",
      value:
        repository.checked > 0
          ? `${formatBytes(repository.storageBytes)} raw data · ${repository.snapshots} snapshots · ${repository.files} files${repositoryNote}`
          : `Unavailable${repositoryNote}`,
      inline: false,
    },
    {
      name: "Last 7 days",
      value: `${totals.successesThisWeek} succeeded · ${totals.failuresThisWeek} failed`,
      inline: true,
    },
    {
      name: "Recorded backups",
      value: String(totals.successfulBackups),
      inline: true,
    },
  ];

  const targetChunks = chunkTargetLines(event.targets);
  function appendTargetFields(
    destination: { name: string; value: string; inline: boolean }[],
    chunks: readonly string[],
    offset: number,
  ): void {
    for (const [index, chunk] of chunks.entries()) {
      const chunkNumber = offset + index;
      destination.push({
        name: chunkNumber === 0 ? "All targets" : `All targets (${chunkNumber + 1})`,
        value: chunk,
        inline: false,
      });
    }
  }
  appendTargetFields(fields, targetChunks.slice(0, DISCORD_FIRST_TARGET_FIELDS), 0);

  const embeds: Record<string, unknown>[] = [
    {
      title: hasFailure
        ? "❌ Weekly backup report needs attention"
        : hasWarning
          ? "⚠️ Weekly backup report"
          : "✅ Weekly backup report: all healthy",
      color,
      fields,
      timestamp: event.generatedAt,
      footer: { text: "baktime · repository storage uses restic raw-data statistics" },
    },
  ];

  let nextChunk = DISCORD_FIRST_TARGET_FIELDS;
  while (nextChunk < targetChunks.length && embeds.length < DISCORD_MAX_EMBEDS) {
    const continuationFields: { name: string; value: string; inline: boolean }[] = [];
    appendTargetFields(
      continuationFields,
      targetChunks.slice(nextChunk, nextChunk + DISCORD_CONTINUATION_TARGET_FIELDS),
      nextChunk,
    );
    embeds.push({ title: "Backup targets (continued)", color, fields: continuationFields });
    nextChunk += DISCORD_CONTINUATION_TARGET_FIELDS;
  }
  if (nextChunk < targetChunks.length) {
    const lastEmbed = embeds.at(-1);
    if (lastEmbed) {
      lastEmbed.description =
        "Additional targets were omitted because this instance exceeds Discord's 10-embed message limit.";
    }
  }

  return { embeds };
}

export function buildNotificationDiscordPayload(event: NotificationEvent): Record<string, unknown> {
  return isWeeklySummaryEvent(event) ? buildWeeklyDiscordPayload(event) : buildDiscordPayload(event);
}

export interface DiscordChannelOptions {
  webhookUrl: string;
  /** Injectable for tests; defaults to the global fetch (Node 20+). */
  fetchImpl?: typeof fetch;
}

export function createDiscordChannel(options: DiscordChannelOptions): NotificationChannel {
  const doFetch = options.fetchImpl ?? fetch;
  return {
    name: "discord",
    async send(event: NotificationEvent): Promise<void> {
      const response = await doFetch(options.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildNotificationDiscordPayload(event)),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `Discord webhook responded with HTTP ${response.status}${body ? `: ${body}` : ""}`,
        );
      }
    },
  };
}
