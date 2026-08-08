/**
 * SSH's remote side is always a single shell command string — the one place
 * in the codebase where "argument arrays only" isn't literally possible,
 * since the remote sshd hands our string to the remote user's login shell.
 *
 * Two independent layers keep this safe: (1) POSIX single-quoting, which
 * makes every character *except* a single quote itself completely literal
 * to the shell (semicolons, backticks, `$(...)`, pipes — all inert once
 * quoted), and (2) an allowlist that rejects config-derived values
 * containing shell metacharacters outright before quoting even runs. Layer 2
 * isn't strictly required given correct quoting, but a path or hostname that
 * contains a semicolon or backtick is essentially always a mistake (or an
 * attempt), so rejecting it early is cheap defense-in-depth against a
 * quoting bug or an unusual remote shell.
 */

const UNSAFE_CHARACTERS = /[$`;|&<>\n\r\0]/;

export class UnsafeShellValueError extends Error {
  constructor(public readonly value: string) {
    super(`Value contains characters not allowed in a remote command: ${JSON.stringify(value)}`);
    this.name = "UnsafeShellValueError";
  }
}

export function assertSafeShellValue(value: string): string {
  if (UNSAFE_CHARACTERS.test(value)) {
    throw new UnsafeShellValueError(value);
  }
  return value;
}

/** Pure POSIX single-quote escaping, with no allowlist check: `'` -> `'\''`, wrapped in `'...'`. */
export function shellQuoteRaw(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * POSIX single-quote escaping for config-derived, human-authored values
 * (paths, hostnames, versions) — rejects shell metacharacters outright
 * first, since their presence in a path or hostname is essentially always a
 * mistake. Do **not** use this for secret values: a legitimate high-entropy
 * password may well contain `$`, `;`, or other "unsafe" characters, which
 * are completely safe once single-quoted — use `shellQuoteRaw` for those.
 */
export function shellQuote(value: string): string {
  assertSafeShellValue(value);
  return shellQuoteRaw(value);
}

/**
 * Builds one remote shell command string. Every part is quoted, including
 * `command` — quoting a bare program name (e.g. `restic`) is a no-op for
 * PATH lookup, so it's simplest and safest to quote uniformly rather than
 * carve out an unquoted special case.
 */
export function buildRemoteCommand(command: string, args: readonly string[]): string {
  return [command, ...args].map(shellQuote).join(" ");
}

/**
 * Prefixes a remote command with `KEY='value' ...` environment assignments
 * (shell env-var-prefix form), used to pass restic/db credentials into one
 * remote invocation's environment without ever writing them to a remote
 * file. `env` keys are always our own fixed constant names (RESTIC_PASSWORD,
 * etc.), never config-derived, so they're interpolated as-is; values are
 * secrets and are escaped with `shellQuoteRaw` (no allowlist — see above).
 *
 * Known residual risk: some hosts run command-auditing (auditd, shell
 * "snoopy" loggers) that records the full command line a non-interactive
 * SSH session executes, which would capture these values. This is the same
 * trade-off restic's own docs make for CI use; a future hardening could
 * swap this for `restic`'s `--password-command`/short-lived credential
 * files instead. Not writing secrets to a persistent remote dotfile (the
 * one thing this deliberately avoids) is the more important property for
 * v1.
 */
export function buildRemoteCommandWithEnv(
  env: Readonly<Record<string, string | undefined>>,
  command: string,
  args: readonly string[],
): string {
  // Undefined entries (e.g. AWS_* keys that a "local" restic backend never
  // sets — see restic/env.ts) are skipped rather than erroring, so callers
  // can pass a ResticEnv-shaped object straight through without filtering.
  const assignments = Object.entries(env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${shellQuoteRaw(value)}`)
    .join(" ");
  const rest = buildRemoteCommand(command, args);
  return assignments.length > 0 ? `${assignments} ${rest}` : rest;
}
