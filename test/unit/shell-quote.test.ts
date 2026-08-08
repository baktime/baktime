import { describe, expect, it } from "vitest";
import { buildRemoteCommand, shellQuote, UnsafeShellValueError } from "../../src/ssh/shell-quote.js";

describe("shellQuote", () => {
  it("quotes an ordinary path", () => {
    expect(shellQuote("/var/www")).toBe("'/var/www'");
  });

  it("preserves a path containing spaces safely inside single quotes", () => {
    expect(shellQuote("/var/my app/data")).toBe("'/var/my app/data'");
  });

  it("escapes an embedded single quote using the standard close-escape-reopen trick", () => {
    expect(shellQuote("it's here")).toBe("'it'\\''s here'");
  });

  it.each([
    ["; rm -rf /", "semicolon command chaining"],
    ["`whoami`", "backtick command substitution"],
    ["$(whoami)", "dollar command substitution"],
    ["a | b", "pipe"],
    ["a && b", "ampersand chaining"],
    ["a > /etc/passwd", "redirection"],
    ["line1\nline2", "embedded newline"],
  ])("rejects adversarial input containing %s (%s)", (value) => {
    expect(() => shellQuote(value)).toThrow(UnsafeShellValueError);
  });

  it("rejecting happens before quoting, so no partially-escaped string ever leaks out", () => {
    try {
      shellQuote("; rm -rf /");
      expect.fail("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(UnsafeShellValueError);
      expect((error as UnsafeShellValueError).value).toBe("; rm -rf /");
    }
  });
});

describe("buildRemoteCommand", () => {
  it("joins a fixed command with quoted, config-derived arguments", () => {
    expect(buildRemoteCommand("restic", ["backup", "/var/www", "/etc/nginx"])).toBe(
      "restic 'backup' '/var/www' '/etc/nginx'",
    );
  });

  it("propagates rejection from any single unsafe argument", () => {
    expect(() => buildRemoteCommand("restic", ["backup", "/var/www; rm -rf /"])).toThrow(
      UnsafeShellValueError,
    );
  });

  it("neutralizes shell metacharacters that survive inside safe-looking quoted args", () => {
    // Characters that aren't in the reject-list but must still be inert once single-quoted.
    const weirdButAllowed = "path-with-*-glob-and-(parens)";
    const quoted = shellQuote(weirdButAllowed);
    expect(quoted).toBe(`'${weirdButAllowed}'`);
  });
});
