import { postJson } from "./message.js";
import {
  isRetentionReportEvent,
  isWeeklySummaryEvent,
  type NotificationChannel,
  type NotificationEvent,
} from "./types.js";

export type WebhookEventType = "backup" | "weekly-summary" | "retention";

/**
 * Backup records carry no `kind` field (they are the history record itself),
 * so receivers get the event type in a header rather than having to sniff
 * the body's shape.
 */
export function webhookEventType(event: NotificationEvent): WebhookEventType {
  if (isWeeklySummaryEvent(event)) return "weekly-summary";
  if (isRetentionReportEvent(event)) return "retention";
  return "backup";
}

export interface WebhookChannelOptions {
  url: string;
  /** Injectable for tests; defaults to the global fetch (Node 20+). */
  fetchImpl?: typeof fetch;
}

/**
 * The catch-all provider: POSTs the raw event JSON, unformatted, so anything
 * that accepts a webhook (n8n, Zapier, Home Assistant, a small script, ...)
 * can route or format it however it likes.
 */
export function createWebhookChannel(options: WebhookChannelOptions): NotificationChannel {
  const doFetch = options.fetchImpl ?? fetch;
  return {
    name: "webhook",
    async send(event: NotificationEvent): Promise<void> {
      await postJson(doFetch, options.url, event, "Notification webhook", {
        "User-Agent": "baktime",
        "X-Baktime-Event": webhookEventType(event),
      });
    },
  };
}
