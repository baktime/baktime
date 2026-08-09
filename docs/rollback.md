# Rolling back to a previous backup

baktime's restore path is the `Restore snapshot into a live target` workflow
(`.github/workflows/restore.yml`, on top of `src/cli/restore-snapshot.ts`).
It's `workflow_dispatch` only — nothing ever restores automatically — and it
always takes a fresh backup of the target you're about to overwrite *before*
touching anything, so a wrong tag or target name is recoverable from
`history/*.yml`, not just theoretically.

## Finding what's available to restore

Every successful run is recorded in `history/<target-name>.yml`, newest last,
each entry with its `snapshotId` and `timestamp`. The generated status page
also presents the ten most recent runs/snapshot IDs for every active target;
`site.yml` publishes it through the same Cloudflare Worker used for schedules
and uploads a downloadable `status-site` workflow artifact.

## Rolling back a database (mysql/postgres) target

Run the workflow from the Actions tab (or `gh workflow run "Restore snapshot into a live target" -f from_tag=<tag> -f into_target=<target>`), where:

- `from_tag` is the restic tag to restore *from* — normally just the source
  target's own name, since every backup is tagged with its target name. Use
  a different target's name here when you're deliberately restoring one
  database's data into another (as with a mikr.us account migration).
- `into_target` is the target whose live database gets overwritten.

This is destructive by design and restores **in place**: the workflow

1. backs up `into_target`'s current contents and commits that to `history/`,
2. drops every existing table in `into_target`'s database (a plain
   `mysqldump`/`pg_dump` doesn't emit its own `DROP` statements, so without
   this an import into a non-empty database just fails on the first `CREATE
   TABLE`),
3. streams the snapshot's dump straight into `mysql`/`psql` against
   `into_target`'s own credentials.

If you picked the wrong tag, the pre-restore safety backup is what gets you
back — run the same workflow again with `from_tag` set to `into_target`'s own
name to restore its pre-rollback state.

## Rolling back a files target

Files targets are **not** restored in place — there's no equivalent of "drop
the tables first" that makes a blind overwrite of a live (possibly running)
file tree safe. Instead, running the same workflow against a `files` target
restores the snapshot into a fresh staging directory on the target host
itself (restic already runs there for files targets — see
`docs/architecture.md`):

```
/storage/restore/<target-name>-<snapshot-short-id>/
```

with the snapshot's original absolute paths preserved underneath it (e.g.
`/storage/restore/wanda-vps-local-abc1234/opt/projects/...`). The workflow
run's log prints the exact path. From there, rolling back is a deliberate
step you take yourself, on the host:

```bash
# review first
diff -rq /storage/restore/wanda-vps-local-abc1234/opt/projects /opt/projects

# then copy back whatever you've confirmed you want restored
rsync -a --delete /storage/restore/wanda-vps-local-abc1234/opt/projects/ /opt/projects/
```

This is intentionally a human decision point, not something the tool
automates — a files snapshot can span multiple unrelated paths (application
code, a docker volume, ...) and silently clobbering live files is a much
worse failure mode than having to run one `rsync` yourself.

For snapshots that include `sqliteBackups`, the consistent database copies
appear under their configured staging paths in the restored tree. Stop the
application container before replacing its live SQLite files, preserve file
ownership, and restart it only after running `PRAGMA integrity_check` on the
restored copies.

## Safety notes

- `restore.yml` is `workflow_dispatch`-only; nothing triggers it
  automatically.
- The pre-restore safety backup uses the exact same code path as a normal
  scheduled backup (`run-target.js`), so it's exercised constantly, not just
  when something's already gone wrong.
- Restoring a database target requires the same database client tools
  (`mysql`/`psql`) the workflow already installs for backups — no extra
  setup.
