import { afterEach, describe, expect, it, vi } from "vitest";

const createDiscordChannelMock = vi.fn();
vi.mock("../../src/notifications/discord.js", () => ({
  createDiscordChannel: (...args: unknown[]) => createDiscordChannelMock(...args),
}));
const createSlackChannelMock = vi.fn();
vi.mock("../../src/notifications/slack.js", () => ({
  createSlackChannel: (...args: unknown[]) => createSlackChannelMock(...args),
}));
const createTelegramChannelMock = vi.fn();
vi.mock("../../src/notifications/telegram.js", () => ({
  createTelegramChannel: (...args: unknown[]) => createTelegramChannelMock(...args),
}));
const createWebhookChannelMock = vi.fn();
vi.mock("../../src/notifications/webhook.js", () => ({
  createWebhookChannel: (...args: unknown[]) => createWebhookChannelMock(...args),
}));

const { discoverNotificationChannels, notifyAll } = await import("../../src/notifications/dispatch.js");
const { SecretsStore } = await import("../../src/config/secrets.js");

const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

afterEach(() => {
  createDiscordChannelMock.mockReset();
  createSlackChannelMock.mockReset();
  createTelegramChannelMock.mockReset();
  createWebhookChannelMock.mockReset();
  consoleErrorSpy.mockClear();
});

describe("discoverNotificationChannels", () => {
  it("returns no channels when nothing is configured", () => {
    const secrets = SecretsStore.fromRecord({});
    expect(discoverNotificationChannels(secrets)).toEqual([]);
    expect(createDiscordChannelMock).not.toHaveBeenCalled();
  });

  it("enables Discord when NOTIFICATION_DISCORD=true and a webhook URL is set", () => {
    const fakeChannel = { name: "discord", send: vi.fn() };
    createDiscordChannelMock.mockReturnValue(fakeChannel);

    const secrets = SecretsStore.fromRecord({
      NOTIFICATION_DISCORD: "true",
      NOTIFICATION_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/a",
    });

    const channels = discoverNotificationChannels(secrets);

    expect(channels).toEqual([fakeChannel]);
    expect(createDiscordChannelMock).toHaveBeenCalledWith({
      webhookUrl: "https://discord.com/api/webhooks/1/a",
    });
  });

  it("does not enable Discord when the flag is missing, even if a webhook URL happens to be set", () => {
    const secrets = SecretsStore.fromRecord({
      NOTIFICATION_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/a",
    });
    expect(discoverNotificationChannels(secrets)).toEqual([]);
  });

  it("does not enable Discord when the flag is set to something other than true/1", () => {
    const secrets = SecretsStore.fromRecord({
      NOTIFICATION_DISCORD: "false",
      NOTIFICATION_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/a",
    });
    expect(discoverNotificationChannels(secrets)).toEqual([]);
  });

  it("logs a clear error and skips Discord when enabled but the webhook URL is missing", () => {
    const secrets = SecretsStore.fromRecord({ NOTIFICATION_DISCORD: "true" });

    const channels = discoverNotificationChannels(secrets);

    expect(channels).toEqual([]);
    expect(createDiscordChannelMock).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("NOTIFICATION_DISCORD_WEBHOOK_URL"));
  });

  it('also accepts "1" as a truthy enable flag', () => {
    const fakeChannel = { name: "discord", send: vi.fn() };
    createDiscordChannelMock.mockReturnValue(fakeChannel);
    const secrets = SecretsStore.fromRecord({
      NOTIFICATION_DISCORD: "1",
      NOTIFICATION_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/a",
    });
    expect(discoverNotificationChannels(secrets)).toEqual([fakeChannel]);
  });
});

