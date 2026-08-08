# Configuration reference

baktime's configuration is split across two places, deliberately:

- **`.baktimerc.yml`** — committed to git. Instance-wide, non-sensitive
  settings only. No target ever appears here.
- **GitHub secrets** — one secret per target (plus satellite secrets for
  keys/passwords), discovered dynamically at run time. See
  [secrets.md](./secrets.md) for the full naming convention and worked
  examples.

This mirrors how upptime configures *notifications* (dynamic, secret-driven)
rather than its *sites* list (static, committed) — targets here follow the
notifications pattern, since even a target's host/path/schedule is
sensitive enough to keep out of a committed file.

## `.baktimerc.yml`

```yaml
owner: your-github-username-or-org
repo: your-instance-repo-name

restic:
  backend: r2 # "r2" | "s3" | "custom" — informational; `repository` below is what actually matters
  repository: s3:https://<account-id>.r2.cloudflarestorage.com/<bucket-name>
  passwordSecretName: RESTIC_PASSWORD
  accessKeyIdSecretName: R2_ACCESS_KEY_ID
  secretAccessKeySecretName: R2_SECRET_ACCESS_KEY

defaults:
  retention:
    keepLast: 14
    keepHourly: 0
    keepDaily: 0
    keepWeekly: 8
    keepMonthly: 12
    keepYearly: 0

knownTargets: [] # optional, docs/lint only — see below

statusSite:
  name: My Backups
  baseUrl: /
  logoUrl: https://example.com/logo.svg
  theme: auto # "light" | "dark" | "auto"
```

| Field | Required | Notes |
|---|---|---|
| `owner`, `repo` | yes | Your instance repo's GitHub owner/name. |
| `restic.backend` | no (default `r2`) | `"r2"` \| `"s3"` \| `"local"` \| `"custom"`. Mostly informational — `restic.repository` is the actual connection string — except that `"r2"`/`"s3"` *require* `accessKeyIdSecretName`/`secretAccessKeySecretName` below; `"local"`/`"custom"` don't. |
| `restic.repository` | yes | A restic-compatible repository URL, or an absolute local path for the `local` backend. |
| `restic.passwordSecretName` | yes | **Name** of a GitHub secret holding `RESTIC_PASSWORD` — required for every backend, since restic always encrypts the repository regardless of where it lives. |
| `restic.accessKeyIdSecretName` / `secretAccessKeySecretName` | only for `r2`/`s3` | **Names** of GitHub secrets holding the actual S3-style credential values — never the values themselves. Omit for `local`/`custom` unless that backend actually needs them. |
| `defaults.retention` | no | Falls back to restic's own defaults (effectively "keep everything") if omitted entirely. Every field is a plain [restic `forget`](https://restic.readthedocs.io/en/stable/060_forget.html) policy field; unset fields aren't passed to restic. Only used by the Phase 3 `prune.yml` — see `ROADMAP.md`. |
| `knownTargets` | no | Bare, lowercase-kebab target names, for human documentation and CI linting only. Discovery never depends on this list being present or accurate. |
| `statusSite.*` | no | Only used once the Phase 3 status site exists — see `ROADMAP.md`. |

### Local storage backend

If you'd rather keep backups on a disk you already control (e.g. an
external drive mounted at `/storage` on a VPS) than pay for R2/S3:

```yaml
restic:
  backend: local
  repository: /storage/restic-repo
  passwordSecretName: RESTIC_PASSWORD
```

**Only `files` targets can use this.** A `files` target's restic process
runs on the target host itself (see `docs/architecture.md`), so a local
path is simply a directory on that same machine — no network access
needed. `mysql`/`postgres` targets dump on the ephemeral GitHub Actions
runner, which has no access to your VPS's filesystem, so they need a
network-reachable repository instead. `src/cli/run-target.ts` rejects a
`mysql`/`postgres` target outright with a clear error if `restic.backend`
is `local`, rather than letting it fail confusingly partway through a run.

If your files target's host *is* the same VPS as `/storage`, this is the
natural setup: point `repository` at a path under `/storage`, and restic
writes there directly during the remote backup.

