export type TargetType = "files" | "mysql" | "postgres";

export interface HistoryRecordBase {
  /** ISO 8601 UTC timestamp of when this run started. */
  timestamp: string;
  target: string;
  type: TargetType;
  durationMs: number;
}

export interface SuccessfulHistoryRecord extends HistoryRecordBase {
  status: "success";
  snapshotId: string;
  bytesAdded: number;
  /** Only meaningful for "files" targets, where restic runs on a self-bootstrapped remote binary. */
  verification?: "sha256";
}

export interface FailedHistoryRecord extends HistoryRecordBase {
  status: "failure";
  error: string;
}

export type HistoryRecord = SuccessfulHistoryRecord | FailedHistoryRecord;
