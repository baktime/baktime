import type { HistoryRecord } from "../history/types.js";
import type { WeeklySummaryEvent } from "../summary/weekly.js";

/** Identical shape to the history record a run just produced — no separate event type needed. */
export type BackupNotificationEvent = HistoryRecord;
export type NotificationEvent = BackupNotificationEvent | WeeklySummaryEvent;

export interface NotificationChannel {
  /** Short identifier used only in baktime's own log lines when a channel fails to send. */
  name: string;
  send(event: NotificationEvent): Promise<void>;
}

export function isWeeklySummaryEvent(event: NotificationEvent): event is WeeklySummaryEvent {
  return "kind" in event && event.kind === "weekly-summary";
}
