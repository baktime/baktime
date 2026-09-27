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
    keepDaily: 14
    keepWeekly: 8
    keepMonthly: 12

knownTargets: [] # optional, docs/lint only — see below

secrets: [] # optional, docs/lint only — bare notification secret names, see docs/secrets.md

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
| `defaults.retention` | no | Retention policy for every target that doesn't set its own — see [Retention](#retention) below. Omit it entirely to keep every snapshot forever. |
| `knownTargets` | no | Bare, lowercase-kebab target names, for human documentation and CI linting only. Discovery never depends on this list being present or accurate. |
| `secrets` | no | Bare GitHub secret names (e.g. `NOTIFICATION_DISCORD`), for documentation only — same field name and purpose as upptime's own `secrets:` allowlist. See [secrets.md](./secrets.md#notifications). |
| `statusSite.*` | no | Only used once the Phase 3 status site exists — see `ROADMAP.md`. |

## Retention

`prune.yml` enforces retention daily (05:23 UTC by default — move it if
your backups run then). Fields map one-to-one onto
[restic `forget`](https://restic.readthedocs.io/en/stable/060_forget.html)
flags: `keepLast`, `keepHourly`, `keepDaily`, `keepWeekly`, `keepMonthly`,
`keepYearly`. Unset or `0` fields are ignored; a policy with nothing left
keeps everything.

- A target's own `retention` **replaces** `defaults.retention` as a whole
  (fields aren't merged), so `{ "keepDaily": 7 }` on a target means
  exactly "7 daily", with no weekly/monthly tail.
- Rules are applied per target (restic `--tag <name> --group-by tags`), so
  one target's policy never touches another's snapshots even in a shared
  repository.
- Rules combine as a union: `keepDaily: 14, keepWeekly: 8, keepMonthly: 12`
  keeps the newest snapshot of each of the last 14 days, 8 weeks and 12
  months — roughly a year of history in ~30 snapshots.
- Prefer calendar rules over `keepLast`: extra manual runs and restore
  safety backups would otherwise push older days out of the window.
- `restic prune` (which actually frees storage) and `restic check` only run
  on repositories where something was forgotten.
- Run `prune.yml` manually with **dry run** ticked to see what would be
  removed without deleting anything. The workflow's run summary shows
  kept/removed counts per target; failures are also sent to your
  notification channels.

## Notifications (via secrets, not here)

Like targets, notification channels are never configured in
`.baktimerc.yml` — see [secrets.md](./secrets.md#notifications) for the
`NOTIFICATION_<PROVIDER>`/`NOTIFICATION_<PROVIDER>_<SETTING>` convention
(identical to upptime's own).

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
  "restic": {
    "backend": "local",
    "repository": "/storage/backup/restic",
    "passwordSecretName": "RESTIC_PASSWORD"
  },
  "sqliteBackups": [
    {
      "source": "/var/lib/docker/volumes/app-db/_data/app.db",
      "destination": "/storage/.baktime-staging/app/app.db"
    }
  ],
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
- `restic` optionally overrides the instance-wide backend for this one files
  target. This allows database targets to keep using R2 while a VPS files
  target writes directly to an attached disk such as
  `/storage/backup/restic`.
- `sqliteBackups` creates transactionally consistent SQLite copies with the
  SQLite online-backup command before restic runs, verifies each copy with
  `PRAGMA integrity_check`, includes the copies in the snapshot, then removes
  the staging files. Use this for live WAL-mode databases instead of backing
  up `.db`/`.db-wal` files independently.

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

**Don't name a target after one of its own credential values.** GitHub
Actions masks any log/output text that matches a registered secret's exact
value, anywhere it appears — including as a substring. `<NAME>` becomes
part of `discover-due-targets.yml`'s `due` job output (the list fed into
the backup matrix), so if, say, your DB username secret's value is
`wanda192` and you name the target `wanda192-mysql`, GitHub silently drops
that entire output ("Skip output 'due' since it may contain secret") — the
matrix ends up empty, and the whole `Backup` workflow run fails with no
target-level error to point at. Pick a target name that doesn't literally
contain any of its secrets' values (e.g. `wanda-mysql` instead of
`wanda192-mysql`).
