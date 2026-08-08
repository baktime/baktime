import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import yaml from "js-yaml";
import type { HistoryRecord } from "./types.js";

const DEFAULT_HISTORY_DIR = "history";

function historyPath(targetName: string, baseDir: string): string {
  return join(baseDir, `${targetName}.yml`);
}

/** One growing YAML list per target, mirroring upptime's `history/*.yml` — small enough to commit to git. */
export function readHistory(targetName: string, baseDir: string = DEFAULT_HISTORY_DIR): HistoryRecord[] {
  const path = historyPath(targetName, baseDir);
  if (!existsSync(path)) {
    return [];
  }
  const raw = yaml.load(readFileSync(path, "utf8"));
  return Array.isArray(raw) ? (raw as HistoryRecord[]) : [];
}

/**
 * Timestamp of the most recent *attempt* (success or failure) — used by
 * scheduling/is-due.ts. Deliberately not "most recent success": a target
 * that's persistently failing shouldn't be retried on every Worker tick,
 * only on its next actually-scheduled occurrence (failures are surfaced
 * separately, see ROADMAP.md's summary.yml incident automation).
 */
export function getLastRunAt(targetName: string, baseDir: string = DEFAULT_HISTORY_DIR): Date | null {
  const records = readHistory(targetName, baseDir);
  const last = records.at(-1);
  return last ? new Date(last.timestamp) : null;
}

export function appendRecord(
  targetName: string,
  record: HistoryRecord,
  baseDir: string = DEFAULT_HISTORY_DIR,
): void {
  const records = readHistory(targetName, baseDir);
  records.push(record);
  const path = historyPath(targetName, baseDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, yaml.dump(records, { sortKeys: false }));
}
