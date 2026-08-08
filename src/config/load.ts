import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { z } from "zod";
import { BaktimeConfigSchema, type BaktimeConfig } from "./schema.js";

export class ConfigValidationError extends Error {
  constructor(
    public readonly path: string,
    public readonly issues: z.ZodIssue[],
  ) {
    super(
      `Invalid baktime config at ${path}:\n${issues
        .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("\n")}`,
    );
    this.name = "ConfigValidationError";
  }
}

export function parseConfig(raw: unknown, path: string): BaktimeConfig {
  const result = BaktimeConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigValidationError(path, result.error.issues);
  }
  return result.data;
}

export function loadConfig(path = ".baktimerc.yml"): BaktimeConfig {
  const contents = readFileSync(path, "utf8");
  const raw = yaml.load(contents);
  return parseConfig(raw, path);
}
