import { describe, expect, it } from "vitest";
import { ExecError, spawnPipeline } from "../../src/util/exec.js";

// Exercised against real, tiny POSIX commands (available in any CI/dev
// environment this test runs in) rather than mocking node:child_process —
// piping/exit-code/kill semantics are exactly the kind of thing that's easy
// to get subtly wrong with a mock and have it not reflect real behavior.

describe("spawnPipeline", () => {
  it("streams the producer's stdout into the consumer's stdin", async () => {
    const result = await spawnPipeline(
      { command: "printf", args: ["hello world"] },
      { command: "cat", args: [] },
    );
    expect(result.stdout).toBe("hello world");
  });

  it("rejects with the producer's ExecError when the producer fails, and kills the consumer", async () => {
    await expect(
      spawnPipeline(
        { command: "sh", args: ["-c", "echo partial; exit 3"] },
        // `cat -` would otherwise happily read whatever partial input arrives.
        { command: "cat", args: [] },
      ),
    ).rejects.toMatchObject({ exitCode: 3 } satisfies Partial<ExecError>);
  });

  it("rejects with the consumer's ExecError when the consumer fails", async () => {
    await expect(
      spawnPipeline(
        { command: "printf", args: ["hello"] },
        { command: "sh", args: ["-c", "cat >/dev/null; exit 5"] },
      ),
    ).rejects.toMatchObject({ exitCode: 5 } satisfies Partial<ExecError>);
  });

  it("rejects when the producer command doesn't exist", async () => {
    await expect(
      spawnPipeline(
        { command: "this-command-does-not-exist-xyz", args: [] },
        { command: "cat", args: [] },
      ),
    ).rejects.toThrow(ExecError);
  });

  it("resolves with an empty stdout when the producer emits nothing", async () => {
    const result = await spawnPipeline({ command: "true", args: [] }, { command: "cat", args: [] });
    expect(result.stdout).toBe("");
  });
});