describe("discoverNotificationChannels — Slack, Telegram and generic webhook", () => {
  it("enables Slack with its webhook URL", () => {
    const fakeChannel = { name: "slack", send: vi.fn() };
    createSlackChannelMock.mockReturnValue(fakeChannel);
    const secrets = SecretsStore.fromRecord({
      NOTIFICATION_SLACK: "true",
      NOTIFICATION_SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T/B/x",
    });

    expect(discoverNotificationChannels(secrets)).toEqual([fakeChannel]);
    expect(createSlackChannelMock).toHaveBeenCalledWith({ webhookUrl: "https://hooks.slack.com/services/T/B/x" });
  });

  it("enables Telegram with its bot token and chat id, trimming pasted whitespace", () => {
    const fakeChannel = { name: "telegram", send: vi.fn() };
    createTelegramChannelMock.mockReturnValue(fakeChannel);
    const secrets = SecretsStore.fromRecord({
      NOTIFICATION_TELEGRAM: "1",
      NOTIFICATION_TELEGRAM_BOT_TOKEN: "123:abc\n",
      NOTIFICATION_TELEGRAM_CHAT_ID: " -1001234 ",
    });

    expect(discoverNotificationChannels(secrets)).toEqual([fakeChannel]);
    expect(createTelegramChannelMock).toHaveBeenCalledWith({ botToken: "123:abc", chatId: "-1001234" });
  });

  it("enables the generic webhook with its URL", () => {
    const fakeChannel = { name: "webhook", send: vi.fn() };
    createWebhookChannelMock.mockReturnValue(fakeChannel);
    const secrets = SecretsStore.fromRecord({
      NOTIFICATION_WEBHOOK: "true",
      NOTIFICATION_WEBHOOK_URL: "https://example.test/hook",
    });

    expect(discoverNotificationChannels(secrets)).toEqual([fakeChannel]);
    expect(createWebhookChannelMock).toHaveBeenCalledWith({ url: "https://example.test/hook" });
  });

  it("enables every configured provider side by side", () => {
    createDiscordChannelMock.mockReturnValue({ name: "discord", send: vi.fn() });
    createSlackChannelMock.mockReturnValue({ name: "slack", send: vi.fn() });
    createTelegramChannelMock.mockReturnValue({ name: "telegram", send: vi.fn() });
    createWebhookChannelMock.mockReturnValue({ name: "webhook", send: vi.fn() });
    const secrets = SecretsStore.fromRecord({
      NOTIFICATION_DISCORD: "true",
      NOTIFICATION_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/a",
      NOTIFICATION_SLACK: "true",
      NOTIFICATION_SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T/B/x",
      NOTIFICATION_TELEGRAM: "true",
      NOTIFICATION_TELEGRAM_BOT_TOKEN: "123:abc",
      NOTIFICATION_TELEGRAM_CHAT_ID: "42",
      NOTIFICATION_WEBHOOK: "true",
      NOTIFICATION_WEBHOOK_URL: "https://example.test/hook",
    });

    expect(discoverNotificationChannels(secrets).map((channel) => channel.name)).toEqual([
      "discord",
      "slack",
      "telegram",
      "webhook",
    ]);
  });

  it.each([
    ["Slack", { NOTIFICATION_SLACK: "true" }, "NOTIFICATION_SLACK_WEBHOOK_URL"],
    ["Slack (blank URL)", { NOTIFICATION_SLACK: "true", NOTIFICATION_SLACK_WEBHOOK_URL: "  " }, "NOTIFICATION_SLACK_WEBHOOK_URL"],
    ["Telegram", { NOTIFICATION_TELEGRAM: "true", NOTIFICATION_TELEGRAM_BOT_TOKEN: "123:abc" }, "NOTIFICATION_TELEGRAM_CHAT_ID"],
    ["the generic webhook", { NOTIFICATION_WEBHOOK: "true" }, "NOTIFICATION_WEBHOOK_URL"],
  ])("logs a warning and skips %s when a required setting is missing", (_label, record, missingSecret) => {
    const channels = discoverNotificationChannels(SecretsStore.fromRecord(record));

    expect(channels).toEqual([]);
    expect(createSlackChannelMock).not.toHaveBeenCalled();
    expect(createTelegramChannelMock).not.toHaveBeenCalled();
    expect(createWebhookChannelMock).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining(missingSecret));
  });

  it("names every missing Telegram setting in one warning", () => {
    discoverNotificationChannels(SecretsStore.fromRecord({ NOTIFICATION_TELEGRAM: "true" }));

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "NOTIFICATION_TELEGRAM is enabled but NOTIFICATION_TELEGRAM_BOT_TOKEN and NOTIFICATION_TELEGRAM_CHAT_ID are not set — skipping Telegram notifications.",
    );
  });

  it("a misconfigured provider does not stop the others from being enabled", () => {
    createSlackChannelMock.mockReturnValue({ name: "slack", send: vi.fn() });
    const secrets = SecretsStore.fromRecord({
      NOTIFICATION_TELEGRAM: "true",
      NOTIFICATION_SLACK: "true",
      NOTIFICATION_SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T/B/x",
    });

    expect(discoverNotificationChannels(secrets).map((channel) => channel.name)).toEqual(["slack"]);
  });
});

const sampleEvent = {
  timestamp: "2026-08-08T00:00:00.000Z",
  target: "x",
  type: "files" as const,
  durationMs: 1,
  status: "success" as const,
  snapshotId: "s",
  bytesAdded: 1,
};

describe("notifyAll", () => {
  it("sends the event to every channel", async () => {
    const a = { name: "a", send: vi.fn().mockResolvedValue(undefined) };
    const b = { name: "b", send: vi.fn().mockResolvedValue(undefined) };

    await notifyAll([a, b], sampleEvent);

    expect(a.send).toHaveBeenCalledWith(sampleEvent);
    expect(b.send).toHaveBeenCalledWith(sampleEvent);
  });

  it("does not throw, and logs, when one channel fails", async () => {
    const failing = { name: "discord", send: vi.fn().mockRejectedValue(new Error("HTTP 500")) };

    await expect(notifyAll([failing], sampleEvent)).resolves.toBeUndefined();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"discord"'),
      expect.any(Error),
    );
  });

  it("one channel failing does not prevent another from being called", async () => {
    const failing = { name: "discord", send: vi.fn().mockRejectedValue(new Error("boom")) };
    const succeeding = { name: "other", send: vi.fn().mockResolvedValue(undefined) };

    await notifyAll([failing, succeeding], sampleEvent);

    expect(succeeding.send).toHaveBeenCalledWith(sampleEvent);
  });

  it("resolves immediately with no channels configured", async () => {
    await expect(notifyAll([], sampleEvent)).resolves.toBeUndefined();
  });
});
