import { execFile as execFileCb } from "node:child_process";
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
