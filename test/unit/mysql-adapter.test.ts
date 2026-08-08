import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMysqldumpArgs } from "../../src/adapters/mysql.js";

const openTunnelMock = vi.fn();
vi.mock("../../src/ssh/tunnel.js", () => ({
  openTunnel: (...args: unknown[]) => openTunnelMock(...args),
}));

const spawnPipelineMock = vi.fn();
vi.mock("../../src/util/exec.js", () => ({
  spawnPipeline: (...args: unknown[]) => spawnPipelineMock(...args),
}));

const { backupMysqlTarget } = await import("../../src/adapters/mysql.js");
const { SecretsStore } = await import("../../src/config/secrets.js");
const { withName } = await import("../../src/config/schema.js");

describe("buildMysqldumpArgs", () => {
  it("builds a --single-transaction dump command for the resolved connection", () => {
    expect(buildMysqldumpArgs({ host: "db.example.com", port: 3306 }, "admin", "shop")).toEqual([
      "--single-transaction",
      "-h",
      "db.example.com",
      "-P",
      "3306",
      "-u",
      "admin",
      "shop",
    ]);
  });

  it("never includes the password in the argument list", () => {
    const args = buildMysqldumpArgs({ host: "db.example.com", port: 3306 }, "admin", "shop");
    expect(args.join(" ")).not.toMatch(/hunter2/);
  });
});

const resticConfig = {
  backend: "r2" as const,
  repository: "s3:https://example.r2.cloudflarestorage.com/bucket",
  passwordSecretName: "RESTIC_PASSWORD",
  accessKeyIdSecretName: "R2_ACCESS_KEY_ID",
  secretAccessKeySecretName: "R2_SECRET_ACCESS_KEY",
};

const summaryLine = JSON.stringify({
  message_type: "summary",
  snapshot_id: "def456",
  data_added: 2048,
});

function baseSecrets(extra: Record<string, string> = {}) {
  return SecretsStore.fromRecord({
    RESTIC_PASSWORD: "hunter2",
    R2_ACCESS_KEY_ID: "id",
    R2_SECRET_ACCESS_KEY: "secret",
    SHOP_DB_USER: "admin",
    SHOP_DB_PASSWORD: "dbpassword",
    ...extra,
  });
}

const directTarget = withName(
  {
    type: "mysql" as const,
    database: "shop",
    connection: { mode: "direct" as const, host: "db.example.com", port: 3306, tls: true },
    userSecretName: "SHOP_DB_USER",
    passwordSecretName: "SHOP_DB_PASSWORD",
    schedule: "*/30 * * * *",
  },
  "shop-db",
);

const tunnelTarget = withName(
  {
    type: "mysql" as const,
    database: "shop",
    connection: {
      mode: "tunnel" as const,
      jumpHost: "bastion.example.com",
      jumpUser: "deploy",
      jumpPort: 22,
      jumpSshKeySecretName: "JUMP_SSH_KEY",
      remoteHost: "127.0.0.1",
      remotePort: 3306,
    },
    userSecretName: "SHOP_DB_USER",
    passwordSecretName: "SHOP_DB_PASSWORD",
    schedule: "*/30 * * * *",
  },
  "shop-db",
);

afterEach(() => {
  openTunnelMock.mockReset();
  spawnPipelineMock.mockReset();
});

describe("backupMysqlTarget", () => {
  it("dumps directly (no tunnel) and streams into restic --stdin with the target's tag", async () => {
    spawnPipelineMock.mockResolvedValue({ stdout: summaryLine, stderr: "" });

    const result = await backupMysqlTarget(directTarget, baseSecrets(), resticConfig, "/path/to/restic");

    expect(openTunnelMock).not.toHaveBeenCalled();
    expect(result).toEqual({ snapshotId: "def456", bytesAdded: 2048 });

    const [producer, consumer] = spawnPipelineMock.mock.calls[0] as [
      { command: string; args: string[]; env: Record<string, string | undefined> },
      { command: string; args: string[]; env: Record<string, string | undefined> },
    ];
    expect(producer.command).toBe("mysqldump");
    expect(producer.args).toEqual(["--single-transaction", "-h", "db.example.com", "-P", "3306", "-u", "admin", "shop"]);
    expect(producer.env.MYSQL_PWD).toBe("dbpassword");

    expect(consumer.command).toBe("/path/to/restic");
    expect(consumer.args).toEqual(
      expect.arrayContaining(["backup", "--json", "--tag", "shop-db", "--stdin", "--stdin-filename"]),
    );
    expect(consumer.env.RESTIC_PASSWORD).toBe("hunter2");
    expect(consumer.env.AWS_ACCESS_KEY_ID).toBe("id");
  });

  it("opens a tunnel for tunnel-mode connections and dumps against 127.0.0.1:<localPort>", async () => {
    const closeMock = vi.fn().mockResolvedValue(undefined);
    openTunnelMock.mockResolvedValue({ localPort: 54321, close: closeMock });
    spawnPipelineMock.mockResolvedValue({ stdout: summaryLine, stderr: "" });

    await backupMysqlTarget(tunnelTarget, baseSecrets({ JUMP_SSH_KEY: "fake-key" }), resticConfig, "restic");

    expect(openTunnelMock).toHaveBeenCalledWith(
      expect.objectContaining({ host: "bastion.example.com", user: "deploy", privateKey: "fake-key" }),
      "127.0.0.1",
      3306,
    );
    const [producer] = spawnPipelineMock.mock.calls[0] as [{ args: string[] }];
    expect(producer.args).toContain("54321");
    expect(producer.args).toContain("127.0.0.1");
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("closes the tunnel even when the dump/backup pipeline fails", async () => {
    const closeMock = vi.fn().mockResolvedValue(undefined);
    openTunnelMock.mockResolvedValue({ localPort: 54321, close: closeMock });
    spawnPipelineMock.mockRejectedValue(new Error("mysqldump: access denied"));

    await expect(
      backupMysqlTarget(tunnelTarget, baseSecrets({ JUMP_SSH_KEY: "fake-key" }), resticConfig, "restic"),
    ).rejects.toThrow("access denied");

    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a local restic backend before opening any connection", async () => {
    const localBackendConfig = {
      backend: "local" as const,
      repository: "/storage/restic-repo",
      passwordSecretName: "RESTIC_PASSWORD",
    };

    await expect(
      backupMysqlTarget(directTarget, baseSecrets(), localBackendConfig, "restic"),
    ).rejects.toThrow(/local.*restic backend.*runner/i);

    expect(openTunnelMock).not.toHaveBeenCalled();
    expect(spawnPipelineMock).not.toHaveBeenCalled();
  });
});
