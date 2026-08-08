import { afterEach, describe, expect, it, vi } from "vitest";

const runRemoteCommandMock = vi.fn();
vi.mock("../../src/ssh/connection.js", () => ({
  runRemoteCommand: (...args: unknown[]) => runRemoteCommandMock(...args),
}));

const {
  ChecksumMismatchError,
  ChecksumNotFoundError,
  UnsupportedArchitectureError,
  ensureRemoteResticInstalled,
  parseSha256Sums,
  resticArchFor,
  verifyChecksum,
} = await import("../../src/restic/bootstrap-remote.js");

const REAL_SHA256SUMS = `bb9b1a19040744d26d8a79be029d4e6b189c45ccc9d8831d7fe367d3c33df725  restic-0.19.1.tar.gz
c9d1b1e5f6a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8  restic_0.19.1_linux_amd64.bz2
d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2  restic_0.19.1_linux_arm64.bz2
`;

describe("resticArchFor", () => {
  it("maps known uname -m outputs to restic release arch suffixes", () => {
    expect(resticArchFor("x86_64")).toBe("linux_amd64");
    expect(resticArchFor("aarch64")).toBe("linux_arm64");
    expect(resticArchFor("armv7l")).toBe("linux_arm");
  });

  it("rejects an unknown architecture rather than guessing", () => {
    expect(() => resticArchFor("sparc64")).toThrow(UnsupportedArchitectureError);
  });
});

describe("parseSha256Sums", () => {
  it("parses a real-shaped SHA256SUMS file into a filename -> hash map", () => {
    const sums = parseSha256Sums(REAL_SHA256SUMS);
    expect(sums.get("restic_0.19.1_linux_amd64.bz2")).toBe(
      "c9d1b1e5f6a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8",
    );
    expect(sums.size).toBe(3);
  });

  it("lowercases hashes and tolerates a leading '*' binary-mode marker", () => {
    const hash = "AABBCC00".padEnd(64, "0");
    const sums = parseSha256Sums(`${hash}  *restic_0.19.1_linux_arm.bz2\n`);
    expect(sums.get("restic_0.19.1_linux_arm.bz2")).toBe(hash.toLowerCase());
  });

  it("ignores blank lines and malformed lines instead of throwing", () => {
    const sums = parseSha256Sums("\n\nnot a valid line\nshort-hash  file.bz2\n");
    expect(sums.size).toBe(0);
  });
});

describe("verifyChecksum", () => {
  const sums = parseSha256Sums(REAL_SHA256SUMS);

  it("passes when the actual hash matches the published one", () => {
    expect(() =>
      verifyChecksum(
        sums,
        "restic_0.19.1_linux_amd64.bz2",
        "c9d1b1e5f6a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8",
      ),
    ).not.toThrow();
  });

  it("throws ChecksumMismatchError for a tampered/corrupted download", () => {
    expect(() =>
      verifyChecksum(
        sums,
        "restic_0.19.1_linux_amd64.bz2",
        "0000000000000000000000000000000000000000000000000000000000000",
      ),
    ).toThrow(ChecksumMismatchError);
  });

  it("throws ChecksumMismatchError for a maliciously substituted SHA256SUMS entry", () => {
    // Simulates an attacker-controlled SHA256SUMS pointing at their own binary's hash,
    // while the real download's hash (computed independently on the remote host) differs.
    const tamperedSums = parseSha256Sums(`${"1".repeat(64)}  restic_0.19.1_linux_amd64.bz2\n`);
    expect(() =>
      verifyChecksum(
        tamperedSums,
        "restic_0.19.1_linux_amd64.bz2",
        "c9d1b1e5f6a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8",
      ),
    ).toThrow(ChecksumMismatchError);
  });

  it("throws ChecksumNotFoundError when the release omits our platform entirely", () => {
    expect(() => verifyChecksum(sums, "restic_0.19.1_linux_mips.bz2", "aa".repeat(32))).toThrow(
      ChecksumNotFoundError,
    );
  });
});

