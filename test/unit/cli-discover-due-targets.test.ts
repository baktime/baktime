import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeDueTargetNames } from "../../src/cli/discover-due-targets.js";
import { appendRecord } from "../../src/history/writer.js";
import { SecretsStore } from "../../src/config/secrets.js";
import type { HistoryRecord } from "../../src/history/types.js";

const filesTargetJson = JSON.stringify({
  type: "files",
  host: "web1.example.com",
  sshUser: "deploy",
  sshKeySecretName: "BAKTIME_TARGET_WEBSERVER1_SSH_KEY",
  paths: ["/var/www"],
  schedule: "0 3 * * *",
});

const mysqlTargetJson = JSON.stringify({
  type: "mysql",
  database: "shop",
  connection: { mode: "direct", host: "db.example.com", port: 3306 },
  userSecretName: "SHOP_DB_USER",
  passwordSecretName: "SHOP_DB_PASSWORD",
  schedule: "0 3 * * *",
});

let baseDir: string;

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "baktime-history-"));
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

describe("computeDueTargetNames", () => {
  it("includes a target that has never run", () => {
    const secrets = SecretsStore.fromRecord({ BAKTIME_TARGET_WEBSERVER1: filesTargetJson });
    const now = new Date("2026-08-08T10:00:00.000Z");

    const { due, hadErrors } = computeDueTargetNames(secrets, now, baseDir);

    expect(due).toEqual(["webserver1"]);
    expect(hadErrors).toBe(false);
  });

  it("excludes a target that already ran since its most recent scheduled tick", () => {
    const secrets = SecretsStore.fromRecord({ BAKTIME_TARGET_WEBSERVER1: filesTargetJson });
    const now = new Date("2026-08-08T10:00:00.000Z");
    const alreadyRan: HistoryRecord = {
      timestamp: "2026-08-08T03:00:00.000Z",
      target: "webserver1",
      type: "files",
      durationMs: 100,
      status: "success",
      snapshotId: "abc",
      bytesAdded: 10,
    };
    appendRecord("webserver1", alreadyRan, baseDir);

    const { due } = computeDueTargetNames(secrets, now, baseDir);
    expect(due).toEqual([]);
  });

  it("evaluates multiple targets independently", () => {
    const secrets = SecretsStore.fromRecord({
      BAKTIME_TARGET_WEBSERVER1: filesTargetJson,
      BAKTIME_TARGET_SHOP_DB: mysqlTargetJson,
    });
    const now = new Date("2026-08-08T10:00:00.000Z");
    appendRecord(
      "webserver1",
      {
        timestamp: "2026-08-08T03:00:00.000Z",
        target: "webserver1",
        type: "files",
        durationMs: 100,
        status: "success",
        snapshotId: "abc",
        bytesAdded: 10,
      },
      baseDir,
    );

    const { due } = computeDueTargetNames(secrets, now, baseDir);
    expect(due).toEqual(["shop-db"]);
  });

  it("reports hadErrors when a target secret fails validation, without blocking valid targets", () => {
    const secrets = SecretsStore.fromRecord({
      BAKTIME_TARGET_WEBSERVER1: filesTargetJson,
      BAKTIME_TARGET_BROKEN: JSON.stringify({ type: "files" }),
    });
    const now = new Date("2026-08-08T10:00:00.000Z");

    const { due, hadErrors } = computeDueTargetNames(secrets, now, baseDir);

    expect(due).toEqual(["webserver1"]);
    expect(hadErrors).toBe(true);
  });
});
