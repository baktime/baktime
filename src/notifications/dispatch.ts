import { registerSecretValue, type SecretsStore } from "../config/secrets.js";
import { createDiscordChannel } from "./discord.js";
import { createSlackChannel } from "./slack.js";
import { createTelegramChannel } from "./telegram.js";
import { createWebhookChannel } from "./webhook.js";
import type { NotificationChannel, NotificationEvent } from "./types.js";

/**
 * Mirrors upptime's own notification config convention exactly: a provider
 * is enabled via a `NOTIFICATION_<PROVIDER>` secret set to `"true"`, and
 * configured via `NOTIFICATION_<PROVIDER>_<SETTING>` secrets — never in
 * .baktimerc.yml. Adding a provider here is additive: read its own
 * `NOTIFICATION_<PROVIDER>*` secrets and push a channel, nothing else
 * changes. See docs/secrets.md.
 */
function isEnabled(value: string | undefined): boolean {
  return value === "true" || value === "1";
}

/**
 * Returns the provider's settings when it is enabled and every required
 * setting is present. An enabled provider with missing settings logs a
 * warning and is skipped — it must never fail the backup itself.
 */
function readProviderSettings<const S extends string>(
  secrets: SecretsStore,
  provider: string,
  label: string,
  settings: readonly S[],
): Record<S, string> | undefined {
  const flag = `NOTIFICATION_${provider}`;
  if (!isEnabled(secrets.peek(flag))) return undefined;

  const missing = settings
    .map((setting) => `${flag}_${setting}`)
    .filter((name) => !secrets.peek(name)?.trim());
  if (missing.length > 0) {
    console.error(
      `${flag} is enabled but ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not set — skipping ${label} notifications.`,
    );
    return undefined;
  }

  const values = settings.map((setting) => {
    const value = secrets.resolve(`${flag}_${setting}`).trim();
    // resolve() registered the raw value; pasted secrets often carry a trailing newline.
    registerSecretValue(value);
    return [setting, value] as const;
  });
  return Object.fromEntries(values) as Record<S, string>;
}

export function discoverNotificationChannels(secrets: SecretsStore): NotificationChannel[] {
  const channels: NotificationChannel[] = [];

  const discord = readProviderSettings(secrets, "DISCORD", "Discord", ["WEBHOOK_URL"]);
  if (discord) {
    channels.push(createDiscordChannel({ webhookUrl: discord.WEBHOOK_URL }));
  }

  const slack = readProviderSettings(secrets, "SLACK", "Slack", ["WEBHOOK_URL"]);
  if (slack) {
    channels.push(createSlackChannel({ webhookUrl: slack.WEBHOOK_URL }));
  }

  const telegram = readProviderSettings(secrets, "TELEGRAM", "Telegram", ["BOT_TOKEN", "CHAT_ID"]);
  if (telegram) {
    channels.push(createTelegramChannel({ botToken: telegram.BOT_TOKEN, chatId: telegram.CHAT_ID }));
  }

  const webhook = readProviderSettings(secrets, "WEBHOOK", "generic webhook", ["URL"]);
  if (webhook) {
    channels.push(createWebhookChannel({ url: webhook.URL }));
  }

  return channels;
}

/**
 * Sends to every configured channel independently — one channel failing
 * (e.g. Discord webhook temporarily down) never affects another, and never
 * throws back into the caller: a notification failure must not be mistaken
 * for (or mask) the backup's own success/failure, which is already recorded
 * in history by the time this runs.
 */
export async function notifyAll(
  channels: readonly NotificationChannel[],
  event: NotificationEvent,
): Promise<void> {
  const results = await Promise.allSettled(channels.map((channel) => channel.send(event)));
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      console.error(`Notification channel "${channels[index]?.name}" failed:`, result.reason);
    }
  }
}
