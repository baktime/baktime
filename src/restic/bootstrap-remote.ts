import { runRemoteCommand, type SshTarget } from "../ssh/connection.js";

/**
 * Pinned deliberately — bumped only after verifying a real bootstrap run
 * against a real host, not automatically on every restic release.
 */
export const DEFAULT_RESTIC_VERSION = "0.19.1";

const RESTIC_RELEASES_BASE = "https://github.com/restic/restic/releases/download";

export class UnsupportedArchitectureError extends Error {
  constructor(public readonly machine: string) {
    super(`Unsupported remote architecture "${machine}" — no known restic release for it`);
    this.name = "UnsupportedArchitectureError";
  }
}

const UNAME_TO_RESTIC_ARCH: Record<string, string> = {
  x86_64: "amd64",
  aarch64: "arm64",
  armv7l: "arm",
};

export function resticArchFor(unameMachine: string): string {
  const arch = UNAME_TO_RESTIC_ARCH[unameMachine];
  if (!arch) {
    throw new UnsupportedArchitectureError(unameMachine);
  }
  return `linux_${arch}`;
}

/**
 * Parses a restic `SHA256SUMS` release asset: one `<hex-sha256>  <filename>`
 * pair per line (some `sha256sum` implementations prefix the filename with
 * `*` for binary mode — tolerated here too). Pure and network-free so it can
 * be tested directly against fixture text, including tampered content.
 */
export function parseSha256Sums(content: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line);
    if (match?.[1] && match[2]) {
      sums.set(match[2], match[1].toLowerCase());
    }
  }
  return sums;
}

export class ChecksumNotFoundError extends Error {
  constructor(public readonly filename: string) {
    super(`No checksum entry for "${filename}" in SHA256SUMS`);
    this.name = "ChecksumNotFoundError";
  }
}

export class ChecksumMismatchError extends Error {
  constructor(
    public readonly filename: string,
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(`SHA256 mismatch for "${filename}": expected ${expected}, got ${actual} — refusing to install`);
    this.name = "ChecksumMismatchError";
  }
}

/** Throws unless `actualHashHex` matches the published checksum for `filename`. Never silently degrades. */
export function verifyChecksum(
  sums: ReadonlyMap<string, string>,
  filename: string,
  actualHashHex: string,
): void {
  const expected = sums.get(filename);
  if (!expected) {
    throw new ChecksumNotFoundError(filename);
  }
  if (expected !== actualHashHex.toLowerCase()) {
    throw new ChecksumMismatchError(filename, expected, actualHashHex.toLowerCase());
  }
}

export interface RemoteResticPaths {
  home: string;
  installDir: string;
  resticPath: string;
}

export async function resolveRemoteResticPaths(target: SshTarget): Promise<RemoteResticPaths> {
  const { stdout } = await runRemoteCommand(target, "printenv", ["HOME"]);
  const home = stdout.trim();
  if (!home) {
    throw new Error("Could not determine the remote user's $HOME directory");
  }
  const installDir = `${home}/.baktime/bin`;
  return { home, installDir, resticPath: `${installDir}/restic` };
}

async function installedResticVersion(
  target: SshTarget,
  resticPath: string,
): Promise<string | null> {
  try {
    const { stdout } = await runRemoteCommand(target, resticPath, ["version"]);
    return /restic\s+(\S+)/.exec(stdout)?.[1] ?? null;
  } catch {
    return null;
  }
}

export interface BootstrapResult {
  version: string;
  action: "already-installed" | "installed";
  resticPath: string;
}

export interface EnsureRemoteResticOptions {
  version?: string;
  /** Injectable for tests; defaults to the global fetch (Node 20+). */
  fetchImpl?: typeof fetch;
}

/**
 * Ensures a working, verified restic binary is present at
 * `~/.baktime/bin/restic` on the target host — no root, no package manager.
 * restic's official Linux releases are static Go binaries (no libc
 * dependency), so the same asset works on both Alpine (musl) and glibc
 * hosts. The (large) binary archive is downloaded and hashed on the remote
 * host itself, so its bytes never transit the GitHub Actions runner; only
 * the small `SHA256SUMS` text file is fetched locally to keep checksum
 * parsing pure and unit-testable.
 */
export async function ensureRemoteResticInstalled(
  target: SshTarget,
  options: EnsureRemoteResticOptions = {},
): Promise<BootstrapResult> {
  const version = options.version ?? DEFAULT_RESTIC_VERSION;
  const doFetch = options.fetchImpl ?? fetch;

  const { home, installDir, resticPath } = await resolveRemoteResticPaths(target);

  const currentVersion = await installedResticVersion(target, resticPath);
  if (currentVersion === version) {
    return { version, action: "already-installed", resticPath };
  }

  const { stdout: machineStdout } = await runRemoteCommand(target, "uname", ["-m"]);
  const arch = resticArchFor(machineStdout.trim());

  const releaseBase = `${RESTIC_RELEASES_BASE}/v${version}`;
  const archiveFilename = `restic_${version}_${arch}.bz2`;

  const sumsResponse = await doFetch(`${releaseBase}/SHA256SUMS`);
  if (!sumsResponse.ok) {
    throw new Error(`Failed to fetch restic SHA256SUMS for v${version}: HTTP ${sumsResponse.status}`);
  }
  const sums = parseSha256Sums(await sumsResponse.text());

  const tmpDir = `${home}/.baktime/tmp`;
  const archivePath = `${tmpDir}/${archiveFilename}`;

  try {
    await runRemoteCommand(target, "mkdir", ["-p", installDir, tmpDir]);
    await runRemoteCommand(target, "curl", [
      "-fsSL",
      "-o",
      archivePath,
      `${releaseBase}/${archiveFilename}`,
    ]);

    const { stdout: shaStdout } = await runRemoteCommand(target, "sha256sum", [archivePath]);
    const actualHash = shaStdout.trim().split(/\s+/)[0] ?? "";
    verifyChecksum(sums, archiveFilename, actualHash);

    await runRemoteCommand(target, "bunzip2", ["-f", archivePath]);
    const decompressedPath = archivePath.slice(0, -".bz2".length);
    await runRemoteCommand(target, "mv", [decompressedPath, resticPath]);
    await runRemoteCommand(target, "chmod", ["+x", resticPath]);
  } finally {
    await runRemoteCommand(target, "rm", ["-rf", tmpDir]).catch(() => {
      // best-effort cleanup only; a leftover tmp dir isn't worth failing the whole bootstrap over
    });
  }

  return { version, action: "installed", resticPath };
}
