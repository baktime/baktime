import { describe, expect, it } from "vitest";
import { buildResticEnv } from "../../src/restic/env.js";
import { SecretsStore } from "../../src/config/secrets.js";

describe("buildResticEnv", () => {
  it("includes AWS_* credentials when the backend config references them", () => {
    const secrets = SecretsStore.fromRecord({
      RESTIC_PASSWORD: "hunter2",
      R2_ACCESS_KEY_ID: "id",
      R2_SECRET_ACCESS_KEY: "secret",
    });

    const env = buildResticEnv(
      {
        backend: "r2",
        repository: "s3:https://example.r2.cloudflarestorage.com/bucket",
        passwordSecretName: "RESTIC_PASSWORD",
        accessKeyIdSecretName: "R2_ACCESS_KEY_ID",
        secretAccessKeySecretName: "R2_SECRET_ACCESS_KEY",
      },
      secrets,
    );

    expect(env).toEqual({
      RESTIC_REPOSITORY: "s3:https://example.r2.cloudflarestorage.com/bucket",
      RESTIC_PASSWORD: "hunter2",
      AWS_ACCESS_KEY_ID: "id",
      AWS_SECRET_ACCESS_KEY: "secret",
    });
  });

  it("omits AWS_* keys entirely for a local backend with no credential secret names", () => {
    const secrets = SecretsStore.fromRecord({ RESTIC_PASSWORD: "hunter2" });

    const env = buildResticEnv(
      {
        backend: "local",
        repository: "/storage/restic-repo",
        passwordSecretName: "RESTIC_PASSWORD",
      },
      secrets,
    );

    expect(env).toEqual({
      RESTIC_REPOSITORY: "/storage/restic-repo",
      RESTIC_PASSWORD: "hunter2",
    });
    expect("AWS_ACCESS_KEY_ID" in env).toBe(false);
    expect("AWS_SECRET_ACCESS_KEY" in env).toBe(false);
  });

  it("never resolves (or requires) credential secrets that aren't referenced", () => {
    // Only RESTIC_PASSWORD exists in the store — resolving an unreferenced
    // AWS_* secret name would throw MissingSecretError if attempted.
    const secrets = SecretsStore.fromRecord({ RESTIC_PASSWORD: "hunter2" });
    expect(() =>
      buildResticEnv(
        { backend: "local", repository: "/storage/restic-repo", passwordSecretName: "RESTIC_PASSWORD" },
        secrets,
      ),
    ).not.toThrow();
  });
});
