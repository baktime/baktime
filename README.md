[![baktime · GitHub Actions × restic](assets/baktime-banner.png)](https://baktime.github.io/)

# Simple backups, run by GitHub Actions

Schedule encrypted backups of PostgreSQL, MySQL and Linux files from a private GitHub repository. Choose what to copy and when. GitHub Actions runs the jobs, and restic sends only new data blocks to storage you control. Get backup reports in Discord or use GitHub’s email notifications for workflows you trigger.

[Create your repository from the template](https://github.com/baktime/baktime/generate) · [English setup guide](https://baktime.github.io/?lang=en#start) · [Instrukcja po polsku](https://baktime.github.io/pl/#start)

The template is free. Running costs depend on your private repository’s Actions minutes, storage and Cloudflare usage. [See how the free allowances apply](https://baktime.github.io/#cost).

## What you can back up

- **Files** on any Linux host reachable over SSH (Alpine or glibc, no root
  needed) — including transactionally consistent copies of live SQLite
  databases.
- **MySQL and PostgreSQL** databases, connected directly or through an SSH
  tunnel via a jump host.

## What you get

- **Schedules per target** — any cron expression, evaluated in UTC.
- **Encrypted, deduplicated, incremental storage** — restic encrypts
  everything client-side; only changed data is uploaded.
- **Retention** — e.g. keep 14 daily, 8 weekly and 12 monthly snapshots;
  older ones are forgotten and pruned daily.
- **Run history in git** — every run is recorded in `history/<target>.yml`
  (time, duration, snapshot id, bytes added, errors), never the data itself.
- **Status page** — every target's health (healthy / late / failing /
  never run) and recent runs, served by a small Cloudflare Worker.
- **Notifications** — in the channel you choose: Discord, Slack, Telegram,
  or a generic JSON webhook for your own automation (any combination). A
  message on every backup success or failure and on any retention failure,
  plus a weekly report with health, snapshot counts and storage used.
- **Restores** — a manual workflow restores a database snapshot in place
  (after taking a safety backup first), or a files snapshot into a staging
  directory on its host.

## How it works

```
GitHub secrets        one BAKTIME_TARGET_<NAME> JSON secret per target (+ its SSH key / DB password secrets)
  │
  ├─ sync-cloudflare-schedule.yml   every 15 min: copies each target's name + schedule (nothing sensitive) into Cloudflare KV
  │
Cloudflare Worker                   every 5 min: checks which targets are due and triggers backup.yml for exactly those
  │
  └─ backup.yml                     reads the target from secrets, runs the backup, commits history/<target>.yml
       ├─ files target:     SSH to the host, install a checksum-verified restic there, run `restic backup` on the host
       └─ database target:  `mysqldump` / `pg_dump` on the runner, streamed straight into `restic backup --stdin`

prune.yml     daily: `restic forget` per target by its retention policy, then `prune` + `check`
summary.yml   weekly: health and storage report to your notification channels
site.yml      after each history commit: rebuilds the status page
restore.yml   manual: restore a snapshot
```

The main design decisions:

- **Targets live in secrets, not in git.** Which hosts and databases you
  back up is itself sensitive, so the committed config (`.baktimerc.yml`)
  holds only non-sensitive instance settings. Adding or removing a target
  means adding or removing a secret — no commit needed.
- **File data never passes through GitHub.** restic runs on the host being
  backed up and talks to storage directly, so large file trees stay fast
  and incremental.
- **Database dumps are never written to disk** — they're streamed from the
  dump tool into restic, which also works for managed databases you can't
  install anything on.
- **The Worker exists only for reliable timing.** GitHub's own `schedule:`
  trigger can be delayed or skipped under load; the Worker is a tiny,
  stateless dispatcher.

See [`docs/architecture.md`](docs/architecture.md) for the full design.

## Getting started

Create a private repository, connect an R2 bucket and add your first target as a repository secret. For example, a secret named `BAKTIME_TARGET_SHOP` can schedule a PostgreSQL database for 02:00 UTC each day. Run **Actions → Backup → Run workflow**, then check `history/shop.yml` for the snapshot ID.

The [setup guide](docs/getting-started.md) covers the scheduler, credentials and first run. The [English](https://baktime.github.io/?lang=en#start) and [Polish](https://baktime.github.io/pl/#start) walkthroughs include complete database and file target examples.

## Documentation

- [`docs/getting-started.md`](docs/getting-started.md) — set up your own instance
- [`docs/config-reference.md`](docs/config-reference.md) — `.baktimerc.yml`, target JSON and retention reference
- [`docs/secrets.md`](docs/secrets.md) — which secrets to create and how to scope them
- [`docs/architecture.md`](docs/architecture.md) — the full design and its trade-offs
- [`docs/rollback.md`](docs/rollback.md) — restoring database and files snapshots
- [`ROADMAP.md`](ROADMAP.md) — what's built and what's planned (next: automated restore drills)

---
*Inspired by [upptime](https://github.com/upptime/upptime)'s "the GitHub repo is the whole app" approach; backups by [restic](https://restic.net/).*

[Say thanks on Suppi](https://suppi.pl/mleczakm)
