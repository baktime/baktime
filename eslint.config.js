// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/**", "node_modules/**", "cloudflare-worker/dist/**"],
  },
  {
    rules: {
      // Backup orchestration shells out to ssh/restic/mysqldump/pg_dump by design;
      // the safety invariant is "no shell interpolation", enforced via execFile
      // argument arrays in src/util/exec.ts, not by banning child_process outright.
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
);
