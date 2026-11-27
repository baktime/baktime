import { describe, expect, it, vi } from "vitest";
import {
  buildTelegramMessages,
  createTelegramChannel,
  escapeTelegramHtml,
} from "../../src/notifications/telegram.js";
import { failureEvent, retentionEvent, successEvent, weeklyEvent, weeklyTarget } from "./notification-fixtures.js";

describe("escapeTelegramHtml", () => {
  it("escapes the characters Telegram's HTML parse mode reserves", () => {
    expect(escapeTelegramHtml("a & <b> c")).toBe("a &amp; &lt;b&gt; c");
  });
});

describe("buildTelegramMessages", () => {
  it("renders a success event as one HTML message", () => {
    const messages = buildTelegramMessages(successEvent);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("<b>✅ Backup succeeded: webserver1</b>");
    expect(messages[0]).toContain("<b>Snapshot:</b> abc123");
    expect(messages[0]).toContain("<b>Data added:</b> 1.5 KB");
    expect(messages[0]).toContain("<i>baktime</i>");
  });

  it("escapes the error text of a failure event", () => {
    const [message] = buildTelegramMessages(failureEvent);
    expect(message).toContain("<b>❌ Backup failed: webserver1</b>");
    expect(message).toContain("<b>Error:</b> ssh: connection &lt;refused&gt; &amp; reset");
  });

  it("renders a weekly summary with totals and every target", () => {
    const [message] = buildTelegramMessages(
      weeklyEvent([weeklyTarget(), weeklyTarget({ name: "files", type: "files", health: "failing" })]),
    );
    expect(message).toContain("<b>❌ Weekly backup report needs attention</b>");
    expect(message).toContain("<b>Repository storage:</b> 1.0 GB raw data · 12 snapshots");
    expect(message).toContain("✅ <b>database</b> (postgres)");
    expect(message).toContain("❌ <b>files</b> (files)");
  });

  it("splits a report over Telegram's 4096-character limit on line boundaries", () => {
    const targets = Array.from({ length: 200 }, (_, index) => weeklyTarget({ name: `target-${index}` }));
    const messages = buildTelegramMessages(weeklyEvent(targets));
    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) {
      expect(message.length).toBeLessThanOrEqual(4096);
      // Every <b> opened in a chunk is closed in the same chunk.
      expect(message.split("<b>").length).toBe(message.split("</b>").length);
    }
    expect(messages.join("\n")).toContain("target-199");
  });

  it("renders a retention report with each target's outcome", () => {
    const [message] = buildTelegramMessages(retentionEvent);
    expect(message).toContain("<b>❌ Backup retention needs attention</b>");
    expect(message).toContain("✅ <b>db</b> (14 daily) — kept 14, removed 1");
    expect(message).toContain("❌ <b>web</b> — ssh timeout");
    expect(message).toContain("❌ <b>r2</b> — prune failed: lock held");
  });
});

describe("createTelegramChannel", () => {
  it("POSTs each message to the Bot API's sendMessage for the configured chat", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve("{}") });
    const channel = createTelegramChannel({
      botToken: "123:abc",
      chatId: "-1001234",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await channel.send(successEvent);

    expect(channel.name).toBe("telegram");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.telegram.org/bot123:abc/sendMessage");
    expect(JSON.parse(init.body as string)).toEqual({
      chat_id: "-1001234",
      text: buildTelegramMessages(successEvent)[0],
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  });

  it("sends a split report as several messages, in order", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve("{}") });
    const channel = createTelegramChannel({
      botToken: "123:abc",
      chatId: "42",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const event = weeklyEvent(Array.from({ length: 200 }, (_, index) => weeklyTarget({ name: `target-${index}` })));

    await channel.send(event);

    const sent = fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string).text);
    expect(sent).toEqual(buildTelegramMessages(event));
  });

  it("throws an error that names the status but never the bot token", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve('{"ok":false,"description":"Bad Request: chat not found"}'),
    });
    const channel = createTelegramChannel({
      botToken: "123:secret-token",
      chatId: "42",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const error = await channel.send(successEvent).then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toMatch(/Telegram Bot API responded with HTTP 400: .*chat not found/);
    expect(error?.message).not.toContain("secret-token");
  });
});
