import { resolve } from "node:path";

/**
 * Shared configuration and primitives used across the server modules.
 *
 * Subdomain-routed static file server: <site>.<BASE_DOMAIN> -> sites/<site>/public/.
 * Locally, browsers resolve *.localhost to 127.0.0.1 automatically (RFC 6761),
 * so http://test-site.localhost:3000 works with zero DNS config. In production,
 * set BASE_DOMAIN to your real domain (e.g. example.com).
 */

export const PORT = Number(process.env.PORT ?? 3000);
export const BASE_DOMAIN = process.env.BASE_DOMAIN ?? "localhost";
export const SITES_DIR = resolve(import.meta.dir, "..", "sites");

// Body-size limits. The global cap is a host-memory backstop applied to every
// request by Bun.serve; it must clear the largest legitimate deploy asset
// (PUT /api/sites/<name>/files), so it's generous and env-overridable. Browser-
// writable KV / per-user values are opaque JSON blobs and get a much tighter cap.
export const MAX_REQUEST_BODY_BYTES = Number(
  process.env.SINGLEPAGE_MAX_BODY_BYTES ?? 25 * 1024 * 1024,
);
export const MAX_KV_VALUE_BYTES = 256 * 1024;

/**
 * Per-site kv storage quota: total bytes and total keys across a site's kv table,
 * plus a per-user cap on the reserved `user:<id>:*` namespace so a flood of
 * anonymous identities can't grow the DB. Read at write time (not import) so the
 * limits are env-tunable without a rebuild and overridable in tests. Coarse
 * safety caps sized for small single-page sites.
 */
export function kvQuota(): { bytes: number; rows: number; userKeys: number } {
  return {
    bytes: Number(process.env.SINGLEPAGE_MAX_SITE_KV_BYTES ?? 5 * 1024 * 1024),
    rows: Number(process.env.SINGLEPAGE_MAX_SITE_KV_ROWS ?? 10_000),
    userKeys: Number(process.env.SINGLEPAGE_MAX_USER_KV_KEYS ?? 100),
  };
}

/**
 * Per-client rate limits for the expensive/writable routes, as token-bucket
 * (requests/second, burst) pairs. `fn` gates /__fn/* (each request drives a
 * QuickJS run); `write` gates /__kv and /__me/kv mutations. Cheap reads and
 * static files are not limited. Read at request time so limits are env-tunable
 * without a rebuild and overridable in tests. Generous enough for normal SPA
 * use; they only bite a sustained flood.
 */
export function rateLimits(): Record<"fn" | "write", { rps: number; burst: number }> {
  return {
    fn: {
      rps: Number(process.env.SINGLEPAGE_RL_FN_RPS ?? 10),
      burst: Number(process.env.SINGLEPAGE_RL_FN_BURST ?? 30),
    },
    write: {
      rps: Number(process.env.SINGLEPAGE_RL_WRITE_RPS ?? 20),
      burst: Number(process.env.SINGLEPAGE_RL_WRITE_BURST ?? 60),
    },
  };
}

/**
 * The scheme + authority the client actually reached us on, for building
 * absolute URLs (a site's public address, sibling-site links). Behind a proxy
 * the browser hits us on 443/https with no explicit port; the Host header
 * carries the correct authority (with a port only when one is really in use) and
 * x-forwarded-proto (set by the front proxy) tells us the real scheme. Never
 * derive these from the internal listen PORT — that leaks :3000 into public URLs.
 */
export function requestOrigin(req: Request): { scheme: string; authority: string } {
  const scheme =
    req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
    new URL(req.url).protocol.replace(/:$/, "");
  const authority = req.headers.get("host") ?? `${BASE_DOMAIN}:${PORT}`;
  return { scheme, authority };
}

/** Build a JSON Response. */
export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
