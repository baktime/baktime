# Secrets

All secrets are set under your instance repo's **Settings → Secrets and
variables → Actions**. None of them are ever written to `.baktimerc.yml` or
any other committed file.

## Baseline secrets (every instance needs these)

| Secret name | Used for |
|---|---|
| `RESTIC_PASSWORD` | Encrypts the restic repository. Generate with e.g. `openssl rand -base64 32`. **Losing this means losing access to every backup** — store a copy somewhere outside baktime too. |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Cloudflare R2 API token scoped to the one bucket used as the restic repository. (Names are configurable via `.baktimerc.yml`'s `restic.*SecretName` fields — these are just the documented defaults.) |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | Used by `deploy-cloudflare-worker.yml` and `sync-cloudflare-schedule.yml` to deploy the Worker and write to its KV namespace. |
| `GH_PAT` | Set as a **Cloudflare Worker secret** (`wrangler secret put GH_PAT`, done automatically on every deploy from this same GitHub secret) — this is what the Worker uses to call GitHub's `repository_dispatch` API. |

### Scoping `GH_PAT`

This is more sensitive than it looks. A leaked `GH_PAT` doesn't just let
someone trigger a workflow run — it lets them trigger `backup.yml`, which
decrypts every target's SSH keys and database passwords on the runner it
spins up. Scope it as narrowly as GitHub allows:

- A **fine-grained personal access token**, not a classic PAT.
- **Repository access**: only this one instance repo — never "all
  repositories".
- **Permissions**: `Contents: Read` and `Actions: Write` — nothing else.
  (`repository_dispatch` requires the token to be able to write to Actions;
  double-check this against current GitHub docs when you set it up, since
  exact scope requirements for this endpoint have shifted across GitHub API
  versions.)
- Rotate it periodically, and immediately if you ever suspect it leaked
  (Worker logs, a compromised laptop, etc.) — rotating is just generating a
  new PAT, updating the `GH_PAT` GitHub secret, and re-running
  `deploy-cloudflare-worker.yml` (or `wrangler secret put GH_PAT` directly).

This is a deliberately higher bar than upptime's equivalent token needs,
because upptime's target repo and its Actions are public/non-sensitive by
design — baktime's aren't.

## Per-target secrets

Each target is itself a secret — see [config-reference.md](./config-reference.md)
for the full JSON shape. In short:

- `BAKTIME_TARGET_<NAME>` — the target definition (host, paths, schedule,
  etc.) as a JSON blob.
- One or more satellite secrets referenced *from* that JSON by name (e.g.
  `sshKeySecretName: "BAKTIME_TARGET_WEBSERVER1_SSH_KEY"`) — SSH private
  keys, database passwords. You choose these names; the target's JSON
  blob just has to reference them correctly.

### Adding a target

1. Create the satellite secret(s) first (e.g. paste the SSH private key
   into a new secret named `BAKTIME_TARGET_WEBSERVER1_SSH_KEY`).
2. Create `BAKTIME_TARGET_WEBSERVER1` with the JSON blob, referencing that
   secret's name.
3. Optionally add `webserver1` to `.baktimerc.yml`'s `knownTargets` list —
   purely for documentation/CI-lint, not required for the target to work.
4. Either wait up to ~15 minutes for `sync-cloudflare-schedule.yml`'s own
   schedule to pick it up, or run it manually
   (Actions tab → "Sync Cloudflare schedule manifest" → Run workflow) to
   have the Worker start considering it immediately.
5. To back it up right now without waiting on any schedule at all, run
   `backup.yml` manually via `workflow_dispatch`.

### Removing a target

Delete the `BAKTIME_TARGET_<NAME>` secret (and its satellites, if unused
elsewhere). Its existing `history/<name>.yml` and restic snapshots aren't
touched — deleting the secret only stops future backups.

## Notifications

Configured exactly the same way upptime configures its own notification
channels — nothing in `.baktimerc.yml` beyond the optional, non-authoritative
`secrets:` documentation list. A provider is:

1. **Enabled** via a `NOTIFICATION_<PROVIDER>` secret set to the literal
   string `"true"` (or `"1"`).
2. **Configured** via `NOTIFICATION_<PROVIDER>_<SETTING>` secrets.

### Discord

| Secret name | Required | Value |
|---|---|---|
| `NOTIFICATION_DISCORD` | yes | `"true"` |
| `NOTIFICATION_DISCORD_WEBHOOK_URL` | yes | A Discord webhook URL — create one in your server under *Channel Settings → Integrations → Webhooks*. |

Sends a color-coded embed on every backup attempt: green with the snapshot
id and data size on success, red with the error message on failure. It also
sends a weekly aggregate report every Monday at 08:17 UTC with every
target's schedule-aware health, retained snapshot and file counts, raw
repository storage after deduplication, total recorded backups, and the
last seven days' successes/failures. Run `summary.yml` manually from the
Actions tab to test it immediately (see `src/notifications/discord.ts`). If
`NOTIFICATION_DISCORD` is `"true"` but
the webhook URL secret is missing, baktime logs a clear warning and skips
Discord rather than failing the backup itself — a notification channel
being unreachable must never be mistaken for the backup having failed.

Repository totals are collected with `restic stats --mode raw-data`. If one
configured repository is temporarily unreachable, the report still sends
the totals it could collect and marks the missing repository count. Local
repositories are inspected over the corresponding files target's SSH
connection; network repositories such as R2/S3 are inspected once from the
Actions runner.

### Future providers

`src/notifications/dispatch.ts`'s `discoverNotificationChannels` is where
each provider registers itself — adding Slack, email, or anything else
later is additive (read its own `NOTIFICATION_<PROVIDER>*` secrets, push a
channel), not a redesign. See `ROADMAP.md`.

## Why the whole secrets context is passed as one JSON blob

Every workflow step that needs to discover targets sets
`env: BAKTIME_SECRETS_JSON: ${{ toJSON(secrets) }}` rather than naming
individual secrets in `env:`. GitHub Actions has no way to reference "every
secret matching a pattern" directly in workflow YAML — `toJSON(secrets)` is
the documented way to get all of them into one place for a script to filter
programmatically, and it's exactly what upptime does for its own dynamic
notification config. GitHub's runner still masks every individual secret
value in logs regardless of how it was referenced, so this doesn't weaken
log redaction — see `src/config/secrets.ts` for baktime's own
defense-in-depth redaction on top of that.
