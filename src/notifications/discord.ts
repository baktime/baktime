import type { BackupNotificationEvent, NotificationChannel } from "./types.js";

const COLOR_SUCCESS = 0x2ecc71; // green
const COLOR_FAILURE = 0xe74c3c; // red

const DISCORD_FIELD_VALUE_LIMIT = 1000; // Discord's embed field value limit is 1024; leave headroom for the ellipsis.

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

export interface DiscordChannelOptions {
  webhookUrl: string;
  /** Injectable for tests; defaults to the global fetch (Node 20+). */
  fetchImpl?: typeof fetch;
}

export function createDiscordChannel(options: DiscordChannelOptions): NotificationChannel {
  const doFetch = options.fetchImpl ?? fetch;
  return {
    name: "discord",
    async send(event: BackupNotificationEvent): Promise<void> {
      const response = await doFetch(options.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildDiscordPayload(event)),
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
