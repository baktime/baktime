import { afterEach, describe, expect, it, vi } from "vitest";

const loadConfigMock = vi.fn();
vi.mock("../../src/config/load.js", () => ({
  loadConfig: (...args: unknown[]) => loadConfigMock(...args),
}));

const ensureRepositoryInitializedMock = vi.fn();
vi.mock("../../src/restic/client.js", () => ({
  ensureRepositoryInitialized: (...args: unknown[]) => ensureRepositoryInitializedMock(...args),
}));

const ensureLocalResticInstalledMock = vi.fn();
vi.mock("../../src/restic/bootstrap-local.js", () => ({
  ensureLocalResticInstalled: (...args: unknown[]) => ensureLocalResticInstalledMock(...args),
}));

const backupFilesTargetMock = vi.fn();
vi.mock("../../src/adapters/files.js", () => ({
  backupFilesTarget: (...args: unknown[]) => backupFilesTargetMock(...args),
}));

const getLastRunAtMock = vi.fn();
const appendRecordMock = vi.fn();
vi.mock("../../src/history/writer.js", () => ({
  getLastRunAt: (...args: unknown[]) => getLastRunAtMock(...args),
  appendRecord: (...args: unknown[]) => appendRecordMock(...args),
}));

const { runTarget } = await import("../../src/cli/run-target.js");

const filesTargetJson = JSON.stringify({
  type: "files",
  host: "web1.example.com",
  sshUser: "deploy",
  sshKeySecretName: "BAKTIME_TARGET_WEBSERVER1_SSH_KEY",
  paths: ["/var/www"],
  schedule: "0 3 * * *",
});

const resticConfig = {
  backend: "r2" as const,
  repository: "s3:https://example.r2.cloudflarestorage.com/bucket",
  passwordSecretName: "RESTIC_PASSWORD",
  accessKeyIdSecretName: "R2_ACCESS_KEY_ID",
  secretAccessKeySecretName: "R2_SECRET_ACCESS_KEY",
};

function setSecretsEnv(extra: Record<string, string> = {}) {
  process.env.BAKTIME_SECRETS_JSON = JSON.stringify({
    BAKTIME_TARGET_WEBSERVER1: filesTargetJson,
    BAKTIME_TARGET_WEBSERVER1_SSH_KEY: "fake-key",
    RESTIC_PASSWORD: "hunter2",
    R2_ACCESS_KEY_ID: "id",
    R2_SECRET_ACCESS_KEY: "secret",
    ...extra,
  });
}

afterEach(() => {
  delete process.env.BAKTIME_SECRETS_JSON;
  delete process.env.BAKTIME_SKIP_DUE_CHECK;
  loadConfigMock.mockReset();
  ensureRepositoryInitializedMock.mockReset();
  ensureLocalResticInstalledMock.mockReset();
  backupFilesTargetMock.mockReset();
  getLastRunAtMock.mockReset();
  appendRecordMock.mockReset();
});

const localBootstrapResult = {
  version: "0.19.1",
  action: "already-installed" as const,
  resticPath: "/home/runner/.baktime/bin/restic",
};

describe("runTarget", () => {
  it("runs the adapter and appends a success record when the target is due", async () => {
    setSecretsEnv();
    loadConfigMock.mockReturnValue({ owner: "x", repo: "y", restic: resticConfig });
    getLastRunAtMock.mockReturnValue(null); // never run -> due
    ensureLocalResticInstalledMock.mockResolvedValue(localBootstrapResult);
    ensureRepositoryInitializedMock.mockResolvedValue("already-initialized");
    backupFilesTargetMock.mockResolvedValue({
      snapshotId: "abc123",
      bytesAdded: 4096,
      verification: "sha256",
    });

    await runTarget("webserver1");

    expect(ensureLocalResticInstalledMock).toHaveBeenCalledTimes(1);
    expect(ensureRepositoryInitializedMock).toHaveBeenCalledWith(
      expect.anything(),
      localBootstrapResult.resticPath,
    );
    expect(backupFilesTargetMock).toHaveBeenCalledTimes(1);
    expect(appendRecordMock).toHaveBeenCalledTimes(1);
    const [name, record] = appendRecordMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(name).toBe("webserver1");
    expect(record).toMatchObject({
      target: "webserver1",
      type: "files",
      status: "success",
      snapshotId: "abc123",
      bytesAdded: 4096,
      verification: "sha256",
    });
  });

  it("skips the adapter entirely when the target is not due yet", async () => {
    setSecretsEnv();
    loadConfigMock.mockReturnValue({ owner: "x", repo: "y", restic: resticConfig });
    getLastRunAtMock.mockReturnValue(new Date()); // just ran -> not due

    await runTarget("webserver1");

    expect(backupFilesTargetMock).not.toHaveBeenCalled();
    expect(appendRecordMock).not.toHaveBeenCalled();
  });

  it("runs regardless of due-ness when BAKTIME_SKIP_DUE_CHECK=true", async () => {
    setSecretsEnv();
    process.env.BAKTIME_SKIP_DUE_CHECK = "true";
    loadConfigMock.mockReturnValue({ owner: "x", repo: "y", restic: resticConfig });
    getLastRunAtMock.mockReturnValue(new Date()); // would normally not be due
    ensureLocalResticInstalledMock.mockResolvedValue(localBootstrapResult);
    ensureRepositoryInitializedMock.mockResolvedValue("already-initialized");
    backupFilesTargetMock.mockResolvedValue({ snapshotId: "abc", bytesAdded: 1 });

    await runTarget("webserver1");

    expect(backupFilesTargetMock).toHaveBeenCalledTimes(1);
  });

  it("appends a failure record and rethrows when the adapter fails", async () => {
    setSecretsEnv();
    loadConfigMock.mockReturnValue({ owner: "x", repo: "y", restic: resticConfig });
    getLastRunAtMock.mockReturnValue(null);
    ensureLocalResticInstalledMock.mockResolvedValue(localBootstrapResult);
    ensureRepositoryInitializedMock.mockResolvedValue("already-initialized");
    backupFilesTargetMock.mockRejectedValue(new Error("ssh: connection refused"));

    await expect(runTarget("webserver1")).rejects.toThrow("ssh: connection refused");

    expect(appendRecordMock).toHaveBeenCalledTimes(1);
    const [, record] = appendRecordMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(record).toMatchObject({ status: "failure", error: "ssh: connection refused" });
  });

  it("throws a clear error for an unknown target name", async () => {
    setSecretsEnv();
    loadConfigMock.mockReturnValue({ owner: "x", repo: "y", restic: resticConfig });

    await expect(runTarget("does-not-exist")).rejects.toThrow(/No valid target named/);
    expect(backupFilesTargetMock).not.toHaveBeenCalled();
  });
});
