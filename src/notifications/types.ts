import type { HistoryRecord } from "../history/types.js";

/** Identical shape to the history record a run just produced — no separate event type needed. */
export type BackupNotificationEvent = HistoryRecord;

export interface NotificationChannel {
  /** Short identifier used only in baktime's own log lines when a channel fails to send. */
  name: string;
  send(event: BackupNotificationEvent): Promise<void>;
}
