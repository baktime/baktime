import { describe, expect, it, vi } from "vitest";
import {
  buildDiscordPayload,
  buildWeeklyDiscordPayload,
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

describe("buildWeeklyDiscordPayload", () => {
  it("renders repository totals, weekly outcomes, and every target state", () => {
    const payload = buildWeeklyDiscordPayload({
      kind: "weekly-summary",
      generatedAt: "2026-08-21T08:17:00.000Z",
      periodStart: "2026-08-14T08:17:00.000Z",
      repository: {
        storageBytes: 1_073_741_824,
        snapshots: 12,
        files: 345,
        checked: 1,
        unavailable: 0,
      },
      totals: {
        targets: 2,
        healthy: 1,
        late: 0,
        failing: 1,
        neverRun: 0,
        successfulBackups: 12,
        successesThisWeek: 5,
        failuresThisWeek: 1,
      },
      targets: [
        {
          name: "database",
          type: "postgres",
          schedule: "0 5 * * *",
          health: "healthy",
          lastRunAt: "2026-08-21T05:00:00.000Z",
          lastRunStatus: "success",
          successfulBackups: 7,
          successesThisWeek: 3,
          failuresThisWeek: 0,
        },
        {
          name: "files",
          type: "files",
          schedule: "0 3 * * *",
          health: "failing",
          lastRunAt: "2026-08-21T03:00:00.000Z",
          lastRunStatus: "failure",
          successfulBackups: 5,
          successesThisWeek: 2,
          failuresThisWeek: 1,
        },
      ],
    }) as { embeds: { title: string; color: number; fields: { name: string; value: string }[] }[] };

    const embed = payload.embeds[0]!;
    expect(embed.title).toContain("needs attention");
    expect(embed.color).toBe(0xe74c3c);
    expect(embed.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Repository storage", value: expect.stringContaining("1.0 GB") }),
        expect.objectContaining({ name: "Last 7 days", value: "5 succeeded · 1 failed" }),
        expect.objectContaining({ name: "All targets", value: expect.stringContaining("database") }),
      ]),
    );
    expect(embed.fields.find((field) => field.name === "All targets")?.value).toContain("files");
  });

  it("splits a large target list across valid-sized continuation embeds", () => {
    const targets = Array.from({ length: 80 }, (_, index) => ({
      name: `target-${String(index).padStart(2, "0")}`,
      type: "files" as const,
      schedule: "0 3 * * *",
      health: "healthy" as const,
      lastRunAt: "2026-08-21T03:00:00.000Z",
      lastRunStatus: "success" as const,
      successfulBackups: 12,
      successesThisWeek: 7,
      failuresThisWeek: 0,
    }));
    const payload = buildWeeklyDiscordPayload({
      kind: "weekly-summary",
      generatedAt: "2026-08-21T08:17:00.000Z",
      periodStart: "2026-08-14T08:17:00.000Z",
      repository: { storageBytes: 1, snapshots: 80, files: 80, checked: 1, unavailable: 0 },
      totals: {
        targets: 80,
        healthy: 80,
        late: 0,
        failing: 0,
        neverRun: 0,
        successfulBackups: 960,
        successesThisWeek: 560,
        failuresThisWeek: 0,
      },
      targets,
    }) as { embeds: { fields: { value: string }[] }[] };

    expect(payload.embeds.length).toBeGreaterThan(1);
    expect(payload.embeds.length).toBeLessThanOrEqual(10);
    for (const embed of payload.embeds) {
      expect(embed.fields.length).toBeGreaterThan(0);
      expect(embed.fields.every((field) => field.value.length <= 1000)).toBe(true);
    }
    expect(JSON.stringify(payload)).toContain("target-79");
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
