import { describe, expect, it, vi } from "vitest";
import { buildSlackPayload, createSlackChannel, escapeSlack } from "../../src/notifications/slack.js";
import { failureEvent, retentionEvent, successEvent, weeklyEvent, weeklyTarget } from "./notification-fixtures.js";

interface SlackBlock {
  type: string;
  text?: { text: string };
  fields?: { text: string }[];
  elements?: { text: string }[];
}
interface SlackPayload {
  text: string;
  attachments: { color: string; blocks: SlackBlock[] }[];
}

function render(payload: Record<string, unknown>): SlackPayload {
  return payload as unknown as SlackPayload;
}

describe("escapeSlack", () => {
  it("escapes the three characters Slack mrkdwn reserves", () => {
    expect(escapeSlack("a & <b> c")).toBe("a &amp; &lt;b&gt; c");
  });
});

describe("buildSlackPayload", () => {
  it("builds a green attachment with snapshot/size fields for a success event", () => {
    const payload = render(buildSlackPayload(successEvent));
    const attachment = payload.attachments[0]!;
    expect(payload.text).toBe("✅ Backup succeeded: webserver1");
    expect(attachment.color).toBe("#2ecc71");
    const fields = attachment.blocks.find((block) => block.fields)!.fields!.map((field) => field.text);
    expect(fields).toEqual(
      expect.arrayContaining(["*Snapshot*\nabc123", "*Data added*\n1.5 KB", "*Duration*\n4s"]),
    );
  });

  it("builds a red attachment with the escaped error for a failure event", () => {
    const payload = render(buildSlackPayload(failureEvent));
    const attachment = payload.attachments[0]!;
    expect(payload.text).toContain("❌");
    expect(attachment.color).toBe("#e74c3c");
    expect(JSON.stringify(attachment.blocks)).toContain("ssh: connection &lt;refused&gt; &amp; reset");
  });

  it("renders a weekly summary with totals and every target", () => {
    const payload = render(
      buildSlackPayload(weeklyEvent([weeklyTarget(), weeklyTarget({ name: "files", type: "files", health: "failing" })])),
    );
    const attachment = payload.attachments[0]!;
    expect(payload.text).toContain("needs attention");
    expect(attachment.color).toBe("#e74c3c");
    const body = JSON.stringify(attachment.blocks);
    expect(body).toContain("1.0 GB raw data");
    expect(body).toContain("5 succeeded · 1 failed");
    expect(body).toContain("*database*");
    expect(body).toContain("❌ *files*");
  });

  it("keeps a huge weekly report within Slack's block and section limits", () => {
    const targets = Array.from({ length: 2000 }, (_, index) => weeklyTarget({ name: `target-${index}` }));
    const blocks = render(buildSlackPayload(weeklyEvent(targets))).attachments[0]!.blocks;
    expect(blocks.length).toBeLessThanOrEqual(50);
    for (const block of blocks) {
      if (block.text) expect(block.text.text.length).toBeLessThanOrEqual(3000);
    }
    expect(JSON.stringify(blocks)).toContain("omitted");
  });

  it("renders a retention report with each target's outcome", () => {
    const payload = render(buildSlackPayload(retentionEvent));
    expect(payload.text).toBe("❌ Backup retention needs attention");
    const body = payload.attachments[0]!.blocks.map((block) => block.text?.text ?? "").join("\n");
    expect(body).toContain("✅ *db* (14 daily) — kept 14, removed 1");
    expect(body).toContain("❌ *web* — ssh timeout");
    expect(body).toContain("❌ *r2* — prune failed: lock held");
  });

  it("ends with a context footer carrying a Slack date token", () => {
    const blocks = render(buildSlackPayload(successEvent)).attachments[0]!.blocks;
    const footer = blocks.at(-1)!;
    expect(footer.type).toBe("context");
    expect(footer.elements![0]!.text).toMatch(/^baktime · <!date\^\d+\^/);
  });
});

describe("createSlackChannel", () => {
  it("POSTs the built payload as JSON to the webhook URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve("ok") });
    const channel = createSlackChannel({
      webhookUrl: "https://hooks.slack.com/services/T/B/x",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await channel.send(successEvent);

    expect(channel.name).toBe("slack");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hooks.slack.com/services/T/B/x");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual(buildSlackPayload(successEvent));
  });

  it("throws a clear error when Slack responds with a non-2xx status", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 403, text: () => Promise.resolve("invalid_token") });
    const channel = createSlackChannel({
      webhookUrl: "https://hooks.slack.com/services/T/B/bad",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(channel.send(successEvent)).rejects.toThrow(/Slack webhook responded with HTTP 403: invalid_token/);
  });
});
