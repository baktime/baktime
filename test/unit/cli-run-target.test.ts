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

const backupMysqlTargetMock = vi.fn();
vi.mock("../../src/adapters/mysql.js", () => ({
  backupMysqlTarget: (...args: unknown[]) => backupMysqlTargetMock(...args),
}));

const backupPostgresTargetMock = vi.fn();
vi.mock("../../src/adapters/postgres.js", () => ({
  backupPostgresTarget: (...args: unknown[]) => backupPostgresTargetMock(...args),
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
  backupMysqlTargetMock.mockReset();
  backupPostgresTargetMock.mockReset();
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

  it("dispatches a mysql target to the mysql adapter with the bootstrapped local restic path", async () => {
    process.env.BAKTIME_SECRETS_JSON = JSON.stringify({
      BAKTIME_TARGET_SHOP_DB: JSON.stringify({
        type: "mysql",
        database: "shop",
        connection: { mode: "direct", host: "db.example.com", port: 3306 },
        userSecretName: "SHOP_DB_USER",
        passwordSecretName: "SHOP_DB_PASSWORD",
        schedule: "*/30 * * * *",
      }),
      SHOP_DB_USER: "admin",
      SHOP_DB_PASSWORD: "dbpass",
      RESTIC_PASSWORD: "hunter2",
      R2_ACCESS_KEY_ID: "id",
      R2_SECRET_ACCESS_KEY: "secret",
    });
    loadConfigMock.mockReturnValue({ owner: "x", repo: "y", restic: resticConfig });
    getLastRunAtMock.mockReturnValue(null);
    ensureLocalResticInstalledMock.mockResolvedValue(localBootstrapResult);
    ensureRepositoryInitializedMock.mockResolvedValue("already-initialized");
    backupMysqlTargetMock.mockResolvedValue({ snapshotId: "sql1", bytesAdded: 999 });

    await runTarget("shop-db");

    expect(backupFilesTargetMock).not.toHaveBeenCalled();
    expect(backupPostgresTargetMock).not.toHaveBeenCalled();
    expect(backupMysqlTargetMock).toHaveBeenCalledTimes(1);
    const [target, , resticCfg, resticPath] = backupMysqlTargetMock.mock.calls[0] as [
      { name: string },
      unknown,
      unknown,
      string,
    ];
    expect(target.name).toBe("shop-db");
    expect(resticCfg).toBe(resticConfig);
    expect(resticPath).toBe(localBootstrapResult.resticPath);
  });
});
