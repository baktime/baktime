import type { SecretsStore } from "../config/secrets.js";
import { createDiscordChannel } from "./discord.js";
import type { BackupNotificationEvent, NotificationChannel } from "./types.js";

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

export function discoverNotificationChannels(secrets: SecretsStore): NotificationChannel[] {
  const channels: NotificationChannel[] = [];

  if (isEnabled(secrets.peek("NOTIFICATION_DISCORD"))) {
    if (secrets.has("NOTIFICATION_DISCORD_WEBHOOK_URL")) {
      channels.push(
        createDiscordChannel({ webhookUrl: secrets.resolve("NOTIFICATION_DISCORD_WEBHOOK_URL") }),
      );
    } else {
      console.error(
        "NOTIFICATION_DISCORD is enabled but NOTIFICATION_DISCORD_WEBHOOK_URL is not set — skipping Discord notifications.",
      );
    }
  }

  // Additional providers (Slack, email, ...) register here the same way — see ROADMAP.md.

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
  event: BackupNotificationEvent,
): Promise<void> {
  const results = await Promise.allSettled(channels.map((channel) => channel.send(event)));
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      console.error(`Notification channel "${channels[index]?.name}" failed:`, result.reason);
    }
  }
}