## Targets (via secrets, not here)

Every target is a secret named `BAKTIME_TARGET_<NAME>` whose value is a
JSON object. `<NAME>` (case-insensitive, lowercased and with `_` mapped to
`-`) becomes the target's canonical name — used as the `history/<name>.yml`
filename, the restic `--tag`, and the workflow matrix id.

### `files` target

```json
{
  "type": "files",
  "host": "web1.example.com",
  "sshUser": "deploy",
  "sshPort": 22,
  "sshKeySecretName": "BAKTIME_TARGET_WEBSERVER1_SSH_KEY",
  "paths": ["/var/www", "/etc/nginx"],
  "excludes": ["*.log", "node_modules"],
  "resticVersion": "0.19.1",
  "schedule": "0 3 * * *",
  "retention": { "keepDaily": 7 }
}
```

- `sshKeySecretName` names a **separate** secret holding the raw SSH
  private key (PEM format) — kept out of the JSON blob so GitHub's
  per-secret log masking applies to it individually, and because
  multi-line PEM content is awkward to embed in a JSON string.
- `resticVersion` and `retention` are optional; `resticVersion` defaults to
  the pinned version in `src/restic/bootstrap-remote.ts`, `retention` falls
  back to `.baktimerc.yml`'s `defaults.retention`.
- `schedule` is a standard cron expression, evaluated in UTC.

### `mysql` / `postgres` targets

```json
{
  "type": "mysql",
  "database": "shop",
  "connection": { "mode": "direct", "host": "db.example.com", "port": 3306, "tls": true },
  "userSecretName": "BAKTIME_TARGET_SHOP_DB_USER",
  "passwordSecretName": "BAKTIME_TARGET_SHOP_DB_PASSWORD",
  "schedule": "*/30 * * * *"
}
```

Or, when the database is only reachable through a jump host:

```json
{
  "type": "postgres",
  "database": "analytics",
  "connection": {
    "mode": "tunnel",
    "jumpHost": "bastion.example.com",
    "jumpUser": "deploy",
    "jumpPort": 22,
    "jumpSshKeySecretName": "BAKTIME_TARGET_ANALYTICS_JUMP_SSH_KEY",
    "remoteHost": "127.0.0.1",
    "remotePort": 5432
  },
  "userSecretName": "BAKTIME_TARGET_ANALYTICS_USER",
  "passwordSecretName": "BAKTIME_TARGET_ANALYTICS_PASSWORD",
  "schedule": "0 2 * * *"
}
```

`connection.mode: "direct"` connects straight from the GitHub Actions
runner (TLS is available for direct MySQL connections; add your own
`sslmode` handling for Postgres by extending `buildPgDumpArgs` if you need
it — not included by default). `connection.mode: "tunnel"` opens an SSH
local port-forward through `jumpHost` first (`src/ssh/tunnel.ts`), for a
database that's only reachable from a box you already have SSH access to,
not directly from the runner.

`mysqldump`/`pg_dump` run **on the runner itself**, streaming straight into
`restic backup --stdin` (`src/adapters/database-common.ts`) — never
buffered whole in memory, never written to disk, and the database password
is passed via `MYSQL_PWD`/`PGPASSWORD` environment variables, never as a
command-line argument. This is why a `restic.backend: local` repository
(see above) can't be used for these targets: the runner has no access to
that filesystem. `src/cli/run-target.ts` rejects that combination
immediately with a clear error rather than failing partway through a dump.

## How a secret becomes a target, precisely

A `BAKTIME_TARGET_*`-prefixed secret is treated as a target if and only if
its value parses as JSON *and* looks target-shaped (has a `type` field). A
secret under that prefix holding a raw string (like an SSH key) is silently
treated as "not a target" — this is what lets satellite secrets share the
same naming prefix by convention without being mistaken for a target
themselves. A secret that *does* parse as target-shaped JSON but fails
schema validation is reported as an error, not silently skipped, since a
silently-dropped target means backups silently stop. See
`src/config/discover-targets.ts`.
