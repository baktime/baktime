import { afterEach, describe, expect, it, vi } from "vitest";

const createDiscordChannelMock = vi.fn();
vi.mock("../../src/notifications/discord.js", () => ({
  createDiscordChannel: (...args: unknown[]) => createDiscordChannelMock(...args),
}));

const { discoverNotificationChannels, notifyAll } = await import("../../src/notifications/dispatch.js");
const { SecretsStore } = await import("../../src/config/secrets.js");

const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

afterEach(() => {
  createDiscordChannelMock.mockReset();
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
