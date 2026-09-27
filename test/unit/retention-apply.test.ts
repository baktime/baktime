import { describe, expect, it, vi } from "vitest";
import type { NamedTarget } from "../../src/config/schema.js";
import {
  buildForgetArgs,
  buildPruneArgs,
  normalizeRetentionPolicy,
  parseForgetResult,
} from "../../src/restic/client.js";
import {
  applyRetention,
  effectiveRetentionPolicy,
  formatRetentionMarkdown,
  hasRetentionFailures,
} from "../../src/retention/apply.js";
import type { RepositoryHandle } from "../../src/restic/repositories.js";

function target(name: string, extra: Partial<NamedTarget> = {}): NamedTarget {
  return {
    name,
    type: "postgres",
    database: name,
    connection: { mode: "direct", host: "db", port: 5432, tls: true },
    userSecretName: "USER",
    passwordSecretName: "PASS",
    schedule: "30 2 * * *",
    ...extra,
  } as NamedTarget;
}

function forgetOutput(keep: number, remove: number): string {
  return JSON.stringify([
    {
      tags: ["x"],
      host: "",
      paths: null,
      keep: Array.from({ length: keep }, (_, i) => ({ id: `k${i}` })),
      remove: remove > 0 ? Array.from({ length: remove }, (_, i) => ({ id: `r${i}` })) : null,
    },
  ]);
}

function handle(key: string, run: RepositoryHandle["run"]): RepositoryHandle {
  return { key, label: key, run };
}

describe("restic retention argument builders", () => {
  it("groups by tag so per-run stdin paths and runner hostnames don't split groups", () => {
    expect(
      buildForgetArgs({ tag: "db", policy: { keepDaily: 14, keepWeekly: 8, keepMonthly: 12 } }),
    ).toEqual([
      "forget",
      "--json",
      "--tag",
      "db",
      "--group-by",
      "tags",
      "--retry-lock",
      "30m",
      "--keep-daily",
      "14",
      "--keep-weekly",
      "8",
      "--keep-monthly",
      "12",
    ]);
  });

  it("adds --dry-run when requested and skips zero rules", () => {
    expect(buildForgetArgs({ tag: "db", policy: { keepLast: 3, keepHourly: 0 }, dryRun: true })).toEqual(
      ["forget", "--json", "--tag", "db", "--group-by", "tags", "--retry-lock", "30m", "--keep-last", "3", "--dry-run"],
    );
  });

  it("buildPruneArgs waits for locks", () => {
    expect(buildPruneArgs()).toEqual(["prune", "--retry-lock", "30m"]);
  });

  it("normalizeRetentionPolicy drops zeros and returns null for empty policies", () => {
    expect(normalizeRetentionPolicy(undefined)).toBeNull();
    expect(normalizeRetentionPolicy({})).toBeNull();
    expect(normalizeRetentionPolicy({ keepDaily: 0 })).toBeNull();
    expect(normalizeRetentionPolicy({ keepDaily: 7, keepYearly: 0 })).toEqual({ keepDaily: 7 });
  });
});

describe("parseForgetResult", () => {
  it("sums keep/remove across groups", () => {
    expect(parseForgetResult(forgetOutput(14, 3))).toEqual({ kept: 14, removed: 3 });
  });

  it("treats null remove and empty output as nothing removed", () => {
    expect(parseForgetResult(forgetOutput(2, 0))).toEqual({ kept: 2, removed: 0 });
    expect(parseForgetResult("")).toEqual({ kept: 0, removed: 0 });
    expect(parseForgetResult("[]\n")).toEqual({ kept: 0, removed: 0 });
  });

  it("tolerates stray status lines around the JSON document", () => {
    expect(parseForgetResult(`${forgetOutput(1, 2)}\nremoved snapshot r0\n`)).toEqual({ kept: 1, removed: 2 });
  });

  it("rejects non-JSON output", () => {
    expect(() => parseForgetResult("oops")).toThrow(/not valid JSON/);
  });
});

describe("effectiveRetentionPolicy", () => {
  it("prefers the target's own policy over defaults", () => {
    expect(effectiveRetentionPolicy(target("a", { retention: { keepLast: 2 } }), { keepDaily: 14 })).toEqual({
      keepLast: 2,
    });
    expect(effectiveRetentionPolicy(target("a"), { keepDaily: 14 })).toEqual({ keepDaily: 14 });
    expect(effectiveRetentionPolicy(target("a"), undefined)).toBeNull();
  });
});

describe("applyRetention", () => {
  it("forgets per target, then prunes and checks each changed repository once", async () => {
    const shared = vi.fn<RepositoryHandle["run"]>(async (args) => {
      if (args[0] === "forget") return { stdout: forgetOutput(14, args[3] === "a" ? 2 : 1), stderr: "" };
      return { stdout: "", stderr: "" };
    });
    const unchanged = vi.fn<RepositoryHandle["run"]>(async () => ({ stdout: forgetOutput(5, 0), stderr: "" }));
    const handles: Record<string, RepositoryHandle> = {
      a: handle("r2", shared),
      b: handle("r2", shared),
      c: handle("local", unchanged),
    };

    const report = await applyRetention(
      [target("b"), target("a"), target("c")],
      { keepDaily: 14 },
      (t) => handles[t.name] as RepositoryHandle,
      { now: new Date("2026-09-27T05:23:00Z") },
    );

    expect(report.targets.map((r) => [r.target, r.status, r.removed])).toEqual([
      ["a", "applied", 2],
      ["b", "applied", 1],
      ["c", "applied", 0],
    ]);
    expect(report.repositories).toEqual([{ repository: "r2", status: "pruned" }]);
    expect(shared.mock.calls.map(([args]) => args[0])).toEqual(["forget", "forget", "prune", "check"]);
    expect(unchanged).toHaveBeenCalledTimes(1);
    expect(hasRetentionFailures(report)).toBe(false);
  });

  it("skips targets without a policy and never prunes on dry runs", async () => {
    const run = vi.fn<RepositoryHandle["run"]>(async () => ({ stdout: forgetOutput(14, 4), stderr: "" }));
    const report = await applyRetention(
      [target("keep-all"), target("dry", { retention: { keepLast: 1 } })],
      undefined,
      () => handle("r2", run),
      { dryRun: true },
    );

    expect(report.targets.map((r) => r.status)).toEqual(["applied", "skipped"]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toContain("--dry-run");
    expect(report.repositories).toEqual([]);
  });

  it("records failures per target and per repository step without stopping others", async () => {
    const broken = vi.fn<RepositoryHandle["run"]>(async () => {
      throw new Error("host unreachable");
    });
    const failingCheck = vi.fn<RepositoryHandle["run"]>(async (args) => {
      if (args[0] === "forget") return { stdout: forgetOutput(3, 1), stderr: "" };
      if (args[0] === "check") throw new Error("pack abc is damaged");
      return { stdout: "", stderr: "" };
    });

    const report = await applyRetention(
      [target("a"), target("b")],
      { keepLast: 3 },
      (t) => (t.name === "a" ? handle("down", broken) : handle("r2", failingCheck)),
    );

    expect(report.targets[0]).toMatchObject({ target: "a", status: "failed", error: "host unreachable" });
    expect(report.targets[1]).toMatchObject({ target: "b", status: "applied", removed: 1 });
    expect(report.repositories).toEqual([
      { repository: "r2", status: "failed", failedStep: "check", error: "pack abc is damaged" },
    ]);
    expect(hasRetentionFailures(report)).toBe(true);
    expect(formatRetentionMarkdown(report)).toContain("check failed: pack abc is damaged");
  });
});
