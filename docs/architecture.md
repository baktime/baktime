# Architecture

baktime is "upptime for backups": GitHub Actions does the actual work, git
stores lightweight history and config, and a Cloudflare Worker exists only
to trigger Actions reliably on a schedule. It backs up MySQL/Postgres
databases and files on remote hosts reachable over SSH, using
[restic](https://restic.net/) as the backup engine.

## Why this isn't just upptime with a different payload

Upptime's payload — an uptime ping — is tiny and safe to commit to a public
git repo. A backup is neither. So:

- **git stores only**: `.baktimerc.yml` (instance-wide, non-sensitive
  settings), `history/*.yml` (run metadata — timestamps, restic snapshot
  ids, byte counts, durations, success/failure), and, once Phase 3 lands, a
  generated static status site.
- **The actual backup bytes** live in a restic repository on Cloudflare R2
  (or any S3-compatible/restic-supported backend), never in git.
- **Target definitions** (which hosts, which databases, on what schedule)
  live entirely in GitHub secrets, not in git at all — see
  [config-reference.md](./config-reference.md) and [secrets.md](./secrets.md).

## The trigger loop

```
sync-cloudflare-schedule.yml (GitHub Actions, ~every 15 min or on demand)
  reads BAKTIME_TARGET_* secrets, keeps only {name, type, schedule}
  → writes that manifest into Cloudflare KV

Cloudflare Worker (cron trigger, every 5 min)
  reads the KV manifest
  evaluates each target's own cron schedule against "now"
  → repository_dispatch (client_payload.target = "<name>") for due targets only

backup.yml (GitHub Actions, repository_dispatch)
  re-derives the one named target from secrets (never trusts the payload blindly)
  re-checks due-ness against history/<name>.yml (safety net against a stale KV manifest)
  runs the target's adapter (files: SSH + remote restic; mysql/postgres: dump + restic --stdin on the runner)
  → appends history/<name>.yml and commits it
```

A `workflow_dispatch` fallback on `backup.yml` bypasses the Worker entirely
("run everything due right now") by discovering and filtering all targets
directly inside the Actions job.

### Why the Worker can't just read target schedules directly

A target's `schedule` lives inside its `BAKTIME_TARGET_<NAME>` secret. The
GitHub API can list secret *names* but will never return a secret's
*value* to anyone — including a Worker holding a PAT. So the Worker cannot
pull schedules from GitHub itself. Instead, a GitHub Actions job (which
*does* have legitimate, decrypted access to secrets while it's running)
projects out only the non-sensitive `{name, type, schedule}` slice and
pushes it into Cloudflare KV — a deliberately smaller disclosure than the
full target definition, but not literally "nothing about targets is ever
visible outside a secret." Target names, types, and schedules are visible
in KV and briefly in Actions run logs (via `client_payload`); hosts, paths,
database names, and all credentials never leave the secrets boundary.

## File backups: why restic runs on the target host, not the runner

For `files` targets, restic actually executes *on the target host*, over
SSH, rather than pulling files through the GitHub Actions runner:

- **Dedup carries over between runs.** restic's chunk-level dedup only
  helps if it's comparing against its own prior state on the same
  filesystem view; running remotely preserves that incrementally, backup
  after backup.
- **No bandwidth/disk cost on the runner.** Large file sets never transit
  the Action's own network or ephemeral disk.

Since target hosts include Alpine (musl) as well as glibc distros, and we
can't assume root or a package manager, baktime self-bootstraps: it checks
for a working `restic` at `~/.baktime/bin/restic`, and if it's missing or
the wrong version, downloads the official static Linux release (a
dependency-free Go binary — the same asset works on musl and glibc) and
verifies it against restic's published `SHA256SUMS` before it's ever
executed. A checksum mismatch aborts installation entirely; see
`src/restic/bootstrap-remote.ts`.

Repository credentials (`RESTIC_PASSWORD`, R2 access keys) are exported
into that one remote `restic backup` invocation's environment only — never
written to a file on the target host. The known residual risk, documented
in code: a host running command-line auditing (auditd, "snoopy" loggers)
could capture that one command's full text, including the credential
values. This is the same trade-off restic's own docs describe for CI use;
avoiding a *persistent* remote credentials file was the higher-priority
property for v1.

## Local storage backend

`restic.backend: local` (see [config-reference.md](./config-reference.md))
points the repository at a plain filesystem path instead of R2/S3 — useful
for a self-hosted VPS with its own disk. It only works for `files` targets:
restic already runs on the target host for those, so a local path is just
a directory on that same machine, no network access needed. It doesn't
extend to database targets — see below.

## Database backups

Many databases (managed RDS-style services especially) offer no shell
access at all, so restic can't run on the database host itself the way it
does for files. Instead: the Actions runner connects to the database
directly (TLS) or via an SSH tunnel through a jump host (`src/ssh/tunnel.ts`,
for a database only reachable from a box you already have SSH access to),
runs `mysqldump`/`pg_dump` **locally on the runner**, and streams the dump
straight into `restic backup --stdin` (`src/util/exec.ts`'s `spawnPipeline`,
connecting the two processes via Node streams, not a shell pipe or a
buffered intermediate file) against the same shared repository — no
database-side installation required. The database password is passed via
`MYSQL_PWD`/`PGPASSWORD` environment variables, never a CLI argument.

Because the dump runs on the ephemeral runner rather than on a host you
control, database targets need a network-reachable restic repository
(`r2`, `s3`, or a reachable `custom`) — a `local` repository (see the local
storage section above) only works for `files` targets, whose restic
process runs on the target host itself. `src/adapters/database-common.ts`
rejects a `local` backend immediately with a clear error rather than
failing partway through a dump.

restic itself isn't preinstalled on GitHub-hosted runners either;
`src/restic/bootstrap-local.ts` installs the same pinned, checksum-verified
release locally (via `fetch` + `node:crypto`, no need to shell out for
networking or hashing the way the remote/SSH bootstrap does) before any
adapter — including the one-time repository-initialization step every run
needs regardless of target type.

A files target may override the global restic backend. This is how one
instance can keep MySQL/Postgres dumps in R2 while writing a VPS filesystem
snapshot to an attached disk. Live SQLite files can be declared through
`sqliteBackups`; baktime uses SQLite's online backup API and verifies the
copy before adding it to restic, avoiding inconsistent `.db`/WAL snapshots.

### Restoring a database snapshot into a live target

The `Restore snapshot into a live target` workflow
(`.github/workflows/restore.yml`, `src/cli/restore-snapshot.ts`) is the
inverse of the above: given a restic tag and a target name, it finds that
tag's latest `--stdin` snapshot, `restic dump`s it back out, and pipes it
straight into `mysql`/`psql` against the target — the same `spawnPipeline`
plumbing as the backup path, just with restic and the DB client swapped as
producer/consumer. It's manual (`workflow_dispatch` only) and destructive by
design: it drops the target's existing tables first (a plain
`mysqldump`/`pg_dump` doesn't emit its own `DROP` statements, so without
this an import into a non-empty database would just fail on the first
`CREATE TABLE`), which is why the workflow takes and commits a fresh backup
of the target *before* running the restore — so a wrong tag or target name
is always recoverable from history, not just theoretically.

## Command safety

Every external process invocation (`ssh`, `restic`, and eventually
`mysqldump`/`pg_dump`) goes through `execFile`/`spawn` with an argument
array — `src/util/exec.ts` is the single choke point, and nothing else in
the codebase calls `child_process` directly. SSH's remote side is the one
place a shell string is unavoidable (sshd hands it to the remote login
shell); `src/ssh/shell-quote.ts` layers POSIX single-quote escaping (which
makes every character except a literal quote completely inert to the
shell) with an allowlist that rejects human-authored values (paths,
hostnames) containing shell metacharacters outright, on the theory that a
path containing a semicolon or backtick is essentially always a mistake.
Secret values, which may legitimately contain any character, use the pure
escaping function without that allowlist.

## Manual verification checklist (before trusting this in production)

Automated tests cover config validation, secret discovery, scheduling
math, command-argument construction, and checksum verification — all
without touching real infrastructure (see the repo's test suite). They
cannot exercise the real network/SSH/restic/GitHub-API paths. Before
relying on a fresh instance:

1. Point one real `files` target at a real SSH host (ideally including one
   Alpine box) and trigger `backup.yml` via `workflow_dispatch`; confirm
   `history/<name>.yml` gets a `success` record with a real snapshot id.
2. Point one real `mysql` or `postgres` target at a real database — both a
   direct connection and, if you have one, a tunnel through a jump host —
   and confirm the same.
3. Confirm the restic repository actually has data:
   `restic snapshots --tag <name>` against your R2 bucket (or local path).
4. Deploy the Cloudflare Worker, run `sync-cloudflare-schedule.yml` once
   manually, and confirm a KV `manifest` key appears
   (`wrangler kv key get manifest --binding BAKTIME_SCHEDULES --remote`).
5. Wait for a real Worker tick to fire a `repository_dispatch` on its own
   and confirm `backup.yml` runs without your intervention.
6. Deliberately break something (wrong SSH key, unreachable host, wrong
   database password) and confirm a `failure` record with a readable
   `error` message appears in history — this is currently the only failure
   signal (Phase 5 adds automatic GitHub Issues on top of it).
