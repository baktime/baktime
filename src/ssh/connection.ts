import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, type ExecResult } from "../util/exec.js";
import { buildRemoteCommand } from "./shell-quote.js";

export interface SshTarget {
  host: string;
  user: string;
  port?: number;
  /** Resolved secret value (PEM-format private key) — never logged, only ever written to a 0600 temp file. */
  privateKey: string;
}

/**
 * Shells out to the system `ssh`/`scp` binaries (already present on
 * GitHub-hosted runners) via `execFile`, rather than reimplementing the SSH
 * protocol in a library — this reuses OpenSSH's own host-key handling,
 * `ProxyJump`, and algorithm negotiation for free. `execFile` never invokes
 * a local shell, so these argv arrays are never subject to local shell
 * interpolation; the one unavoidable shell string is the *remote* command,
 * built with ssh/shell-quote.ts.
 */
const DEFAULT_SSH_OPTIONS = [
  "-o",
  "StrictHostKeyChecking=accept-new",
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=15",
];

async function withPrivateKeyFile<T>(
  privateKey: string,
  fn: (keyPath: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "baktime-ssh-"));
  const keyPath = join(dir, "id");
  try {
    const pem = privateKey.endsWith("\n") ? privateKey : `${privateKey}\n`;
    await writeFile(keyPath, pem, { mode: 0o600 });
    return await fn(keyPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Runs one command on the remote host, over SSH, using a temporary key file cleaned up in a `finally`. */
export async function runRemoteCommand(
  target: SshTarget,
  command: string,
  args: readonly string[],
): Promise<ExecResult> {
  const remoteCommand = buildRemoteCommand(command, args);
  return withPrivateKeyFile(target.privateKey, (keyPath) =>
    execFile("ssh", [
      ...DEFAULT_SSH_OPTIONS,
      "-i",
      keyPath,
      "-p",
      String(target.port ?? 22),
      `${target.user}@${target.host}`,
      remoteCommand,
    ]),
  );
}

/** Copies one local file to the remote host via scp, using a temporary key file cleaned up in a `finally`. */
export async function copyFileToRemote(
  target: SshTarget,
  localPath: string,
  remotePath: string,
): Promise<ExecResult> {
  return withPrivateKeyFile(target.privateKey, (keyPath) =>
    execFile("scp", [
      ...DEFAULT_SSH_OPTIONS,
      "-i",
      keyPath,
      "-P",
      String(target.port ?? 22),
      localPath,
      `${target.user}@${target.host}:${remotePath}`,
    ]),
  );
}
