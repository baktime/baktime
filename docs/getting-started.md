# Getting started

baktime is a **GitHub template repository**, the same way
[upptime](https://github.com/upptime/upptime) is: this repo
(`baktime/baktime`) is the public template, and you create your own
private instance from it (the way
[`mleczakm/infrastructure-status`](https://github.com/mleczakm/infrastructure-status)
relates to `upptime/upptime`).

**Backup metadata reveals hostnames, database names, and schedules** —
even without secrets or backup data, that's reconnaissance information
worth keeping private, unlike an uptime status page. Make your instance
repo **private**.

## 1. Create your instance repo

Click "Use this template" on `baktime/baktime`, create a new **private**
repository, and clone it locally.

## 2. Set up a Cloudflare R2 bucket

This is where your actual backup data lives (never in git). Create an R2
bucket and an API token scoped to it (Access Key ID + Secret Access Key).

## 3. Edit `.baktimerc.yml`

Set `owner`, `repo`, and `restic.repository` to your R2 bucket's S3-style
URL. See [config-reference.md](./config-reference.md) for every field.

## 4. Set the baseline GitHub secrets

`RESTIC_PASSWORD`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `GH_PAT` — see
[secrets.md](./secrets.md) for what each one is and how to scope it
(`GH_PAT` especially).

## 5. Add your first target

Pick one real, low-stakes host to start with. Follow "Adding a target" in
[secrets.md](./secrets.md) to create its `BAKTIME_TARGET_<NAME>` secret
and SSH key secret.

## 6. Deploy the Cloudflare Worker

```bash
cd cloudflare-worker
npx wrangler kv namespace create BAKTIME_SCHEDULES
# paste the printed id into wrangler.toml's [[kv_namespaces]] id field,
# and set GITHUB_OWNER/GITHUB_REPO in wrangler.toml's [vars] to your instance repo
npx wrangler deploy
```

Or push a change under `cloudflare-worker/` to `main` and let
`deploy-cloudflare-worker.yml` do it.

## 7. Run the sync workflow once

Actions tab → "Sync Cloudflare schedule manifest" → **Run workflow**. This
pushes your target's `{name, type, schedule}` into the Worker's KV so it
knows what to look for (otherwise it waits up to ~15 minutes for its own
schedule to do this for you).

## 8. Trigger your first backup manually

Actions tab → "Backup" → **Run workflow**. This is the `workflow_dispatch`
fallback path — it discovers and runs everything currently due, without
waiting for the Worker's next tick.

Check `history/<your-target-name>.yml` for a `success` record, and confirm
data actually landed: `restic snapshots --tag <your-target-name>` against
your R2 bucket (with `RESTIC_REPOSITORY`/`RESTIC_PASSWORD`/AWS credentials
set locally).

## 9. Let it run itself

From here, the Worker's cron tick and `sync-cloudflare-schedule.yml`'s own
loose schedule keep things running without further action — see
[architecture.md](./architecture.md) for the full trigger loop, and the
manual verification checklist there before you fully trust a new instance.

## What's not here yet

Database targets (`mysql`/`postgres`), the status site, retention/pruning,
and restore drills are on the roadmap but not built yet — see
`../ROADMAP.md`. A `files` target end-to-end is what this pass delivers.
