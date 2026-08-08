import { afterEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.fn();
vi.mock("../../src/util/exec.js", () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

const {
  buildBackupArgs,
  buildBackupStdinArgs,
  buildCheckArgs,
  buildInitArgs,
  buildSnapshotsArgs,
  ensureRepositoryInitialized,
  parseBackupSummary,
} = await import("../../src/restic/client.js");

const env = {
  RESTIC_REPOSITORY: "s3:https://example.r2.cloudflarestorage.com/bucket",
  RESTIC_PASSWORD: "hunter2",
  AWS_ACCESS_KEY_ID: "id",
  AWS_SECRET_ACCESS_KEY: "secret",
};

afterEach(() => {
  execFileMock.mockReset();
});

describe("argument builders", () => {
  it("buildInitArgs", () => {
    expect(buildInitArgs()).toEqual(["init", "--json"]);
  });

  it("buildSnapshotsArgs with no options", () => {
    expect(buildSnapshotsArgs()).toEqual(["snapshots", "--json"]);
  });

  it("buildSnapshotsArgs with tag and latest", () => {
    expect(buildSnapshotsArgs({ tag: "webserver1", latest: 1 })).toEqual([
      "snapshots",
      "--json",
      "--tag",
      "webserver1",
      "--latest",
      "1",
    ]);
  });

  it("buildCheckArgs", () => {
    expect(buildCheckArgs()).toEqual(["check"]);
  });

  it("buildBackupArgs with excludes", () => {
    expect(
      buildBackupArgs(["/var/www", "/etc/nginx"], {
        tag: "webserver1",
        excludes: ["*.log", "node_modules"],
      }),
    ).toEqual([
      "backup",
      "--json",
      "--tag",
      "webserver1",
      "--exclude",
      "*.log",
      "--exclude",
      "node_modules",
      "/var/www",
      "/etc/nginx",
    ]);
  });

  it("buildBackupArgs without excludes", () => {
    expect(buildBackupArgs(["/var/www"], { tag: "webserver1" })).toEqual([
      "backup",
      "--json",
      "--tag",
      "webserver1",
      "/var/www",
    ]);
  });

  it("buildBackupStdinArgs", () => {
    expect(buildBackupStdinArgs({ tag: "shop-db", stdinFilename: "shop-2026-08-08.sql" })).toEqual([
      "backup",
      "--json",
      "--tag",
      "shop-db",
      "--stdin",
      "--stdin-filename",
      "shop-2026-08-08.sql",
    ]);
  });
});

describe("ensureRepositoryInitialized", () => {
  it("does not re-initialize when snapshots succeeds (already initialized)", async () => {
    execFileMock.mockResolvedValueOnce({ stdout: "[]", stderr: "" });
    const result = await ensureRepositoryInitialized(env);
    expect(result).toBe("already-initialized");
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock).toHaveBeenCalledWith(
      "restic",
      expect.arrayContaining(["snapshots"]),
      // HOME must be present — restic's `backup` command fails fast with
      // "unable to open cache" without a locatable cache directory (a real
      // production incident this test guards against regressing).
      { env: expect.objectContaining({ ...env, HOME: process.env.HOME }) },
    );
  });

  it("initializes the repository when snapshots fails", async () => {
    execFileMock.mockRejectedValueOnce(new Error("unable to open repo"));
    execFileMock.mockResolvedValueOnce({ stdout: "{}", stderr: "" });

    const result = await ensureRepositoryInitialized(env);

    expect(result).toBe("initialized");
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(execFileMock).toHaveBeenNthCalledWith(2, "restic", ["init", "--json"], {
      env: expect.objectContaining({ ...env, HOME: process.env.HOME }),
    });
  });
});

describe("parseBackupSummary", () => {
  it("extracts totals and snapshot id from the final summary line", () => {
    const stdout = [
      JSON.stringify({ message_type: "status", percent_done: 0.5 }),
      JSON.stringify({
        message_type: "summary",
        files_new: 3,
        files_changed: 1,
        files_unmodified: 40,
        data_added: 1024,
        total_bytes_processed: 2048,
        total_duration: 12.5,
        snapshot_id: "abc123",
      }),
    ].join("\n");

    expect(parseBackupSummary(stdout)).toEqual({
      snapshotId: "abc123",
      filesNew: 3,
      filesChanged: 1,
      filesUnmodified: 40,
      dataAdded: 1024,
      totalBytesProcessed: 2048,
      totalDurationSeconds: 12.5,
    });
  });

  it("throws when no summary line is present", () => {
    const stdout = JSON.stringify({ message_type: "status", percent_done: 0.5 });
    expect(() => parseBackupSummary(stdout)).toThrow(/summary/);
  });

  it("ignores unparseable lines mixed in with real output", () => {
    const stdout = [
      "restic: some warning printed to stdout",
      JSON.stringify({ message_type: "summary", snapshot_id: "def456" }),
    ].join("\n");
    expect(parseBackupSummary(stdout).snapshotId).toBe("def456");
  });
});
