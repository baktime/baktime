import { buildNotificationMessage, chunkLines, postJson, type Markup } from "./message.js";
import type { NotificationChannel, NotificationEvent } from "./types.js";

/** Telegram rejects messages over 4096 characters; longer reports are split across messages. */
const TELEGRAM_MESSAGE_LIMIT = 4096;

/** Telegram's HTML parse mode only requires `&`, `<` and `>` to be escaped. */
export function escapeTelegramHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const telegramMarkup: Markup = {
  escape: escapeTelegramHtml,
  bold: (text) => `<b>${escapeTelegramHtml(text)}</b>`,
};

/**
 * The HTML-formatted text of the message(s) for one event — normally one,
 * more only when a large weekly or retention report exceeds Telegram's
 * per-message limit. Split on line boundaries so no HTML tag is ever cut.
 */
export function buildTelegramMessages(event: NotificationEvent): string[] {
  const message = buildNotificationMessage(event, telegramMarkup);
  const lines = [telegramMarkup.bold(message.title)];
  if (message.fields.length > 0) {
    lines.push("", ...message.fields.map((field) => `${telegramMarkup.bold(`${field.name}:`)} ${field.value}`));
  }
  if (message.lines.length > 0) {
    lines.push("", ...message.lines);
  }
  lines.push("", `<i>${escapeTelegramHtml(message.footer)}</i>`);
  return chunkLines(lines, TELEGRAM_MESSAGE_LIMIT);
}

export interface TelegramChannelOptions {
  botToken: string;
  chatId: string;
  /** Injectable for tests; defaults to the global fetch (Node 20+). */
  fetchImpl?: typeof fetch;
}

export function createTelegramChannel(options: TelegramChannelOptions): NotificationChannel {
  const doFetch = options.fetchImpl ?? fetch;
  // The token is part of the URL, so it is never included in error messages.
  const url = `https://api.telegram.org/bot${options.botToken}/sendMessage`;
  return {
    name: "telegram",
    async send(event: NotificationEvent): Promise<void> {
      for (const text of buildTelegramMessages(event)) {
        await postJson(
          doFetch,
          url,
          { chat_id: options.chatId, text, parse_mode: "HTML", disable_web_page_preview: true },
          "Telegram Bot API",
        );
      }
    },
  };
}
