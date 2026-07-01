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

/** Build a JSON Response. */
export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
