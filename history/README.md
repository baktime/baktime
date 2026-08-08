# history/

Empty in this template. In an instance repo, `backup.yml` writes one
growing YAML file per target here — `<target-name>.yml` — each entry a
timestamped run record (success/failure, restic snapshot id, bytes added,
duration). Small enough to commit; the actual backup data lives in your
restic repository, never here. See `../docs/architecture.md`.
