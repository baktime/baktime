import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPgDumpArgs } from "../../src/adapters/postgres.js";

const openTunnelMock = vi.fn();
vi.mock("../../src/ssh/tunnel.js", () => ({
  openTunnel: (...args: unknown[]) => openTunnelMock(...args),
}));

const spawnPipelineMock = vi.fn();
vi.mock("../../src/util/exec.js", () => ({
  spawnPipeline: (...args: unknown[]) => spawnPipelineMock(...args),
}));

const { backupPostgresTarget } = await import("../../src/adapters/postgres.js");
const { SecretsStore } = await import("../../src/config/secrets.js");
const { withName } = await import("../../src/config/schema.js");

describe("buildPgDumpArgs", () => {
  it("builds a pg_dump command with --no-password (forces PGPASSWORD, never a prompt)", () => {
    expect(buildPgDumpArgs({ host: "pg.example.com", port: 5432 }, "pg_user", "analytics")).toEqual([
      "-h",
      "pg.example.com",
      "-p",
      "5432",
      "-U",
      "pg_user",
      "-d",
      "analytics",
      "--no-password",
    ]);
  });
});

const resticConfig = {
  backend: "r2" as const,
  repository: "s3:https://example.r2.cloudflarestorage.com/bucket",
  passwordSecretName: "RESTIC_PASSWORD",
  accessKeyIdSecretName: "R2_ACCESS_KEY_ID",
  secretAccessKeySecretName: "R2_SECRET_ACCESS_KEY",
};

const summaryLine = JSON.stringify({ message_type: "summary", snapshot_id: "pg789", data_added: 512 });

const secrets = SecretsStore.fromRecord({
  RESTIC_PASSWORD: "hunter2",
  R2_ACCESS_KEY_ID: "id",
  R2_SECRET_ACCESS_KEY: "secret",
  ANALYTICS_USER: "pg_user",
  ANALYTICS_PASSWORD: "pgpass",
});

const target = withName(
  {
    type: "postgres" as const,
    database: "analytics",
    connection: { mode: "direct" as const, host: "pg.example.com", port: 5432, tls: true },
    userSecretName: "ANALYTICS_USER",
    passwordSecretName: "ANALYTICS_PASSWORD",
    schedule: "0 2 * * *",
  },
  "analytics",
);

afterEach(() => {
  openTunnelMock.mockReset();
  spawnPipelineMock.mockReset();
});

describe("backupPostgresTarget", () => {
  it("dumps via pg_dump with PGPASSWORD and streams into restic --stdin", async () => {
    spawnPipelineMock.mockResolvedValue({ stdout: summaryLine, stderr: "" });

    const result = await backupPostgresTarget(target, secrets, resticConfig, "/path/to/restic");

    expect(result).toEqual({ snapshotId: "pg789", bytesAdded: 512 });
    const [producer] = spawnPipelineMock.mock.calls[0] as [
      { command: string; args: string[]; env: Record<string, string | undefined> },
    ];
    expect(producer.command).toBe("pg_dump");
    expect(producer.env.PGPASSWORD).toBe("pgpass");
    expect(producer.args).toContain("analytics");
  });

  it("rejects a local restic backend before opening any connection", async () => {
    const localBackendConfig = {
      backend: "local" as const,
      repository: "/storage/restic-repo",
      passwordSecretName: "RESTIC_PASSWORD",
    };

    await expect(backupPostgresTarget(target, secrets, localBackendConfig, "restic")).rejects.toThrow(
      /local.*restic backend.*runner/i,
    );
    expect(spawnPipelineMock).not.toHaveBeenCalled();
  });
});
