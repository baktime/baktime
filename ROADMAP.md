# Roadmap

Done: `.baktimerc.yml` schema, secrets-driven dynamic target discovery,
cron-based scheduling, the full `files`-target backup path
(self-bootstrapping remote restic over SSH), the full `mysql`/`postgres`
backup path (direct or SSH-tunnel connection, dump streamed straight into
`restic backup --stdin` on the runner), a local-filesystem restic backend
option (files targets only), history, the
`backup.yml`/`sync-cloudflare-schedule.yml`/`ci.yml`/`deploy-cloudflare-worker.yml`
workflows, and the schedule-aware Cloudflare Worker. See
`docs/architecture.md` for how it all fits together.

Everything below is designed for (schema/workflow shape already exists as
placeholders where relevant) but not implemented.

## Phase 3 — History, status site, pruning

- `src/status/generate-api.ts`: reads all `history/*.yml`, computes
  per-target health (`healthy | late | failing` based on last-run age vs.
  schedule), writes `api/summary.json` and `api/<target>.json`.
- `src/status/generate-graphs.ts`: size/duration trend series per target,
  written as JSON for a client-side chart rather than server-rendered
  images (no headless-canvas dependency in CI).
- `status-site/`: a small Vite + vanilla TS (or Preact) static site reading
  the generated `api/*.json`/`graphs/*.json` — **not** a fork of upptime's
  Svelte site, since its data model (response times, up/down) doesn't map
  onto backup-shaped data (last-run age, byte deltas, restore-verified
  status) closely enough to be worth inheriting its build tooling. Deployed
  via `site.yml` to GitHub Pages.
- `prune.yml`: for each target's `retention` policy, `restic forget
  --prune --tag <name>` then `restic check`; writes a `prune`-type history
  record; opens an issue on `check` failure (ties into Phase 5's issue
  automation).

## Phase 4 — Worker/KV soak test

Extended real-world validation of the Worker/KV dispatch loop against a
live instance repo over days, not just the one-shot manual checklist in
`docs/architecture.md` — confirming no missed or duplicate dispatches
across restarts, KV eventual-consistency edge cases, and Worker redeploys.

## Phase 5 — Restore drills and incident automation

- `restore-drill.yml`: weekly (or configurable sample), matrix over
  targets. For `files`: restore a sampled path from the latest snapshot
  into a scratch directory **on the same host** (not the runner — the
  runner doesn't share the original filesystem context) via `restic
  restore latest --target <scratch> --path <sample>`, verify restored file
  count, clean up. For `mysql`/`postgres`: restore the latest `--stdin`
  snapshot into a throwaway GitHub Actions `services:` database container,
  load it, run a minimal sanity check. Extends `HistoryRecord` with
  `restoreVerified: { at, snapshotId, ok, detail }` — surfaced on the
  status site as "last verified restore", since a backup that's never been
  test-restored can look "healthy" indefinitely on backup-success alone.
- `summary.yml`: re-derives health per target from `api/*.json`, opens a
  labeled GitHub Issue on a healthy→failing transition (with a link to the
  failing run), comments "resolved" and closes it on failing→healthy —
  directly mirroring upptime's incident-issue automation. A restore-drill
  failure gets a distinct label from a backup failure, since a failed
  restore drill alongside succeeding backups is a more urgent signal (data
  may be silently unrestorable).

## Phase 6 — Integration test harness

`test/docker-compose.test.yml`: an Alpine (musl) container with `sshd` and
a baked-in test keypair (exercises the real remote-restic bootstrap+backup
path), `mysql`/`postgres` containers with seeded test data (direct and
tunnel-via-a-second-jump-container modes), and MinIO as an S3-compatible
stand-in for R2 (restic's S3 backend code path is identical against it).
Wired into `ci.yml` so PRs — including from external contributors, since no
real credentials are involved — exercise the real adapters without
touching real infrastructure.

## Deliberately deferred / open design questions

- **Release/versioning strategy** for the template repo itself
  (`release.yml` is a placeholder) — instances consume this repo via "Use
  this template" and build from source, not via a versioned
  `uses: baktime/baktime@v1` external Action, so the usual JS-Action
  release hygiene doesn't directly apply here. Worth revisiting once the
  template has real users making upgrade decisions.
- **GPG signature verification** of restic's `SHA256SUMS.asc` on top of the
  SHA256 check already enforced in `bootstrap-remote.ts` — needs embedding
  and rotating a trusted public key, a bigger commitment than the mandatory
  hash check alone.
