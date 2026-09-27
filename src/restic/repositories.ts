import type { SecretsStore } from "../config/secrets.js";
import type { NamedTarget, ResticBackendConfig } from "../config/schema.js";
import { ensureLocalResticInstalled } from "./bootstrap-local.js";
import { ensureRemoteResticInstalled } from "./bootstrap-remote.js";
import { runLocalRestic } from "./client.js";
import { buildResticEnv } from "./env.js";
import { runRemoteCommand, type SshTarget } from "../ssh/connection.js";
import type { ExecResult } from "../util/exec.js";

/**
 * One distinct restic repository plus the right place to run restic
 * against it. Network repositories (R2/S3/custom) are reached from the
 * Actions runner; `local` repositories only exist on a files target's own
 * host, so they're reached over that target's SSH connection instead.
 */
export interface RepositoryHandle {
  /** Stable identity — several targets sharing one repository share one handle. */
  key: string;
  /** Human-readable, non-secret label for logs and reports. */
  label: string;
  run(args: readonly string[]): Promise<ExecResult>;
}

function configKey(config: ResticBackendConfig): string {
  return JSON.stringify([config.backend, config.repository]);
}

export function effectiveResticConfig(
  target: NamedTarget,
  globalConfig: ResticBackendConfig,
): ResticBackendConfig {
  return target.type === "files" ? (target.restic ?? globalConfig) : globalConfig;
}

/**
 * Resolves each target to a (deduplicated) repository handle. restic is
 * bootstrapped lazily and at most once per runner / per remote handle, so
 * resolving handles for targets that end up unused costs nothing.
 */
export function createRepositoryResolver(
  globalConfig: ResticBackendConfig,
  secrets: SecretsStore,
): (target: NamedTarget) => RepositoryHandle {
  const handles = new Map<string, RepositoryHandle>();
  let localResticPathPromise: Promise<string> | undefined;

  function localResticPath(): Promise<string> {
    localResticPathPromise ??= ensureLocalResticInstalled().then((result) => result.resticPath);
    return localResticPathPromise;
  }

  return (target) => {
    const config = effectiveResticConfig(target, globalConfig);

    if (config.backend !== "local") {
      const key = configKey(config);
      let handle = handles.get(key);
      if (!handle) {
        handle = {
          key,
          label: config.repository,
          async run(args) {
            return runLocalRestic(args, buildResticEnv(config, secrets), await localResticPath());
          },
        };
        handles.set(key, handle);
      }
      return handle;
    }

    if (target.type !== "files") {
      return {
        key: `unreachable:${target.name}`,
        label: target.name,
        async run() {
          throw new Error("a local restic repository cannot be reached for a database target");
        },
      };
    }

    const key = JSON.stringify([
      target.host,
      target.sshUser,
      target.sshPort,
      target.sshKeySecretName,
      configKey(config),
    ]);
    let handle = handles.get(key);
    if (!handle) {
      let remoteResticPathPromise: Promise<string> | undefined;
      const sshTarget = (): SshTarget => ({
        host: target.host,
        user: target.sshUser,
        port: target.sshPort,
        privateKey: secrets.resolve(target.sshKeySecretName),
      });
      handle = {
        key,
        label: `${target.host}:${config.repository}`,
        async run(args) {
          remoteResticPathPromise ??= ensureRemoteResticInstalled(sshTarget(), {
            version: target.resticVersion,
          }).then((result) => result.resticPath);
          const resticPath = await remoteResticPathPromise;
          return runRemoteCommand(sshTarget(), resticPath, args, {
            env: buildResticEnv(config, secrets),
          });
        },
      };
      handles.set(key, handle);
    }
    return handle;
  };
}
