import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendRecord, getLastRunAt, readHistory } from "../../src/history/writer.js";
import type { HistoryRecord } from "../../src/history/types.js";

let baseDir: string;

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "baktime-history-"));
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

const successRecord: HistoryRecord = {
  timestamp: "2026-08-08T03:00:00.000Z",
  target: "webserver1",
  type: "files",
  durationMs: 4200,
  status: "success",
  snapshotId: "abc123",
  bytesAdded: 4096,
  verification: "sha256",
};

const failureRecord: HistoryRecord = {
  timestamp: "2026-08-09T03:00:00.000Z",
  target: "webserver1",
  type: "files",
  durationMs: 1000,
  status: "failure",
  error: "ssh: connection refused",
};

describe("readHistory / appendRecord", () => {
  it("returns an empty array for a target with no history yet", () => {
    expect(readHistory("webserver1", baseDir)).toEqual([]);
  });

  it("appends records in order and persists them across reads", () => {
    appendRecord("webserver1", successRecord, baseDir);
    appendRecord("webserver1", failureRecord, baseDir);

    const records = readHistory("webserver1", baseDir);
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual(successRecord);
    expect(records[1]).toEqual(failureRecord);
  });

  it("keeps different targets' history separate", () => {
    appendRecord("webserver1", successRecord, baseDir);
    appendRecord("shop-db", { ...successRecord, target: "shop-db", type: "mysql" }, baseDir);

    expect(readHistory("webserver1", baseDir)).toHaveLength(1);
    expect(readHistory("shop-db", baseDir)).toHaveLength(1);
  });
});

describe("getLastRunAt", () => {
  it("returns null when the target has never run", () => {
    expect(getLastRunAt("webserver1", baseDir)).toBeNull();
  });

  it("returns the timestamp of the most recent attempt, success or failure", () => {
    appendRecord("webserver1", successRecord, baseDir);
    appendRecord("webserver1", failureRecord, baseDir);

    const lastRunAt = getLastRunAt("webserver1", baseDir);
    expect(lastRunAt?.toISOString()).toBe(failureRecord.timestamp);
  });
});
