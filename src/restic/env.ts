import type { ResticBackendConfig } from "../config/schema.js";
import type { SecretsStore } from "../config/secrets.js";

export interface ResticEnv {
  [key: string]: string | undefined;
  RESTIC_REPOSITORY: string;
  RESTIC_PASSWORD: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
}

/**
 * Resolves the restic repository's credentials from secrets — never logged,
 * held only in memory. AWS_* keys are omitted entirely (not just left
 * empty) when the config doesn't reference them, which is the normal case
 * for a "local" backend that needs no S3-style credentials at all.
 */
export function buildResticEnv(config: ResticBackendConfig, secrets: SecretsStore): ResticEnv {
  const env: ResticEnv = {
    RESTIC_REPOSITORY: config.repository,
    RESTIC_PASSWORD: secrets.resolve(config.passwordSecretName),
  };
  if (config.accessKeyIdSecretName) {
    env.AWS_ACCESS_KEY_ID = secrets.resolve(config.accessKeyIdSecretName);
  }
  if (config.secretAccessKeySecretName) {
    env.AWS_SECRET_ACCESS_KEY = secrets.resolve(config.secretAccessKeySecretName);
  }
  return env;
}