const target = { host: "web1.example.com", user: "deploy", privateKey: "fake-key" };

function mockFetchReturning(sha256sums: string): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: () => Promise.resolve(sha256sums),
  }) as unknown as typeof fetch;
}

afterEach(() => {
  runRemoteCommandMock.mockReset();
});

describe("ensureRemoteResticInstalled", () => {
  it("skips installation when the exact pinned version is already present", async () => {
    runRemoteCommandMock.mockImplementation(async (_t: unknown, command: string, args: string[]) => {
      if (command === "printenv") return { stdout: "/home/deploy\n", stderr: "" };
      if (command.endsWith("/restic") && args[0] === "version") {
        return { stdout: "restic 0.19.1 compiled with go1.23 on linux/amd64\n", stderr: "" };
      }
      throw new Error(`unexpected remote command: ${command} ${args.join(" ")}`);
    });

    const result = await ensureRemoteResticInstalled(target, {
      version: "0.19.1",
      fetchImpl: mockFetchReturning(""),
    });

    expect(result).toEqual({
      version: "0.19.1",
      action: "already-installed",
      resticPath: "/home/deploy/.baktime/bin/restic",
    });
  });

  it("downloads, verifies, and installs when the version is missing", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const goodHash = "c9d1b1e5f6a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8";

    runRemoteCommandMock.mockImplementation(async (_t: unknown, command: string, args: string[]) => {
      calls.push({ command, args });
      if (command === "printenv") return { stdout: "/home/deploy\n", stderr: "" };
      if (command.endsWith("/restic") && args[0] === "version") {
        throw new Error("no such file"); // not installed yet
      }
      if (command === "uname") return { stdout: "x86_64\n", stderr: "" };
      if (command === "sha256sum") {
        return { stdout: `${goodHash}  /home/deploy/.baktime/tmp/restic_0.19.1_linux_amd64.bz2\n`, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const result = await ensureRemoteResticInstalled(target, {
      version: "0.19.1",
      fetchImpl: mockFetchReturning(REAL_SHA256SUMS),
    });

    expect(result).toEqual({
      version: "0.19.1",
      action: "installed",
      resticPath: "/home/deploy/.baktime/bin/restic",
    });

    const commandNames = calls.map((c) => c.command);
    expect(commandNames).toContain("mkdir");
    expect(commandNames).toContain("curl");
    expect(commandNames).toContain("sha256sum");
    expect(commandNames).toContain("bunzip2");
    expect(commandNames).toContain("mv");
    expect(commandNames).toContain("chmod");
    expect(commandNames).toContain("rm"); // tmp dir cleanup
  });

  it("refuses to install and cleans up when the downloaded archive's hash doesn't match", async () => {
    runRemoteCommandMock.mockImplementation(async (_t: unknown, command: string, args: string[]) => {
      if (command === "printenv") return { stdout: "/home/deploy\n", stderr: "" };
      if (command.endsWith("/restic") && args[0] === "version") {
        throw new Error("no such file");
      }
      if (command === "uname") return { stdout: "x86_64\n", stderr: "" };
      if (command === "sha256sum") {
        return { stdout: "0".repeat(64) + "  archive.bz2\n", stderr: "" }; // wrong hash
      }
      return { stdout: "", stderr: "" };
    });

    await expect(
      ensureRemoteResticInstalled(target, {
        version: "0.19.1",
        fetchImpl: mockFetchReturning(REAL_SHA256SUMS),
      }),
    ).rejects.toThrow(ChecksumMismatchError);

    // Must still clean up the tmp dir even though installation was aborted.
    const rmCalls = runRemoteCommandMock.mock.calls.filter(([, command]) => command === "rm");
    expect(rmCalls).toHaveLength(1);

    // Must never reach the steps that would activate an unverified binary.
    const commandNames = runRemoteCommandMock.mock.calls.map(([, command]) => command);
    expect(commandNames).not.toContain("bunzip2");
    expect(commandNames).not.toContain("mv");
    expect(commandNames).not.toContain("chmod");
  });
});
