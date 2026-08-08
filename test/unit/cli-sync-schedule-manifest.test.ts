import { afterEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.fn();
vi.mock("../../src/util/exec.js", () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

const { buildScheduleManifest, syncScheduleManifest } = await import(
  "../../src/cli/sync-schedule-manifest.js"
);

describe("buildScheduleManifest", () => {
  it("projects targets down to name/type/schedule only, sorted by name", () => {
    const manifest = buildScheduleManifest([
      { name: "webserver1", type: "files", schedule: "0 3 * * *" },
      { name: "analytics-db", type: "postgres", schedule: "0 2 * * *" },
    ]);

    expect(manifest).toEqual([
      { name: "analytics-db", type: "postgres", schedule: "0 2 * * *" },
      { name: "webserver1", type: "files", schedule: "0 3 * * *" },
    ]);
  });

  it("never includes host/path/credential fields even if present on the input object", () => {
    const manifest = buildScheduleManifest([
      {
        name: "webserver1",
        type: "files",
        schedule: "0 3 * * *",
        // @ts-expect-error -- extra fields a real NamedTarget carries, deliberately not part of the type
        host: "web1.example.com",
        sshKeySecretName: "SECRET",
      },
    ]);
    expect(Object.keys(manifest[0]!)).toEqual(["name", "type", "schedule"]);
  });
});

const filesTargetJson = JSON.stringify({
  type: "files",
  host: "web1.example.com",
  sshUser: "deploy",
  sshKeySecretName: "BAKTIME_TARGET_WEBSERVER1_SSH_KEY",
  paths: ["/var/www"],
  schedule: "0 3 * * *",
});

afterEach(() => {
  execFileMock.mockReset();
});

describe("syncScheduleManifest", () => {
  it("invokes wrangler kv key put with the configured binding/config path", async () => {
    process.env.BAKTIME_SECRETS_JSON = JSON.stringify({
      BAKTIME_TARGET_WEBSERVER1: filesTargetJson,
      BAKTIME_TARGET_WEBSERVER1_SSH_KEY: "fake-key",
    });
    execFileMock.mockResolvedValue({ stdout: "", stderr: "" });

    const manifest = await syncScheduleManifest({
      wranglerConfigPath: "cloudflare-worker/wrangler.toml",
      kvBindingName: "BAKTIME_SCHEDULES",
      kvKey: "manifest",
    });

    expect(manifest).toEqual([{ name: "webserver1", type: "files", schedule: "0 3 * * *" }]);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [command, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(command).toBe("npx");
    expect(args).toEqual([
      "wrangler",
      "kv",
      "key",
      "put",
      "--binding",
      "BAKTIME_SCHEDULES",
      "--config",
      "cloudflare-worker/wrangler.toml",
      "--remote",
      "manifest",
      JSON.stringify(manifest),
    ]);

    delete process.env.BAKTIME_SECRETS_JSON;
  });
});
