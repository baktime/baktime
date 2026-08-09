import { mkdirSync, writeFileSync } from "node:fs";
import { discoverTargets } from "../config/discover-targets.js";
import type { NamedTarget } from "../config/schema.js";
import { SecretsStore } from "../config/secrets.js";
import { readHistory } from "../history/writer.js";
import type { HistoryRecord } from "../history/types.js";
import { isDue } from "../scheduling/is-due.js";

export type Health = "healthy" | "late" | "failing" | "never-run";

export interface TargetStatus {
  name: string;
  type: NamedTarget["type"];
  schedule: string;
  health: Health;
  lastRun: HistoryRecord | null;
  /** Most recent runs first, capped — see RECENT_RUNS_LIMIT. */
  recentRuns: HistoryRecord[];
}

const RECENT_RUNS_LIMIT = 10;

/**
 * "late" means the schedule says this target should have run again by now
 * and hasn't — the exact same cron math the Worker/discover-due-targets use
 * to decide whether to fire a backup (scheduling/is-due.ts), so a target
 * shown "late" here is genuinely overdue, not just old.
 */
export function computeHealth(schedule: string, now: Date, lastRun: HistoryRecord | null): Health {
  if (!lastRun) return "never-run";
  if (lastRun.status === "failure") return "failing";
  return isDue(schedule, now, new Date(lastRun.timestamp)) ? "late" : "healthy";
}

export function buildTargetStatuses(targets: readonly NamedTarget[], now: Date): TargetStatus[] {
  return targets
    .map((target) => {
      const history = readHistory(target.name);
      const recentRuns = history.slice(-RECENT_RUNS_LIMIT).reverse();
      const lastRun = recentRuns[0] ?? null;
      return {
        name: target.name,
        type: target.type,
        schedule: target.schedule,
        health: computeHealth(target.schedule, now, lastRun),
        lastRun,
        recentRuns,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

const HEALTH_LABEL: Record<Health, string> = {
  healthy: "healthy",
  late: "late",
  failing: "failing",
  "never-run": "never run",
};

function renderRecordSummary(record: HistoryRecord): string {
  if (record.status === "success") {
    return `snapshot <code>${escapeHtml(record.snapshotId.slice(0, 12))}</code>, +${formatBytes(record.bytesAdded)}`;
  }
  return `<span class="error">${escapeHtml(record.error)}</span>`;
}

function renderTargetCard(status: TargetStatus): string {
  const rows = status.recentRuns
    .map(
      (record) => `
        <tr>
          <td>${escapeHtml(record.timestamp)}</td>
          <td>${record.status === "success" ? "✅" : "❌"}</td>
          <td>${(record.durationMs / 1000).toFixed(1)}s</td>
          <td>${renderRecordSummary(record)}</td>
        </tr>`,
    )
    .join("");

  return `
    <section class="target health-${status.health}">
      <h2>${escapeHtml(status.name)} <span class="badge">${HEALTH_LABEL[status.health]}</span></h2>
      <p class="meta">${escapeHtml(status.type)} · schedule <code>${escapeHtml(status.schedule)}</code></p>
      ${
        status.recentRuns.length > 0
          ? `<h3>Available backups (recent snapshots)</h3><table>
              <thead><tr><th>When</th><th></th><th>Duration</th><th>Result</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>`
          : `<p class="meta">No runs recorded yet.</p>`
      }
    </section>`;
}

export function renderSiteHtml(statuses: readonly TargetStatus[], generatedAt: Date): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>baktime — backup status</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 860px; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
  h1 { font-size: 1.5rem; }
  .generated-at { color: #888; font-size: 0.85rem; margin-top: -0.5rem; }
  section.target { border: 1px solid #ccc4; border-radius: 8px; padding: 1rem 1.25rem; margin: 1rem 0; }
  section.target h2 { margin: 0 0 0.25rem; font-size: 1.1rem; display: flex; align-items: center; gap: 0.5rem; }
  section.target h3 { margin: 0.8rem 0 0.35rem; font-size: 0.9rem; }
  .meta { color: #888; font-size: 0.85rem; margin: 0 0 0.75rem; }
  .badge { font-size: 0.7rem; font-weight: normal; padding: 0.15rem 0.5rem; border-radius: 999px; text-transform: uppercase; letter-spacing: 0.03em; }
  .health-healthy .badge { background: #2ecc7133; color: #1e8449; }
  .health-late .badge { background: #f1c40f33; color: #9a7d0a; }
  .health-failing .badge { background: #e74c3c33; color: #c0392b; }
  .health-never-run .badge { background: #8884; color: #666; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th, td { text-align: left; padding: 0.3rem 0.5rem; border-bottom: 1px solid #ccc3; }
  code { font-size: 0.85em; }
  .error { color: #c0392b; }
</style>
</head>
<body>
<h1>baktime — backup status</h1>
<p class="generated-at">Generated ${escapeHtml(generatedAt.toISOString())}</p>
${statuses.length > 0 ? statuses.map(renderTargetCard).join("\n") : "<p>No targets configured.</p>"}
</body>
</html>
`;
}

export async function generateSite(outputDir = "site"): Promise<void> {
  const secrets = SecretsStore.fromEnv();
  const { targets, errors } = discoverTargets(secrets);
  for (const error of errors) {
    console.error(error.message);
  }

  const now = new Date();
  const statuses = buildTargetStatuses(targets, now);
  const html = renderSiteHtml(statuses, now);

  mkdirSync(outputDir, { recursive: true });
  writeFileSync(`${outputDir}/index.html`, html);
  console.log(`Wrote ${outputDir}/index.html (${statuses.length} target(s))`);
}

async function main(): Promise<void> {
  await generateSite(process.argv[2]);
}

const isDirectRun = process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href;
if (isDirectRun) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  });
}
