import { describe, expect, it, vi } from "vitest";
import { createWebhookChannel, webhookEventType } from "../../src/notifications/webhook.js";
import { failureEvent, retentionEvent, successEvent, weeklyEvent } from "./notification-fixtures.js";

describe("webhookEventType", () => {
  it.each([
    ["a successful backup", successEvent, "backup"],
    ["a failed backup", failureEvent, "backup"],
    ["a weekly summary", weeklyEvent(), "weekly-summary"],
    ["a retention report", retentionEvent, "retention"],
  ] as const)("classifies %s as %s", (_label, event, expected) => {
    expect(webhookEventType(event)).toBe(expected);
  });
});

describe("createWebhookChannel", () => {
  it.each([
    ["backup", successEvent],
    ["weekly-summary", weeklyEvent()],
    ["retention", retentionEvent],
  ] as const)("POSTs the raw %s event as JSON with an X-Baktime-Event header", async (type, event) => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204, text: () => Promise.resolve("") });
    const channel = createWebhookChannel({
      url: "https://example.test/hooks/baktime",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await channel.send(event);

    expect(channel.name).toBe("webhook");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.test/hooks/baktime");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual(
      expect.objectContaining({ "Content-Type": "application/json", "X-Baktime-Event": type }),
    );
    expect(JSON.parse(init.body as string)).toEqual(event);
  });

  it("throws a clear error when the receiver responds with a non-2xx status", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve("oops") });
    const channel = createWebhookChannel({
      url: "https://example.test/hooks/baktime",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(channel.send(successEvent)).rejects.toThrow(/Notification webhook responded with HTTP 500: oops/);
  });
});
