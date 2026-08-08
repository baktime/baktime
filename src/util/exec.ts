import { execFile as execFileCb, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFileCb);

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
}

export class ExecError extends Error {
  constructor(
    public readonly command: string,
    public readonly args: readonly string[],
    public readonly exitCode: number | null,
    public readonly stdout: string,
    public readonly stderr: string,
  ) {
    super(`Command failed (exit ${exitCode}): ${command} ${args.join(" ")}\n${stderr || stdout}`);
    this.name = "ExecError";
  }
}

/**
 * The single choke point for invoking external processes (ssh, restic,
 * mysqldump, pg_dump, ...). Always takes an argument array, never a shell
 * string — nothing else in the codebase is allowed to call `child_process`
 * directly, so this is the one place the "no shell interpolation" invariant
 * has to hold.
 */
export async function execFile(
  command: string,
  args: readonly string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args as string[], {
      env: options.env,
      cwd: options.cwd,
      timeout: options.timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { stdout, stderr };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    throw new ExecError(
      command,
      args,
      typeof err.code === "number" ? err.code : null,
      err.stdout ?? "",
      err.stderr ?? String(err.message ?? error),
    );
  }
}

export interface PipelineProcessSpec {
  command: string;
  args: readonly string[];
  env?: NodeJS.ProcessEnv;
}

export interface PipelineResult {
  /** The consumer's stdout (e.g. restic's `--json` summary). */
  stdout: string;
  stderr: string;
}

/**
 * Runs `producer | consumer` without a shell: the producer's stdout is
 * piped directly into the consumer's stdin via Node streams. Used for
 * `mysqldump`/`pg_dump` -> `restic backup --stdin`, so a large dump is
 * never buffered whole in memory and never passes through a shell pipe.
 * Rejects with whichever process's `ExecError` explains the failure; if the
 * producer fails, the consumer is killed rather than left reading a partial,
 * silently-truncated stream.
 */
export function spawnPipeline(
  producer: PipelineProcessSpec,
  consumer: PipelineProcessSpec,
): Promise<PipelineResult> {
  return new Promise((resolve, reject) => {
    const producerProc = spawn(producer.command, producer.args as string[], {
      env: producer.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const consumerProc = spawn(consumer.command, consumer.args as string[], {
      env: consumer.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let producerStderr = "";
    let consumerStdout = "";
    let consumerStderr = "";
    producerProc.stderr?.on("data", (chunk: Buffer) => {
      producerStderr += chunk.toString();
    });
    consumerProc.stdout?.on("data", (chunk: Buffer) => {
      consumerStdout += chunk.toString();
    });
    consumerProc.stderr?.on("data", (chunk: Buffer) => {
      consumerStderr += chunk.toString();
    });

    producerProc.stdout?.pipe(consumerProc.stdin!);

    let settled = false;
    let producerFailure: ExecError | null = null;

    function settleReject(error: Error): void {
      if (settled) return;
      settled = true;
      producerProc.kill();
      consumerProc.kill();
      reject(error);
    }

    producerProc.on("error", (error) => {
      settleReject(new ExecError(producer.command, producer.args, null, "", error.message));
    });
    consumerProc.on("error", (error) => {
      settleReject(new ExecError(consumer.command, consumer.args, null, "", error.message));
    });

    producerProc.on("close", (code) => {
      if (code !== 0) {
        producerFailure = new ExecError(producer.command, producer.args, code, "", producerStderr);
        // The consumer's stdin won't naturally end if the producer died
        // mid-stream without closing its stdout — make sure it doesn't hang
        // forever waiting for input that will never arrive.
        consumerProc.kill();
      }
    });

    consumerProc.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (producerFailure) {
        reject(producerFailure);
        return;
      }
      if (code !== 0) {
        reject(new ExecError(consumer.command, consumer.args, code, consumerStdout, consumerStderr));
        return;
      }
      resolve({ stdout: consumerStdout, stderr: consumerStderr });
    });
  });
}
