import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("kills a still-running producer when the consumer exits early (regression: this used to hang the whole process)", async () => {
    // Reproduces a real production incident: restic (the consumer) failed
    // fast with a startup error while pg_dump (the producer) was still
    // running. Without killing the producer, its still-open child-process
    // handle kept the whole Node process alive well past the promise
    // settling, hanging the calling GitHub Actions job indefinitely.
    const dir = await mkdtemp(join(tmpdir(), "baktime-spawn-pipeline-"));
    const pidFile = join(dir, "producer.pid");

    const start = Date.now();
    await expect(
      spawnPipeline(
        // A long-running "producer" that would still be alive long after
        // the consumer below has already failed and exited.
        { command: "sh", args: ["-c", `echo $$ > '${pidFile}'; sleep 30`] },
        // Simulates restic's fast "unable to open cache" startup failure.
        { command: "sh", args: ["-c", "exit 1"] },
      ),
    ).rejects.toThrow(ExecError);
    const elapsedMs = Date.now() - start;

    // The whole point: this resolves promptly, not after the producer's 30s sleep.
    expect(elapsedMs).toBeLessThan(5000);

    // Give the kill signal a moment to actually land, then confirm the
    // producer process is really gone, not just detached/orphaned.
    await new Promise((r) => setTimeout(r, 200));
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    expect(() => process.kill(pid, 0)).toThrow(); // ESRCH once the process no longer exists

    await rm(dir, { recursive: true, force: true });
  });
});
