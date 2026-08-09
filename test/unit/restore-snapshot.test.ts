import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const discoverTargetsMock = vi.fn();
vi.mock("../../src/config/discover-targets.js", () => ({
  discoverTargets: (...args: unknown[]) => discoverTargetsMock(...args),
}));

const loadConfigMock = vi.fn();
vi.mock("../../src/config/load.js", () => ({
  loadConfig: (...args: unknown[]) => loadConfigMock(...args),
}));

const secretsResolveMock = vi.fn();
vi.mock("../../src/config/secrets.js", () => ({
  SecretsStore: { fromEnv: () => ({ resolve: (...args: unknown[]) => secretsResolveMock(...args) }) },
}));

const buildResticEnvMock = vi.fn();
vi.mock("../../src/restic/env.js", () => ({
  buildResticEnv: (...args: unknown[]) => buildResticEnvMock(...args),
}));

const ensureRemoteResticInstalledMock = vi.fn();
vi.mock("../../src/restic/bootstrap-remote.js", () => ({
  ensureRemoteResticInstalled: (...args: unknown[]) => ensureRemoteResticInstalledMock(...args),
}));

const runRemoteCommandMock = vi.fn();
vi.mock("../../src/ssh/connection.js", () => ({
  runRemoteCommand: (...args: unknown[]) => runRemoteCommandMock(...args),
}));

const {
  findSoleFilePath,
  MYSQL_IMPORT_SPEC,
  PSQL_IMPORT_SPEC,
  restoreSnapshot,
} = await import("../../src/cli/restore-snapshot.js");

describe("findSoleFilePath", () => {
  it("returns the path of the single file entry", () => {
    const lsOutput = [
      { struct_type: "snapshot" },
      { type: "dir", path: "/" },
      { type: "file", path: "/karol115-2026-08-09T00-00-00-000Z.sql" },
    ];
    expect(findSoleFilePath(lsOutput)).toBe("/karol115-2026-08-09T00-00-00-000Z.sql");
  });

  it("throws when there are no file entries", () => {
    expect(() => findSoleFilePath([{ type: "dir", path: "/" }])).toThrow(/found 0/);
  });

  it("throws when there's more than one file entry (not a --stdin backup)", () => {
    expect(() =>
      findSoleFilePath([
        { type: "file", path: "/a.txt" },
        { type: "file", path: "/b.txt" },
      ]),
    ).toThrow(/found 2/);
  });
});

describe("MYSQL_IMPORT_SPEC", () => {
  it("parses SHOW TABLES output into table names", () => {
    expect(MYSQL_IMPORT_SPEC.parseTableNames("users\norders\n")).toEqual(["users", "orders"]);
  });

  it("builds a DROP TABLE statement per existing table, guarded by FOREIGN_KEY_CHECKS=0", () => {
    const args = MYSQL_IMPORT_SPEC.buildDropArgs("mysql.mikr.us", 3306, "wanda192", "db_wanda192", [
      "users",
      "orders",
    ]);
    const sql = args[args.indexOf("-e") + 1];
    expect(sql).toBe(
      "SET FOREIGN_KEY_CHECKS=0; DROP TABLE IF EXISTS `users`; DROP TABLE IF EXISTS `orders`;",
    );
  });

  it("never emits a DROP for a table when the list is empty (nothing to drop)", () => {
    const args = MYSQL_IMPORT_SPEC.buildDropArgs("mysql.mikr.us", 3306, "wanda192", "db_wanda192", []);
    const sql = args[args.indexOf("-e") + 1];
    expect(sql).toBe("SET FOREIGN_KEY_CHECKS=0; ");
  });
});

describe("PSQL_IMPORT_SPEC", () => {
  it("parses table-listing output into qualified names", () => {
    expect(PSQL_IMPORT_SPEC.parseTableNames("public.users\nclassycash.ledger\n")).toEqual([
      "public.users",
      "classycash.ledger",
    ]);
  });

  it("builds a CASCADE drop per existing table", () => {
    const args = PSQL_IMPORT_SPEC.buildDropArgs("psql01.mikr.us", 5432, "wanda192", "db_wanda192", [
      "public.users",
      "classycash.ledger",
    ]);
    const sql = args[args.indexOf("-c") + 1];
    expect(sql).toBe(
      "DROP TABLE IF EXISTS public.users CASCADE; DROP TABLE IF EXISTS classycash.ledger CASCADE;",
    );
  });

  it("fails fast on any SQL error rather than continuing partway through an import", () => {
    expect(PSQL_IMPORT_SPEC.buildImportArgs("psql01.mikr.us", 5432, "wanda192", "db_wanda192")).toEqual(
      expect.arrayContaining(["-v", "ON_ERROR_STOP=1"]),
    );
  });
});

describe("restoreSnapshot > files targets", () => {
  beforeEach(() => {
    loadConfigMock.mockReturnValue({ restic: { backend: "local", repository: "/storage/backup" } });
    buildResticEnvMock.mockReturnValue({ RESTIC_REPOSITORY: "/storage/backup", RESTIC_PASSWORD: "secret" });
    secretsResolveMock.mockReturnValue("resolved-secret");
    ensureRemoteResticInstalledMock.mockResolvedValue({ resticPath: "/home/user/.baktime/bin/restic", action: "already-installed" });
    discoverTargetsMock.mockReturnValue({
      errors: [],
      targets: [
        {
          type: "files",
          name: "wanda-vps-local",
          host: "wanda192.mikrus.xyz",
          sshUser: "root",
          sshPort: 10192,
          sshKeySecretName: "BAKTIME_TARGET_WANDA_VPS_LOCAL_SSH_KEY",
          paths: ["/opt/projects", "/cytrus"],
          schedule: "0 2 * * *",
        },
      ],
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("restores into a staging directory rather than in place, and never touches a DB client", async () => {
    runRemoteCommandMock
      .mockResolvedValueOnce({ stdout: JSON.stringify([{ short_id: "abc1234" }]), stderr: "" }) // snapshots
      .mockResolvedValueOnce({ stdout: "", stderr: "" }); // restore

    await restoreSnapshot("wanda-vps-local", "wanda-vps-local");

    expect(runRemoteCommandMock).toHaveBeenCalledTimes(2);
    expect(runRemoteCommandMock).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.anything(),
      ["restore", "abc1234", "--target", "/storage/restore/wanda-vps-local-abc1234"],
      expect.anything(),
    );
  });

  it("throws a clear error when no snapshot matches the tag, instead of restoring nothing", async () => {
    runRemoteCommandMock.mockResolvedValueOnce({ stdout: "[]", stderr: "" });

    await expect(restoreSnapshot("wanda-vps-local", "wanda-vps-local")).rejects.toThrow(
      /No snapshot found tagged "wanda-vps-local"/,
    );
    expect(runRemoteCommandMock).toHaveBeenCalledTimes(1); // never attempts the restore itself
  });
});
