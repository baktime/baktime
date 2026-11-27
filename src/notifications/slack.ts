import { buildNotificationMessage, chunkLines, postJson, type Markup, type MessageLevel } from "./message.js";
import type { NotificationChannel, NotificationEvent } from "./types.js";

const LEVEL_COLOR: Record<MessageLevel, string> = {
  success: "#2ecc71",
  warning: "#f1c40f",
  failure: "#e74c3c",
};

const SLACK_SECTION_TEXT_LIMIT = 3000;
const SLACK_FIELD_TEXT_LIMIT = 2000;
const SLACK_MAX_FIELDS = 10;
/** Slack allows 50 blocks per message; leave room for the title, fields, overflow note and footer. */
const SLACK_MAX_LINE_SECTIONS = 45;

/** Slack mrkdwn only requires `&`, `<` and `>` to be escaped. */
export function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const slackMarkup: Markup = {
  escape: escapeSlack,
  bold: (text) => `*${escapeSlack(text)}*`,
};

function mrkdwn(text: string): { type: "mrkdwn"; text: string } {
  return { type: "mrkdwn", text };
}

/**
 * A Slack incoming-webhook message: a color-coded attachment holding Block
 * Kit sections, the closest Slack equivalent of Discord's embeds. Pure, so
 * the formatting is unit-testable without a network mock.
 */
export function buildSlackPayload(event: NotificationEvent): Record<string, unknown> {
  const message = buildNotificationMessage(event, slackMarkup);
  const blocks: Record<string, unknown>[] = [
    { type: "section", text: mrkdwn(slackMarkup.bold(message.title)) },
  ];

  if (message.fields.length > 0) {
    blocks.push({
      type: "section",
      fields: message.fields.slice(0, SLACK_MAX_FIELDS).map((field) =>
        mrkdwn(`${slackMarkup.bold(field.name)}\n${field.value}`.slice(0, SLACK_FIELD_TEXT_LIMIT)),
      ),
    });
  }

  const lineChunks = chunkLines(message.lines, SLACK_SECTION_TEXT_LIMIT);
  for (const chunk of lineChunks.slice(0, SLACK_MAX_LINE_SECTIONS)) {
    blocks.push({ type: "section", text: mrkdwn(chunk) });
  }
  if (lineChunks.length > SLACK_MAX_LINE_SECTIONS) {
    blocks.push({
      type: "section",
      text: mrkdwn("_Additional lines were omitted because this message exceeds Slack's 50-block limit._"),
    });
  }

  const unixSeconds = Math.floor(new Date(message.timestamp).getTime() / 1000);
  const when = Number.isFinite(unixSeconds)
    ? ` · <!date^${unixSeconds}^{date_short_pretty} {time}|${escapeSlack(message.timestamp)}>`
    : "";
  blocks.push({ type: "context", elements: [mrkdwn(`${escapeSlack(message.footer)}${when}`)] });

  return {
    // Shown in push notifications and clients that can't render blocks.
    text: escapeSlack(message.title),
    attachments: [{ color: LEVEL_COLOR[message.level], blocks }],
  };
}

export interface SlackChannelOptions {
  webhookUrl: string;
  /** Injectable for tests; defaults to the global fetch (Node 20+). */
  fetchImpl?: typeof fetch;
}

export function createSlackChannel(options: SlackChannelOptions): NotificationChannel {
  const doFetch = options.fetchImpl ?? fetch;
  return {
    name: "slack",
    async send(event: NotificationEvent): Promise<void> {
      await postJson(doFetch, options.webhookUrl, buildSlackPayload(event), "Slack webhook");
    },
  };
}
