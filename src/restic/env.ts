import type { ResticBackendConfig } from "../config/schema.js";
import type { SecretsStore } from "../config/secrets.js";

export interface ResticEnv extends Record<string, string> {
  RESTIC_REPOSITORY: string;
  RESTIC_PASSWORD: string;
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
}

/** Resolves the restic repository's credentials from secrets — never logged, held only in memory. */
export function buildResticEnv(config: ResticBackendConfig, secrets: SecretsStore): ResticEnv {
  return {
    RESTIC_REPOSITORY: config.repository,
    RESTIC_PASSWORD: secrets.resolve(config.passwordSecretName),
    AWS_ACCESS_KEY_ID: secrets.resolve(config.accessKeyIdSecretName),
    AWS_SECRET_ACCESS_KEY: secrets.resolve(config.secretAccessKeySecretName),
  };
}
