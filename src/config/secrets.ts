/**
 * baktime never reads individual GitHub secrets via named `env:` entries,
 * because target definitions are discovered dynamically (see
 * discover-targets.ts) and their secret names aren't known up front. Instead
 * every workflow step that needs secrets passes the *whole* secrets context
 * as one JSON blob (`env: BAKTIME_SECRETS_JSON: ${{ toJSON(secrets) }}`) —
 * the same trick upptime uses for its dynamic notification config. GitHub's
 * runner still masks every individual secret value in logs regardless of how
 * it was referenced, so this doesn't weaken log redaction.
 */

export class MissingSecretError extends Error {
  constructor(public readonly secretName: string) {
    super(
      `Secret "${secretName}" is not set. Add it under Settings > Secrets and variables > Actions.`,
    );
    this.name = "MissingSecretError";
  }
}

export class SecretsBlobParseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SecretsBlobParseError";
  }
}

export function parseSecretsBlob(json: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    throw new SecretsBlobParseError("secrets JSON blob is not valid JSON", { cause });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SecretsBlobParseError("secrets JSON blob must be a flat JSON object");
  }

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "string") {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Values resolved through a SecretsStore are registered here so
 * util/logger.ts can redact them from anything baktime itself prints, as
 * defense-in-depth on top of GitHub's own log masking.
 */
const knownSecretValues = new Set<string>();

export function registerSecretValue(value: string): void {
  if (value.length > 0) {
    knownSecretValues.add(value);
  }
}

export function redactSecrets(text: string): string {
  let redacted = text;
  for (const value of knownSecretValues) {
    redacted = redacted.split(value).join("***");
  }
  return redacted;
}

/** Test-only: clear the redaction registry between unrelated test cases. */
export function _resetKnownSecretValuesForTests(): void {
  knownSecretValues.clear();
}

export class SecretsStore {
  private constructor(private readonly secrets: Readonly<Record<string, string>>) {}

  static fromBlob(json: string): SecretsStore {
    return new SecretsStore(parseSecretsBlob(json));
  }

  static fromRecord(secrets: Record<string, string>): SecretsStore {
    return new SecretsStore({ ...secrets });
  }

  static fromEnv(envVar = "BAKTIME_SECRETS_JSON"): SecretsStore {
    const json = process.env[envVar];
    if (!json) {
      throw new Error(
        `${envVar} is not set. The workflow step must set ` +
          `env: { ${envVar}: \${{ toJSON(secrets) }} } to use baktime's dynamic target discovery.`,
      );
    }
    return SecretsStore.fromBlob(json);
  }

  keys(): string[] {
    return Object.keys(this.secrets);
  }

  has(name: string): boolean {
    return Object.hasOwn(this.secrets, name);
  }

  /** Returns the raw value without registering it for redaction — used only by discovery, which handles its own JSON parsing. */
  peek(name: string): string | undefined {
    return this.secrets[name];
  }

  resolve(name: string): string {
    const value = this.secrets[name];
    if (value === undefined) {
      throw new MissingSecretError(name);
    }
    registerSecretValue(value);
    return value;
  }
}
