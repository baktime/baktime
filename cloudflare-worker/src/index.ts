import { CronExpressionParser } from "cron-parser";

export interface Env {
  BAKTIME_SCHEDULES: KVNamespace;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  DISPATCH_EVENT_TYPE: string;
  GH_PAT: string;
}

interface ScheduleManifestEntry {
  name: string;
  type: "files" | "mysql" | "postgres";
  schedule: string;
}

const MANIFEST_KEY = "manifest";
const STATUS_PAGE_KEY = "status-page";
const SCHEDULE_TZ = "UTC";

/**
 * Duplicated (deliberately, not shared) from src/scheduling/is-due.ts: this
 * Worker is a separate bundle target (Workers runtime, not Node) in its own
 * npm workspace, and this is ~10 lines of pure cron-parser logic — not
 * enough to justify cross-workspace source sharing for Phase 1. Keep the
 * two in sync if the semantics ever change (a shared `scheduling` package
 * would be the right fix if this grows).
 */
function mostRecentOccurrence(schedule: string, asOf: Date): Date {
  const cron = CronExpressionParser.parse(schedule, {
    currentDate: new Date(asOf.getTime() + 1000),
    tz: SCHEDULE_TZ,
  });
  return cron.prev().toDate();
}

async function dispatchBackup(env: Env, targetName: string): Promise<void> {
  const response = await fetch(
    `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GH_PAT}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "baktime-dispatcher",
      },
      body: JSON.stringify({
        event_type: env.DISPATCH_EVENT_TYPE,
        client_payload: { target: targetName },
      }),
    },
  );

  if (!response.ok) {
    // Cloudflare surfaces console output in the dashboard's Worker logs —
    // deliberately not retried/queued here (see wrangler.toml comment: this
    // stays a dumb dispatcher with no state beyond the KV schedule/lastfired
    // keys), consistent with the reference project's cron-trigger pattern.
    console.error(
      `repository_dispatch for "${targetName}" failed: HTTP ${response.status} ${await response.text()}`,
    );
  }
}

async function tick(env: Env): Promise<void> {
  const manifestRaw = await env.BAKTIME_SCHEDULES.get(MANIFEST_KEY);
  if (!manifestRaw) {
    console.log(
      "No schedule manifest in KV yet — has sync-cloudflare-schedule.yml run at least once?",
    );
    return;
  }

  let manifest: ScheduleManifestEntry[];
  try {
    manifest = JSON.parse(manifestRaw);
  } catch (error) {
    console.error("Schedule manifest in KV is not valid JSON:", error);
    return;
  }

  const now = new Date();

  for (const entry of manifest) {
    let mostRecentDue: Date;
    try {
      mostRecentDue = mostRecentOccurrence(entry.schedule, now);
    } catch (error) {
      console.error(`Skipping "${entry.name}": invalid schedule "${entry.schedule}":`, error);
      continue;
    }
    if (mostRecentDue.getTime() > now.getTime()) {
      continue; // defensive: shouldn't happen given the +1s nudge in mostRecentOccurrence
    }

    const lastFiredKey = `lastfired:${entry.name}`;
    const lastFiredRaw = await env.BAKTIME_SCHEDULES.get(lastFiredKey);
    if (lastFiredRaw && new Date(lastFiredRaw).getTime() >= mostRecentDue.getTime()) {
      continue; // already dispatched for this occurrence
    }

    await dispatchBackup(env, entry.name);
    await env.BAKTIME_SCHEDULES.put(lastFiredKey, now.toISOString());
  }
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(tick(env));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return new Response("ok", { headers: { "Cache-Control": "no-store" } });
    }
    if (url.pathname !== "/") {
      return new Response("Not found", { status: 404 });
    }

    const html = await env.BAKTIME_SCHEDULES.get(STATUS_PAGE_KEY);
    if (!html) {
      return new Response("baktime status page has not been generated yet", { status: 503 });
    }
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=60",
        "X-Content-Type-Options": "nosniff",
      },
    });
  },
} satisfies ExportedHandler<Env>;
