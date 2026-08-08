import { appendFileSync } from "node:fs";
import { discoverTargets } from "../config/discover-targets.js";
import { SecretsStore } from "../config/secrets.js";
import { getLastRunAt } from "../history/writer.js";
import { isDue } from "../scheduling/is-due.js";

/**
 * Entrypoint for backup.yml's workflow_dispatch fallback: "run everything
 * that's due right now" without waiting for the Worker's next tick. Prints
 * the due target names as a JSON array to $GITHUB_OUTPUT (`due`) for a
 * matrix job — GitHub Actions can't reference an unknown-in-advance list of
 * secrets, so the matrix fans out over names only; each matrix job
 * re-derives its own target from secrets via run-target.ts.
 */
export function computeDueTargetNames(
  secrets: SecretsStore,
  now: Date = new Date(),
  historyBaseDir?: string,
): { due: string[]; hadErrors: boolean } {
  const { targets, errors } = discoverTargets(secrets);

  for (const error of errors) {
    console.error(error.message);
  }

  const due = targets
    .filter((target) => isDue(target.schedule, now, getLastRunAt(target.name, historyBaseDir)))
    .map((target) => target.name);

  return { due, hadErrors: errors.length > 0 };
}

function main(): void {
  const secrets = SecretsStore.fromEnv();
  const { due, hadErrors } = computeDueTargetNames(secrets);

  console.log(`${due.length} target(s) due: ${due.join(", ") || "(none)"}`);

  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    appendFileSync(githubOutput, `due=${JSON.stringify(due)}\n`);
  } else {
    // Local/manual runs won't have GITHUB_OUTPUT set — printing is enough to inspect the result.
    console.log(JSON.stringify(due));
  }

  if (hadErrors) {
    process.exitCode = 1;
  }
}

const isDirectRun = process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href;
if (isDirectRun) {
  main();
}
