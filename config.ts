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
export const SITES_DIR = resolve(import.meta.dir, "sites");

/** Build a JSON Response. */
export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
