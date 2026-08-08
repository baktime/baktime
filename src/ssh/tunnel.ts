import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SshTarget } from "./connection.js";

export interface SshTunnel {
  localPort: number;
  close(): Promise<void>;
}

export interface OpenTunnelOptions {
  /** How long to wait for the tunnel to become ready before giving up. */
  readyTimeoutMs?: number;
}

/** Binds to an OS-assigned free port, then releases it — the standard (if inherently slightly racy) way to reserve a local port for a subprocess to bind next. */
export function findFreeLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address && typeof address === "object") {
        const port = address.port;
        probe.close(() => resolve(port));
      } else {
        probe.close(() => reject(new Error("could not determine a free local port")));
      }
    });
  });
}

function connectOnce(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port }, () => {
      socket.end();
      resolve();
    });
    socket.on("error", reject);
  });
}

async function waitForTunnelReady(
  port: number,
  timeoutMs: number,
  hasExited: () => boolean,
  getExitError: () => Error | null,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (hasExited()) {
      throw getExitError() ?? new Error("SSH tunnel process exited before becoming ready");
    }
    try {
      await connectOnce(port);
      return;
    } catch {
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for the SSH tunnel on local port ${port} to become ready`);
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
  }
}

/**
 * Opens `ssh -N -L <localPort>:<remoteHost>:<remotePort>` through a jump
 * host, for reaching a database that's only reachable from a box you
 * already have SSH access to (not directly from the GitHub Actions
 * runner). The private key is written to a 0600 temp file that persists
 * for the tunnel's lifetime and is removed by `close()` — unlike
 * ssh/connection.ts's one-shot commands, a tunnel has to outlive the single
 * call that opens it.
 */
export async function openTunnel(
  jumpTarget: SshTarget,
  remoteHost: string,
  remotePort: number,
  options: OpenTunnelOptions = {},
): Promise<SshTunnel> {
  const localPort = await findFreeLocalPort();
  const dir = await mkdtemp(join(tmpdir(), "baktime-tunnel-"));
  const keyPath = join(dir, "id");
  const pem = jumpTarget.privateKey.endsWith("\n") ? jumpTarget.privateKey : `${jumpTarget.privateKey}\n`;
  await writeFile(keyPath, pem, { mode: 0o600 });

  const child: ChildProcess = spawn("ssh", [
    "-N",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ConnectTimeout=15",
    "-i",
    keyPath,
    "-p",
    String(jumpTarget.port ?? 22),
    "-L",
    `${localPort}:${remoteHost}:${remotePort}`,
    `${jumpTarget.user}@${jumpTarget.host}`,
  ]);

  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  let exited = false;
  let exitError: Error | null = null;
  child.on("exit", (code) => {
    exited = true;
    if (code !== 0) {
      exitError = new Error(`SSH tunnel exited early (code ${code}): ${stderr}`);
    }
  });
  child.on("error", (error) => {
    exited = true;
    exitError = error;
  });

  const close = async (): Promise<void> => {
    if (!child.killed && child.exitCode === null) {
      child.kill();
    }
    await rm(dir, { recursive: true, force: true });
  };

  try {
    await waitForTunnelReady(
      localPort,
      options.readyTimeoutMs ?? 10_000,
      () => exited,
      () => exitError,
    );
  } catch (error) {
    await close();
    throw error;
  }

  return { localPort, close };
}
