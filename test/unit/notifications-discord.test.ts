import { describe, expect, it, vi } from "vitest";
import {
  buildDiscordPayload,
  createDiscordChannel,
  formatBytes,
  formatDuration,
} from "../../src/notifications/discord.js";
import type { HistoryRecord } from "../../src/history/types.js";

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [500, "500 B"],
    [1536, "1.5 KB"],
    [1048576, "1.0 MB"],
    [1073741824, "1.0 GB"],
  ])("formats %i as %s", (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});

describe("formatDuration", () => {
  it.each([
    [4200, "4s"],
    [65000, "1m 5s"],
    [0, "0s"],
    [3_600_000, "60m 0s"],
  ])("formats %ims as %s", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});

const successEvent: HistoryRecord = {
  timestamp: "2026-08-08T03:00:00.000Z",
  target: "webserver1",
  type: "files",
  durationMs: 4200,
  status: "success",
  snapshotId: "abc123",
  bytesAdded: 1536,
  verification: "sha256",
};

const failureEvent: HistoryRecord = {
  timestamp: "2026-08-08T03:00:00.000Z",
  target: "webserver1",
  type: "files",
  durationMs: 1000,
  status: "failure",
  error: "ssh: connection refused",
};

describe("buildDiscordPayload", () => {
  it("builds a green embed with snapshot/size fields for a success event", () => {
    const payload = buildDiscordPayload(successEvent) as { embeds: Record<string, unknown>[] };
    const embed = payload.embeds[0]!;
    expect(embed.title).toContain("✅");
    expect(embed.title).toContain("webserver1");
    expect(embed.color).toBe(0x2ecc71);
    expect(embed.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Snapshot", value: "abc123" }),
        expect.objectContaining({ name: "Data added", value: "1.5 KB" }),
      ]),
    );
  });

  it("builds a red embed with the error message for a failure event", () => {
    const payload = buildDiscordPayload(failureEvent) as { embeds: Record<string, unknown>[] };
    const embed = payload.embeds[0]!;
    expect(embed.title).toContain("❌");
    expect(embed.color).toBe(0xe74c3c);
    expect(embed.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Error", value: "ssh: connection refused" }),
      ]),
    );
  });

  it("truncates an excessively long error message to fit Discord's field value limit", () => {
    const longError = "x".repeat(2000);
    const payload = buildDiscordPayload({ ...failureEvent, error: longError }) as {
      embeds: { fields: { name: string; value: string }[] }[];
    };
    const errorField = payload.embeds[0]!.fields.find((f) => f.name === "Error")!;
    expect(errorField.value.length).toBeLessThanOrEqual(1000);
    expect(errorField.value.endsWith("…")).toBe(true);
  });
});

describe("createDiscordChannel", () => {
  it("POSTs the built payload as JSON to the webhook URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204, text: () => Promise.resolve("") });
    const channel = createDiscordChannel({
      webhookUrl: "https://discord.com/api/webhooks/123/abc",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await channel.send(successEvent);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://discord.com/api/webhooks/123/abc");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual(buildDiscordPayload(successEvent));
  });

  it("throws a clear error when Discord responds with a non-2xx status", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 401, text: () => Promise.resolve("Unauthorized") });
    const channel = createDiscordChannel({
      webhookUrl: "https://discord.com/api/webhooks/bad/token",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(channel.send(successEvent)).rejects.toThrow(/401/);
  });
});
