import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NamedTarget, ResticBackendConfig } from "../../src/config/schema.js";

const ensureLocalResticInstalledMock = vi.fn();
const ensureRemoteResticInstalledMock = vi.fn();
const runLocalResticMock = vi.fn();
const runRemoteCommandMock = vi.fn();
const buildResticEnvMock = vi.fn();

vi.mock("../../src/restic/bootstrap-local.js", () => ({
  ensureLocalResticInstalled: (...args: unknown[]) => ensureLocalResticInstalledMock(...args),
}));
vi.mock("../../src/restic/bootstrap-remote.js", () => ({
  ensureRemoteResticInstalled: (...args: unknown[]) => ensureRemoteResticInstalledMock(...args),
}));
vi.mock("../../src/restic/client.js", () => ({
  buildStatsArgs: () => ["stats", "--mode", "raw-data", "--json"],
  parseResticStats: (stdout: string) => JSON.parse(stdout),
  runLocalRestic: (...args: unknown[]) => runLocalResticMock(...args),
}));
vi.mock("../../src/restic/env.js", () => ({
  buildResticEnv: (...args: unknown[]) => buildResticEnvMock(...args),
}));
vi.mock("../../src/ssh/connection.js", () => ({
  runRemoteCommand: (...args: unknown[]) => runRemoteCommandMock(...args),
}));

const { SecretsStore } = await import("../../src/config/secrets.js");
const { collectRepositorySummary } = await import("../../src/summary/repositories.js");

const globalConfig: ResticBackendConfig = {
  backend: "r2",
  repository: "s3:https://example.invalid/shared",
  passwordSecretName: "RESTIC_PASSWORD",
  accessKeyIdSecretName: "R2_ID",
  secretAccessKeySecretName: "R2_KEY",
};

const localConfig: ResticBackendConfig = {
  backend: "local",
  repository: "/storage/backups",
  passwordSecretName: "RESTIC_PASSWORD",
};

function filesTarget(name: string, restic?: ResticBackendConfig): NamedTarget {
  return {
    name,
    type: "files",
    host: "server.example.com",
    sshUser: "backup",
    sshPort: 22,
    sshKeySecretName: "SSH_KEY",
    paths: ["/data"],
    schedule: "0 5 * * *",
    ...(restic ? { restic } : {}),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  ensureLocalResticInstalledMock.mockResolvedValue({ resticPath: "/tmp/restic" });
  ensureRemoteResticInstalledMock.mockResolvedValue({ resticPath: "/home/backup/.baktime/bin/restic" });
  buildResticEnvMock.mockReturnValue({ RESTIC_REPOSITORY: "repo", RESTIC_PASSWORD: "password" });
});

describe("collectRepositorySummary", () => {
  it("deduplicates shared network and host-local repositories and sums their stats", async () => {
    runLocalResticMock.mockResolvedValue({
      stdout: JSON.stringify({ totalSize: 1000, totalFileCount: 20, snapshotsCount: 3 }),
      stderr: "",
    });
    runRemoteCommandMock.mockResolvedValue({
      stdout: JSON.stringify({ totalSize: 500, totalFileCount: 10, snapshotsCount: 2 }),
      stderr: "",
    });
    const targets: NamedTarget[] = [
      filesTarget("network-files"),
      { name: "database", type: "postgres", schedule: "0 5 * * *" } as NamedTarget,
      filesTarget("local-a", localConfig),
      filesTarget("local-b", localConfig),
    ];
    const secrets = SecretsStore.fromRecord({ SSH_KEY: "key" });

    await expect(collectRepositorySummary(targets, globalConfig, secrets)).resolves.toEqual({
      storageBytes: 1500,
      snapshots: 5,
      files: 30,
      checked: 2,
      unavailable: 0,
    });
    expect(runLocalResticMock).toHaveBeenCalledTimes(1);
    expect(runRemoteCommandMock).toHaveBeenCalledTimes(1);
  });

  it("keeps successful totals when another repository cannot be inspected", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    runLocalResticMock.mockResolvedValue({
      stdout: JSON.stringify({ totalSize: 1000, totalFileCount: 20, snapshotsCount: 3 }),
      stderr: "",
    });
    runRemoteCommandMock.mockRejectedValue(new Error("host unreachable"));

    const result = await collectRepositorySummary(
      [filesTarget("network"), filesTarget("local", localConfig)],
      globalConfig,
      SecretsStore.fromRecord({ SSH_KEY: "key" }),
    );

    expect(result).toEqual({
      storageBytes: 1000,
      snapshots: 3,
      files: 20,
      checked: 1,
      unavailable: 1,
    });
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("host unreachable"));
    consoleErrorSpy.mockRestore();
  });
});
