import { z } from "zod";
import { TargetNameSchema, TargetSchema, withName, type NamedTarget } from "./schema.js";
import type { SecretsStore } from "./secrets.js";

/**
 * Targets are discovered dynamically from GitHub secrets, mirroring how
 * upptime configures *notifications* (not its plain, committed `sites:`
 * list): a secret named `BAKTIME_TARGET_<NAME>` holds a JSON blob shaped
 * like a Target. Nothing about a target's existence, host, paths, or
 * schedule is ever committed to git — adding or removing one is purely a
 * "add/remove a GitHub secret" operation.
 *
 * Satellite secrets (e.g. an SSH private key or DB password referenced via a
 * target's `*SecretName` field) commonly share the same prefix by
 * convention, but hold a raw string, not a target-shaped JSON object — so
 * they're distinguished from real targets by shape, not by name: a
 * `BAKTIME_TARGET_*` secret that isn't valid JSON, or doesn't look like a
 * target object, is silently treated as "not a target" (almost always a
 * satellite). A `BAKTIME_TARGET_*` secret that *does* parse as JSON but
 * fails schema validation is a likely typo and is reported as an error
 * instead of silently skipped, so a broken target doesn't just silently stop
 * backing up.
 */
const TARGET_SECRET_PATTERN = /^BAKTIME_TARGET_([A-Za-z0-9_]+)$/;

export class TargetDiscoveryError extends Error {
  constructor(
    public readonly secretName: string,
    public readonly issues: z.ZodIssue[],
  ) {
    super(
      `Secret "${secretName}" looks like a target definition but is invalid:\n${issues
        .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("\n")}`,
    );
    this.name = "TargetDiscoveryError";
  }
}

export class DuplicateTargetNameError extends Error {
  constructor(
    public readonly name: string,
    public readonly secretNames: string[],
  ) {
    super(
      `Multiple secrets resolve to the same target name "${name}": ${secretNames.join(", ")}`,
    );
    this.name = "DuplicateTargetNameError";
  }
}

export interface DiscoverTargetsResult {
  targets: NamedTarget[];
  errors: (TargetDiscoveryError | DuplicateTargetNameError)[];
}

function secretSuffixToTargetName(suffix: string): string {
  return suffix.toLowerCase().replace(/_/g, "-");
}

function looksLikeTargetObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "type" in value;
}

export function discoverTargets(secrets: SecretsStore): DiscoverTargetsResult {
  const targets: NamedTarget[] = [];
  const errors: (TargetDiscoveryError | DuplicateTargetNameError)[] = [];
  const secretNamesByTargetName = new Map<string, string[]>();

  for (const key of secrets.keys()) {
    const match = TARGET_SECRET_PATTERN.exec(key);
    if (!match) continue;
    const suffix = match[1];
    if (!suffix) continue;

    // Use peek(), not resolve(): a non-JSON value here is expected to be a
    // satellite secret (SSH key/password), not a leaked target credential,
    // so it shouldn't be registered for log redaction as if it were one.
    const rawValue = secrets.peek(key);
    if (rawValue === undefined) continue;

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawValue);
    } catch {
      continue; // not JSON -> satellite secret, not a target
    }
    if (!looksLikeTargetObject(parsedJson)) {
      continue; // JSON, but not target-shaped -> some other secret
    }

    const targetResult = TargetSchema.safeParse(parsedJson);
    if (!targetResult.success) {
      errors.push(new TargetDiscoveryError(key, targetResult.error.issues));
      continue;
    }

    const candidateName = secretSuffixToTargetName(suffix);
    const nameResult = TargetNameSchema.safeParse(candidateName);
    if (!nameResult.success) {
      errors.push(new TargetDiscoveryError(key, nameResult.error.issues));
      continue;
    }

    const name = nameResult.data;
    const existing = secretNamesByTargetName.get(name) ?? [];
    secretNamesByTargetName.set(name, [...existing, key]);

    targets.push(withName(targetResult.data, name));
  }

  const duplicateNames = new Set<string>();
  for (const [name, secretNames] of secretNamesByTargetName) {
    if (secretNames.length > 1) {
      duplicateNames.add(name);
      errors.push(new DuplicateTargetNameError(name, secretNames));
    }
  }

  // Ambiguous targets are excluded rather than arbitrarily picking one —
  // callers should treat `errors` as non-empty as a reason to fail loudly.
  const unambiguousTargets = targets.filter((target) => !duplicateNames.has(target.name));

  return { targets: unambiguousTargets, errors };
}
