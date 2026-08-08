import { describe, expect, it } from "vitest";
import {
  BaktimeConfigSchema,
  FilesTargetSchema,
  MysqlTargetSchema,
  TargetSchema,
} from "../../src/config/schema.js";

const validResticConfig = {
  backend: "r2",
  repository: "s3:https://accountid.r2.cloudflarestorage.com/my-bucket",
  passwordSecretName: "RESTIC_PASSWORD",
  accessKeyIdSecretName: "R2_ACCESS_KEY_ID",
  secretAccessKeySecretName: "R2_SECRET_ACCESS_KEY",
};

describe("BaktimeConfigSchema", () => {
  it("accepts a minimal valid instance config with no targets", () => {
    const result = BaktimeConfigSchema.safeParse({
      owner: "mleczakm",
      repo: "backup",
      restic: validResticConfig,
    });
    expect(result.success).toBe(true);
  });

  it("accepts knownTargets and statusSite as optional extras", () => {
    const result = BaktimeConfigSchema.safeParse({
      owner: "mleczakm",
      repo: "backup",
      restic: validResticConfig,
      knownTargets: ["webserver1", "shop-db"],
      statusSite: { name: "My Backups", theme: "auto" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a config with a literal `targets` array (dynamic-from-secrets only)", () => {
    const result = BaktimeConfigSchema.safeParse({
      owner: "mleczakm",
      repo: "backup",
      restic: validResticConfig,
      targets: [{ type: "files" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a config missing required restic fields", () => {
    const result = BaktimeConfigSchema.safeParse({
      owner: "mleczakm",
      repo: "backup",
      restic: { backend: "r2" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid knownTargets entry (uppercase not allowed)", () => {
    const result = BaktimeConfigSchema.safeParse({
      owner: "mleczakm",
      repo: "backup",
      restic: validResticConfig,
      knownTargets: ["WebServer1"],
    });
    expect(result.success).toBe(false);
  });
});

describe("FilesTargetSchema", () => {
  const validFilesTarget = {
    type: "files",
    host: "web1.example.com",
    sshUser: "deploy",
    sshKeySecretName: "BAKTIME_TARGET_WEBSERVER1_SSH_KEY",
    paths: ["/var/www", "/etc/nginx"],
    schedule: "0 3 * * *",
  };

  it("accepts a valid files target and defaults sshPort to 22", () => {
    const result = FilesTargetSchema.safeParse(validFilesTarget);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sshPort).toBe(22);
    }
  });

  it("rejects an invalid cron schedule", () => {
    const result = FilesTargetSchema.safeParse({
      ...validFilesTarget,
      schedule: "not a cron expression",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty paths array", () => {
    const result = FilesTargetSchema.safeParse({ ...validFilesTarget, paths: [] });
    expect(result.success).toBe(false);
  });

  it("rejects a secret-name-shaped field containing a raw secret value instead of a name", () => {
    const result = FilesTargetSchema.safeParse({
      ...validFilesTarget,
      sshKeySecretName: "-----BEGIN OPENSSH PRIVATE KEY-----",
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown/extra fields (strict schema)", () => {
    const result = FilesTargetSchema.safeParse({ ...validFilesTarget, unexpected: "nope" });
    expect(result.success).toBe(false);
  });
});

describe("MysqlTargetSchema / database connection modes", () => {
  const base = {
    type: "mysql" as const,
    database: "shop",
    userSecretName: "BAKTIME_TARGET_SHOPDB_USER",
    passwordSecretName: "BAKTIME_TARGET_SHOPDB_PASSWORD",
    schedule: "*/30 * * * *",
  };

  it("accepts a direct connection and defaults tls to true", () => {
    const result = MysqlTargetSchema.safeParse({
      ...base,
      connection: { mode: "direct", host: "db.example.com", port: 3306 },
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.connection.mode === "direct") {
      expect(result.data.connection.tls).toBe(true);
    }
  });

  it("accepts a tunnel connection and defaults jumpPort to 22", () => {
    const result = MysqlTargetSchema.safeParse({
      ...base,
      connection: {
        mode: "tunnel",
        jumpHost: "bastion.example.com",
        jumpUser: "deploy",
        jumpSshKeySecretName: "BAKTIME_TARGET_SHOPDB_JUMP_SSH_KEY",
        remoteHost: "127.0.0.1",
        remotePort: 3306,
      },
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.connection.mode === "tunnel") {
      expect(result.data.connection.jumpPort).toBe(22);
    }
  });

  it("rejects an unknown connection mode", () => {
    const result = MysqlTargetSchema.safeParse({
      ...base,
      connection: { mode: "vpn", host: "db.example.com" },
    });
    expect(result.success).toBe(false);
  });
});

describe("TargetSchema discriminated union", () => {
  it("routes files/mysql/postgres to the right branch and rejects unknown types", () => {
    expect(TargetSchema.safeParse({ type: "bogus" }).success).toBe(false);
    expect(
      TargetSchema.safeParse({
        type: "postgres",
        database: "analytics",
        connection: { mode: "direct", host: "pg.example.com", port: 5432 },
        userSecretName: "PG_USER",
        passwordSecretName: "PG_PASSWORD",
        schedule: "0 2 * * *",
      }).success,
    ).toBe(true);
  });
});
