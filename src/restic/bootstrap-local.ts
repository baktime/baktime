import { createHash } from "node:crypto";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "../util/exec.js";
import { DEFAULT_RESTIC_VERSION, parseSha256Sums, resticArchFor, verifyChecksum } from "./bootstrap-remote.js";

export { DEFAULT_RESTIC_VERSION };

const RESTIC_RELEASES_BASE = "https://github.com/restic/restic/releases/download";

export interface LocalResticPaths {
  installDir: string;
  resticPath: string;
}

export function resolveLocalResticPaths(home: string = homedir()): LocalResticPaths {
  const installDir = join(home, ".baktime", "bin");
  return { installDir, resticPath: join(installDir, "restic") };
}

async function installedLocalResticVersion(resticPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFile(resticPath, ["version"]);
    return /restic\s+(\S+)/.exec(stdout)?.[1] ?? null;
  } catch {
    return null;
  }
}

export interface LocalBootstrapResult {
  version: string;
  action: "already-installed" | "installed";
  resticPath: string;
}

export interface EnsureLocalResticOptions {
  version?: string;
  /** Injectable for tests; defaults to the global fetch (Node 20+). */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to the real home directory. */
  home?: string;
}

/**
 * Local counterpart to bootstrap-remote.ts's `ensureRemoteResticInstalled`:
 * installs a verified, pinned restic binary at `~/.baktime/bin/restic` on
 * *this* machine — restic isn't preinstalled on GitHub-hosted runners, and
 * every run needs it locally at least once for `ensureRepositoryInitialized`,
 * plus always for database targets (whose dumps stream into
 * `restic backup --stdin` on the runner itself, never remotely).
 *
 * Unlike the remote version, this doesn't need to shell out for networking
 * or hashing: since the bytes are already landing locally, `fetch` and
 * `node:crypto` handle the download and SHA256 verification directly,
 * leaving `bunzip2` as the only external dependency (Node's zlib doesn't
 * support bzip2).
 */
export async function ensureLocalResticInstalled(
  options: EnsureLocalResticOptions = {},
): Promise<LocalBootstrapResult> {
  const version = options.version ?? DEFAULT_RESTIC_VERSION;
  const doFetch = options.fetchImpl ?? fetch;
  const { installDir, resticPath } = resolveLocalResticPaths(options.home);

  const currentVersion = await installedLocalResticVersion(resticPath);
  if (currentVersion === version) {
    return { version, action: "already-installed", resticPath };
  }

  const { stdout: machineStdout } = await execFile("uname", ["-m"]);
  const arch = resticArchFor(machineStdout.trim());

  const releaseBase = `${RESTIC_RELEASES_BASE}/v${version}`;
  const archiveFilename = `restic_${version}_${arch}.bz2`;

  const sumsResponse = await doFetch(`${releaseBase}/SHA256SUMS`);
  if (!sumsResponse.ok) {
    throw new Error(`Failed to fetch restic SHA256SUMS for v${version}: HTTP ${sumsResponse.status}`);
  }
  const sums = parseSha256Sums(await sumsResponse.text());

  const archiveResponse = await doFetch(`${releaseBase}/${archiveFilename}`);
  if (!archiveResponse.ok) {
    throw new Error(
      `Failed to download restic v${version} for ${arch}: HTTP ${archiveResponse.status}`,
    );
  }
  const archiveBuffer = Buffer.from(await archiveResponse.arrayBuffer());
  const actualHash = createHash("sha256").update(archiveBuffer).digest("hex");
  verifyChecksum(sums, archiveFilename, actualHash);

  await mkdir(installDir, { recursive: true });
  const archivePath = join(installDir, archiveFilename);
  await writeFile(archivePath, archiveBuffer);

  await execFile("bunzip2", ["-f", archivePath]);
  const decompressedPath = archivePath.slice(0, -".bz2".length);
  await rename(decompressedPath, resticPath);
  await chmod(resticPath, 0o755);

  return { version, action: "installed", resticPath };
}
