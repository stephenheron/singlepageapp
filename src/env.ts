import { join } from "node:path";
import { statSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { SITES_DIR } from "./config.ts";

/**
 * Per-site environment variables, exposed to server/cron code as `ctx.env`.
 *
 * A site's secrets live in a plain `.env` file at the site root
 * (sites/<name>/.env) — uploaded via the deploy-key API, kept OUTSIDE public/ so
 * it is never served, and never broadcast. This module reads that file (parsed
 * with Node's built-in dotenv parser) and hands the values to the sandbox.
 * There is no writing from user code: the file is the single source of truth,
 * managed out-of-band by whoever holds the deploy key (see the CLI's `.env` sync
 * and api.ts's upload allow-list).
 */

// Cache the parsed result per site, keyed on the file's mtime+size so an updated
// `.env` (re-uploaded through the API) is picked up on the next run without a
// server restart, while unchanged files avoid a re-read + re-parse each call.
// A per-call statSync (~1µs warm) is the only steady-state cost.
const cache = new Map<string, { sig: string; env: Record<string, string> }>();

/** Parsed `.env` for a site (empty object if the file is absent or unreadable). */
export function readSiteEnv(site: string): Record<string, string> {
  const path = join(SITES_DIR, site, ".env");
  let sig: string;
  try {
    const s = statSync(path);
    sig = `${s.mtimeMs}:${s.size}`;
  } catch {
    cache.delete(site); // file gone -> forget any cached values
    return {};
  }
  const hit = cache.get(site);
  if (hit && hit.sig === sig) return hit.env;

  let env: Record<string, string> = {};
  try {
    // parseEnv types values as string | undefined (Dict); they're always strings.
    env = parseEnv(readFileSync(path, "utf8")) as Record<string, string>;
  } catch {
    env = {}; // unreadable between stat and read -> treat as empty
  }
  cache.set(site, { sig, env });
  return env;
}
