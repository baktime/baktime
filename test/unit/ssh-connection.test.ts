import { readFile, stat } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.fn();
vi.mock("../../src/util/exec.js", () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

const { runRemoteCommand, copyFileToRemote } = await import("../../src/ssh/connection.js");

const target = {
  host: "web1.example.com",
  user: "deploy",
  privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----",
};

afterEach(() => {
  execFileMock.mockReset();
});

describe("runRemoteCommand", () => {
  it("builds the expected ssh argv with default port and a quoted remote command", async () => {
    let capturedKeyPath = "";
    execFileMock.mockImplementation(async (command: string, args: string[]) => {
      capturedKeyPath = args[args.indexOf("-i") + 1] ?? "";
      return { stdout: "ok", stderr: "" };
    });

    const result = await runRemoteCommand(target, "restic", ["backup", "/var/www"]);

    expect(result.stdout).toBe("ok");
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [command, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(command).toBe("ssh");
    expect(args).toContain("-p");
    expect(args[args.indexOf("-p") + 1]).toBe("22");
    expect(args).toContain("deploy@web1.example.com");
    expect(args.at(-1)).toBe("'restic' 'backup' '/var/www'");
    expect(capturedKeyPath).toMatch(/baktime-ssh-.*[/\\]id$/);
  });

  it("uses a custom port when provided", async () => {
    execFileMock.mockResolvedValue({ stdout: "", stderr: "" });
    await runRemoteCommand({ ...target, port: 2222 }, "restic", ["version"]);
    const [, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(args[args.indexOf("-p") + 1]).toBe("2222");
  });

  it("writes the private key to a 0600 temp file and removes it afterwards", async () => {
    let keyPathDuringCall = "";
    let keyContentsDuringCall = "";
    execFileMock.mockImplementation(async (_command: string, args: string[]) => {
      keyPathDuringCall = args[args.indexOf("-i") + 1] ?? "";
      keyContentsDuringCall = await readFile(keyPathDuringCall, "utf8");
      const mode = (await stat(keyPathDuringCall)).mode & 0o777;
      expect(mode).toBe(0o600);
      return { stdout: "", stderr: "" };
    });

    await runRemoteCommand(target, "restic", ["version"]);

    expect(keyContentsDuringCall).toBe(`${target.privateKey}\n`);
    await expect(stat(keyPathDuringCall)).rejects.toThrow();
  });

  it("cleans up the temp key file even when the remote command fails", async () => {
    let keyPathDuringCall = "";
    execFileMock.mockImplementation(async (_command: string, args: string[]) => {
      keyPathDuringCall = args[args.indexOf("-i") + 1] ?? "";
      throw new Error("ssh: connection refused");
    });

    await expect(runRemoteCommand(target, "restic", ["version"])).rejects.toThrow(
      "connection refused",
    );
    await expect(stat(keyPathDuringCall)).rejects.toThrow();
  });

  it("prefixes the remote command with env assignments when env is provided", async () => {
    execFileMock.mockResolvedValue({ stdout: "", stderr: "" });
    await runRemoteCommand(target, "restic", ["backup", "/var/www"], {
      env: { RESTIC_PASSWORD: "hunter2" },
    });
    const [, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(args.at(-1)).toBe("RESTIC_PASSWORD='hunter2' 'restic' 'backup' '/var/www'");
  });

  it("rejects an unsafe argument before ever invoking ssh", async () => {
    await expect(runRemoteCommand(target, "restic", ["backup", "; rm -rf /"])).rejects.toThrow();
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

describe("copyFileToRemote", () => {
  it("builds the expected scp argv", async () => {
    execFileMock.mockResolvedValue({ stdout: "", stderr: "" });
    await copyFileToRemote(target, "/tmp/local-restic", "/home/deploy/.baktime/bin/restic");
    const [command, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(command).toBe("scp");
    expect(args).toContain("-P");
    expect(args.at(-2)).toBe("/tmp/local-restic");
    expect(args.at(-1)).toBe("deploy@web1.example.com:/home/deploy/.baktime/bin/restic");
  });
});
