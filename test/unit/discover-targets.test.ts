import { beforeEach, describe, expect, it } from "vitest";
import { discoverTargets } from "../../src/config/discover-targets.js";
import { _resetKnownSecretValuesForTests, redactSecrets, SecretsStore } from "../../src/config/secrets.js";

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
  userSecretName: "BAKTIME_TARGET_SHOP_DB_USER",
  passwordSecretName: "BAKTIME_TARGET_SHOP_DB_PASSWORD",
  schedule: "*/30 * * * *",
});

beforeEach(() => {
  _resetKnownSecretValuesForTests();
});

describe("discoverTargets", () => {
  it("finds real target secrets among unrelated secrets and satellite secrets", () => {
    const secrets = SecretsStore.fromRecord({
      BAKTIME_TARGET_WEBSERVER1: filesTargetJson,
      // Satellite secrets sharing the same prefix by convention: raw strings, not JSON objects.
      BAKTIME_TARGET_WEBSERVER1_SSH_KEY: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----",
      BAKTIME_TARGET_SHOP_DB: mysqlTargetJson,
      BAKTIME_TARGET_SHOP_DB_USER: "shop_admin",
      BAKTIME_TARGET_SHOP_DB_PASSWORD: "hunter2",
      // Completely unrelated secrets.
      RESTIC_PASSWORD: "correct-horse-battery-staple",
      R2_ACCESS_KEY_ID: "AKIA...",
      GH_PAT: "ghp_xxx",
    });

    const { targets, errors } = discoverTargets(secrets);

    expect(errors).toEqual([]);
    expect(targets).toHaveLength(2);

    const webserver = targets.find((t) => t.name === "webserver1");
    expect(webserver?.type).toBe("files");

    const shopDb = targets.find((t) => t.name === "shop-db");
    expect(shopDb?.type).toBe("mysql");
  });

  it("does not register satellite or unrelated secret values for redaction", () => {
    const secrets = SecretsStore.fromRecord({
      BAKTIME_TARGET_WEBSERVER1: filesTargetJson,
      BAKTIME_TARGET_WEBSERVER1_SSH_KEY: "TOTALLY-SECRET-KEY-MATERIAL",
    });

    discoverTargets(secrets);

    expect(redactSecrets("here is TOTALLY-SECRET-KEY-MATERIAL in a log line")).toBe(
      "here is TOTALLY-SECRET-KEY-MATERIAL in a log line",
    );
  });

  it("reports (not silently drops) a target secret that fails schema validation", () => {
    const secrets = SecretsStore.fromRecord({
      BAKTIME_TARGET_BROKEN: JSON.stringify({ type: "files", host: "x" /* missing required fields */ }),
    });

    const { targets, errors } = discoverTargets(secrets);

    expect(targets).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("BAKTIME_TARGET_BROKEN");
  });

  it("skips BAKTIME_TARGET_-prefixed secrets that aren't JSON at all", () => {
    const secrets = SecretsStore.fromRecord({
      BAKTIME_TARGET_SOMETHING_RANDOM: "just a plain string, not json",
    });

    const { targets, errors } = discoverTargets(secrets);

    expect(targets).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it("skips JSON secrets under the prefix that aren't target-shaped (no type field)", () => {
    const secrets = SecretsStore.fromRecord({
      BAKTIME_TARGET_NOTES: JSON.stringify({ foo: "bar" }),
    });

    const { targets, errors } = discoverTargets(secrets);

    expect(targets).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it("flags duplicate target names from different secret suffixes and excludes both", () => {
    const secrets = SecretsStore.fromRecord({
      // "SHOP_DB" and "shop_db" both normalize to the target name "shop-db".
      BAKTIME_TARGET_SHOP_DB: mysqlTargetJson,
      BAKTIME_TARGET_shop_db: mysqlTargetJson,
    });

    const { targets, errors } = discoverTargets(secrets);

    expect(targets).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("shop-db");
  });

  it("returns no targets when there are no BAKTIME_TARGET_ secrets at all", () => {
    const secrets = SecretsStore.fromRecord({ RESTIC_PASSWORD: "x" });
    const { targets, errors } = discoverTargets(secrets);
    expect(targets).toEqual([]);
    expect(errors).toEqual([]);
  });
});
