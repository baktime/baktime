import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.fn();
vi.mock("../../src/util/exec.js", () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

const { ensureLocalResticInstalled, resolveLocalResticPaths } = await import(
  "../../src/restic/bootstrap-local.js"
);
const { ChecksumMismatchError, UnsupportedArchitectureError } = await import(
  "../../src/restic/bootstrap-remote.js"
);

const FAKE_BINARY_CONTENT = "not a real restic binary, just test fixture bytes";
const FAKE_ARCHIVE_CONTENT = "pretend-this-is-bzip2-compressed-bytes";

function sha256Hex(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function mockFetch(sums: Record<string, string>, archiveContent: string): typeof fetch {
  const sumsText = Object.entries(sums)
    .map(([filename, hash]) => `${hash}  ${filename}`)
    .join("\n");
  return vi.fn(async (url: string | URL) => {
    const href = url.toString();
    if (href.endsWith("SHA256SUMS")) {
      return { ok: true, status: 200, text: () => Promise.resolve(sumsText) } as Response;
    }
    return {
      ok: true,
      status: 200,
      // Buffer.from(str).buffer can point at a larger, pooled ArrayBuffer
      // for small strings — TextEncoder always returns an exactly-sized one.
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode(archiveContent).buffer),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "baktime-local-restic-"));
});

afterEach(async () => {
  execFileMock.mockReset();
  await rm(home, { recursive: true, force: true });
});

describe("resolveLocalResticPaths", () => {
  it("resolves under ~/.baktime/bin", () => {
    const paths = resolveLocalResticPaths("/home/runner");
    expect(paths.installDir).toBe("/home/runner/.baktime/bin");
    expect(paths.resticPath).toBe("/home/runner/.baktime/bin/restic");
  });
});

describe("ensureLocalResticInstalled", () => {
  it("skips installation when the exact pinned version is already present", async () => {
    execFileMock.mockImplementation(async (command: string, args: string[]) => {
      if (command.endsWith("/restic") && args[0] === "version") {
        return { stdout: "restic 0.19.1 compiled with go1.23 on linux/amd64\n", stderr: "" };
      }
      throw new Error(`unexpected: ${command} ${args.join(" ")}`);
    });

    const result = await ensureLocalResticInstalled({
      version: "0.19.1",
      home,
      fetchImpl: mockFetch({}, ""),
    });

    expect(result).toEqual({
      version: "0.19.1",
      action: "already-installed",
      resticPath: join(home, ".baktime", "bin", "restic"),
    });
  });

  it("downloads, verifies (via node:crypto, no network for hashing), and installs when missing", async () => {
    const archiveFilename = "restic_0.19.1_linux_amd64.bz2";
    const goodHash = sha256Hex(FAKE_ARCHIVE_CONTENT);

    execFileMock.mockImplementation(async (command: string, args: string[]) => {
      if (command.endsWith("/restic") && args[0] === "version") {
        throw new Error("no such file");
      }
      if (command === "uname") {
        return { stdout: "x86_64\n", stderr: "" };
      }
      if (command === "bunzip2") {
        // Simulate real bunzip2's effect: replace the .bz2 with its decompressed contents.
        const archivePath = args[1] as string;
        const decompressedPath = archivePath.slice(0, -".bz2".length);
        await writeFile(decompressedPath, FAKE_BINARY_CONTENT);
        return { stdout: "", stderr: "" };
      }
      throw new Error(`unexpected: ${command} ${args.join(" ")}`);
    });

    const result = await ensureLocalResticInstalled({
      version: "0.19.1",
      home,
      fetchImpl: mockFetch({ [archiveFilename]: goodHash }, FAKE_ARCHIVE_CONTENT),
    });

    expect(result.action).toBe("installed");
    expect(result.resticPath).toBe(join(home, ".baktime", "bin", "restic"));

    const installed = await readFile(result.resticPath, "utf8");
    expect(installed).toBe(FAKE_BINARY_CONTENT);
    const mode = (await stat(result.resticPath)).mode & 0o777;
    expect(mode).toBe(0o755);
  });

  it("refuses to install when the downloaded archive's hash doesn't match SHA256SUMS", async () => {
    const archiveFilename = "restic_0.19.1_linux_amd64.bz2";

    execFileMock.mockImplementation(async (command: string, args: string[]) => {
      if (command.endsWith("/restic") && args[0] === "version") {
        throw new Error("no such file");
      }
      if (command === "uname") {
        return { stdout: "x86_64\n", stderr: "" };
      }
      throw new Error(`unexpected call that shouldn't happen: ${command} ${args.join(" ")}`);
    });

    await expect(
      ensureLocalResticInstalled({
        version: "0.19.1",
        home,
        fetchImpl: mockFetch({ [archiveFilename]: "0".repeat(64) }, FAKE_ARCHIVE_CONTENT),
      }),
    ).rejects.toThrow(ChecksumMismatchError);

    // Must never reach bunzip2/install for an unverified download.
    expect(execFileMock).not.toHaveBeenCalledWith("bunzip2", expect.anything());
  });

  it("rejects an unsupported local architecture rather than guessing", async () => {
    execFileMock.mockImplementation(async (command: string, args: string[]) => {
      if (command.endsWith("/restic") && args[0] === "version") {
        throw new Error("no such file");
      }
      if (command === "uname") {
        return { stdout: "sparc64\n", stderr: "" };
      }
      throw new Error(`unexpected: ${command} ${args.join(" ")}`);
    });

    await expect(
      ensureLocalResticInstalled({ version: "0.19.1", home, fetchImpl: mockFetch({}, "") }),
    ).rejects.toThrow(UnsupportedArchitectureError);
  });
});
