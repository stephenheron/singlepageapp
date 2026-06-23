import { readdirSync } from "node:fs";
import { join } from "node:path";
import { Cron } from "croner";
import { SITES_DIR } from "./config.ts";
import { runModule } from "./sandbox.ts";
import { appendLog } from "./kv.ts";

/**
 * Per-process cron scheduler. Each site's singlepage.json carries a `cron` map
 * of { jobName: cronExpression }; jobName runs sites/<site>/cron/<jobName>.js on
 * that schedule. The config is the source of truth — a job with no matching file
 * logs an error when it fires; a file with no config entry is never scheduled.
 *
 * The job handler's default export is called as (event, ctx), where event is
 * { job, scheduledAt } and ctx is the same host API server handlers receive
 * (kv, console, fetch) — minus any request.
 */

const CRON_DEADLINE_MS = 30_000; // wall-clock budget per cron run
const jobsBySite = new Map<string, Cron[]>();

/** Read a site's { jobName: expr } cron map from singlepage.json. */
async function readCronConfig(site: string): Promise<Record<string, string>> {
  try {
    const cfg = (await Bun.file(join(SITES_DIR, site, "singlepage.json")).json()) as {
      cron?: unknown;
    };
    return cfg?.cron && typeof cfg.cron === "object" ? (cfg.cron as Record<string, string>) : {};
  } catch {
    return {}; // missing/invalid config -> no jobs
  }
}

/** Stop and forget every scheduled job for a site. */
function stopSite(site: string): void {
  const jobs = jobsBySite.get(site);
  if (!jobs) return;
  for (const job of jobs) job.stop();
  jobsBySite.delete(site);
}

/** (Re)build a site's schedule from its current singlepage.json. */
export async function rescheduleSite(site: string): Promise<void> {
  stopSite(site);
  const cron = await readCronConfig(site);
  const jobs: Cron[] = [];

  for (const [name, expr] of Object.entries(cron)) {
    if (typeof expr !== "string" || !expr.trim()) continue;
    const relpath = `cron/${name}.js`;
    try {
      // `protect` skips a tick if the previous run of this job is still going.
      const job = new Cron(expr, { name: `${site}:${name}`, protect: true }, async () => {
        const res = await runModule(
          site,
          relpath,
          { job: name, scheduledAt: Date.now() },
          { deadlineMs: CRON_DEADLINE_MS, source: relpath },
        );
        if (!res.ok) {
          appendLog(site, relpath, "error", `cron "${name}" failed: ${res.error}`);
        }
      });
      jobs.push(job);
    } catch (e) {
      // Invalid expression — log and skip, never let it break the scheduler.
      appendLog(site, "cron", "error", `invalid cron expression for "${name}": ${(e as Error).message}`);
    }
  }

  if (jobs.length) jobsBySite.set(site, jobs);
}

/** Schedule every site found on disk. Called once at server boot. */
export function startCron(): void {
  let sites: string[] = [];
  try {
    sites = readdirSync(SITES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return; // sites dir missing — nothing to schedule
  }
  for (const site of sites) void rescheduleSite(site);
}
