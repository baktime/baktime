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

/** POSIX single-quote escaping: `'` -> `'\''`, wrapped in `'...'`. */
export function shellQuote(value: string): string {
  assertSafeShellValue(value);
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Builds one remote shell command string: `command` is a fixed, internally
 * chosen program name (never attacker/config-controlled) and is emitted
 * as-is; every entry in `args` is config-derived and is always quoted.
 */
export function buildRemoteCommand(command: string, args: readonly string[]): string {
  return [command, ...args.map(shellQuote)].join(" ");
}
