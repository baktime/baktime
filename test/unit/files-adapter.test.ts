import { afterEach, describe, expect, it, vi } from "vitest";

const ensureRemoteResticInstalledMock = vi.fn();
vi.mock("../../src/restic/bootstrap-remote.js", () => ({
  ensureRemoteResticInstalled: (...args: unknown[]) => ensureRemoteResticInstalledMock(...args),
}));

const runRemoteCommandMock = vi.fn();
vi.mock("../../src/ssh/connection.js", () => ({
  runRemoteCommand: (...args: unknown[]) => runRemoteCommandMock(...args),
}));

const { backupFilesTarget } = await import("../../src/adapters/files.js");
const { SecretsStore } = await import("../../src/config/secrets.js");
const { withName } = await import("../../src/config/schema.js");

const resticConfig = {
  backend: "r2" as const,
  repository: "s3:https://example.r2.cloudflarestorage.com/bucket",
  passwordSecretName: "RESTIC_PASSWORD",
  accessKeyIdSecretName: "R2_ACCESS_KEY_ID",
  secretAccessKeySecretName: "R2_SECRET_ACCESS_KEY",
};

const secrets = SecretsStore.fromRecord({
  RESTIC_PASSWORD: "hunter2",
  R2_ACCESS_KEY_ID: "AKIA...",
  R2_SECRET_ACCESS_KEY: "shh",
  BAKTIME_TARGET_WEBSERVER1_SSH_KEY: "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END-----",
});

const filesTarget = withName(
  {
    type: "files" as const,
    host: "web1.example.com",
    sshUser: "deploy",
    sshPort: 22,
    sshKeySecretName: "BAKTIME_TARGET_WEBSERVER1_SSH_KEY",
    paths: ["/var/www", "/etc/nginx"],
    excludes: ["*.log"],
    schedule: "0 3 * * *",
  },
  "webserver1",
);

const summaryLine = JSON.stringify({
  message_type: "summary",
  snapshot_id: "abc123",
  data_added: 4096,
  files_new: 2,
  files_changed: 1,
  total_bytes_processed: 8192,
  total_duration: 3.2,
});

afterEach(() => {
  ensureRemoteResticInstalledMock.mockReset();
  runRemoteCommandMock.mockReset();
});

describe("backupFilesTarget", () => {
  it("bootstraps restic, then runs a tagged backup over SSH with credentials in env only", async () => {
    ensureRemoteResticInstalledMock.mockResolvedValue({
      version: "0.19.1",
      action: "installed",
      resticPath: "/home/deploy/.baktime/bin/restic",
    });
    runRemoteCommandMock.mockResolvedValue({ stdout: summaryLine, stderr: "" });

    const result = await backupFilesTarget(filesTarget, secrets, resticConfig);

    expect(result).toEqual({
      snapshotId: "abc123",
      bytesAdded: 4096,
      filesNew: 2,
      filesChanged: 1,
      totalBytesProcessed: 8192,
      verification: "sha256",
      bootstrapAction: "installed",
    });

    // Bootstrap used the SSH identity resolved from the target's secret.
    const [sshTargetArg, bootstrapOptions] = ensureRemoteResticInstalledMock.mock.calls[0] as [
      { host: string; user: string; privateKey: string },
      { version?: string },
    ];
    expect(sshTargetArg.host).toBe("web1.example.com");
    expect(sshTargetArg.user).toBe("deploy");
    expect(sshTargetArg.privateKey).toContain("BEGIN OPENSSH PRIVATE KEY");
    expect(bootstrapOptions.version).toBeUndefined();

    // Backup ran the bootstrapped restic path, tagged with the target name, with excludes applied.
    const [, resticPath, args, options] = runRemoteCommandMock.mock.calls[0] as [
      unknown,
      string,
      string[],
      { env: Record<string, string> },
    ];
    expect(resticPath).toBe("/home/deploy/.baktime/bin/restic");
    expect(args).toEqual([
      "backup",
      "--json",
      "--tag",
      "webserver1",
      "--exclude",
      "*.log",
      "/var/www",
      "/etc/nginx",
    ]);
    expect(options.env).toEqual({
      RESTIC_REPOSITORY: resticConfig.repository,
      RESTIC_PASSWORD: "hunter2",
      AWS_ACCESS_KEY_ID: "AKIA...",
      AWS_SECRET_ACCESS_KEY: "shh",
    });
  });

  it("propagates a bootstrap failure without attempting the backup", async () => {
    ensureRemoteResticInstalledMock.mockRejectedValue(new Error("checksum mismatch"));

    await expect(backupFilesTarget(filesTarget, secrets, resticConfig)).rejects.toThrow(
      "checksum mismatch",
    );
    expect(runRemoteCommandMock).not.toHaveBeenCalled();
  });
});
