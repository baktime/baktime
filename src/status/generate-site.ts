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
          <td>${record.status === "success" ? "Success" : "Failed"}</td>
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
          ? `<h3>Available backups (recent snapshots)</h3><div class="runs"><table>
              <thead><tr><th>When</th><th>Status</th><th>Duration</th><th>Result</th></tr></thead>
              <tbody>${rows}</tbody>
            </table></div>`
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
  :root { color-scheme: light; font: 100%/1.6 Inter, system-ui, sans-serif; color: #152f2c; background: #f1f5ee; }
  * { box-sizing: border-box; }
  body { max-width: 66rem; margin: auto; padding: 2rem 5% 4rem; }
  .brand { font-size: 1.6rem; font-weight: 750; letter-spacing: -.065em; }
  .brand b { color: #bd562a; }
  h1 { margin: 1rem 0 .25rem; font-size: clamp(2rem, 5vw, 3rem); line-height: 1.1; letter-spacing: -.05em; }
  .generated-at, .meta { color: #4f645d; margin: .25rem 0 1rem; }
  .target { background: #fcfdf9; border: 1px solid #ccdad2; border-radius: .85rem; margin: 1rem 0; padding: 1.25rem; }
  .target h2 { display: flex; flex-wrap: wrap; align-items: center; gap: .6rem; margin: 0; font-size: 1.3rem; overflow-wrap: anywhere; }
  .target h3 { font-size: 1rem; margin: 1rem 0 .5rem; }
  .badge { border-radius: 1rem; padding: .12rem .65rem; font-size: .88rem; font-weight: 600; }
  .health-healthy .badge { color: #1a5846; background: #deefe1; }
  .health-late .badge { color: #764412; background: #fae9ca; }
  .health-failing .badge { color: #8a3024; background: #fbe3d8; }
  .health-never-run .badge { color: #42594f; background: #e6ebe7; }
  .runs { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: .94rem; }
  th, td { text-align: left; vertical-align: top; padding: .4rem .6rem; border-bottom: 1px solid #dce6dd; }
  .error { color: #8a3024; overflow-wrap: anywhere; }
  @media (prefers-color-scheme: dark) {
    :root { color-scheme: dark; color: #e5f1e7; background: #142520; }
    .target { background: #1c302a; border-color: #455d52; }
    .meta, .generated-at { color: #bdcbc1; }
    th, td { border-color: #455d52; }
    .error { color: #ffbda5; }
  }
</style>
</head>
<body>
<div class="brand">baktime<b>.</b></div>
<h1>Backup status</h1>
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
