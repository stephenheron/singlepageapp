import { PORT, BASE_DOMAIN } from "./config.ts";
import { EVENTS_PATH, eventStream } from "./events.ts";
import { handleKv } from "./kv.ts";
import { handleApi } from "./api.ts";
import {
  siteFromHost,
  apexResponse,
  INJECT_PATH,
  serveInjectScript,
  serveStatic,
} from "./sites.ts";

/**
 * Subdomain-routed static file server. Each <site>.<BASE_DOMAIN> maps to
 * sites/<site>/public/, with a per-site key/value store (/__kv), live event
 * stream (/__events), and a token-gated management API (/api/*). See the
 * individual modules for details.
 */
const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // Management API — handled before host-based routing.
    if (url.pathname.startsWith("/api/")) return handleApi(req, url);

    const site = siteFromHost(req.headers.get("host"));

    // No subdomain -> apex listing page (or an unknown host).
    if (site === null) {
      const hostname = (req.headers.get("host") ?? "").split(":")[0];
      if (hostname === BASE_DOMAIN || hostname === "") return apexResponse();
      return new Response("Unknown host", { status: 404 });
    }

    const { pathname } = url;

    // Reserved route: per-site event stream (live reload + kv changes).
    if (pathname === EVENTS_PATH) return eventStream(site);

    // Reserved route: per-site key/value store (host-scoped, browser-accessible).
    if (pathname === "/__kv" || pathname.startsWith("/__kv/")) {
      const rawKey = pathname === "/__kv" ? "" : pathname.slice("/__kv/".length);
      const key = rawKey ? decodeURIComponent(rawKey) : null;
      return handleKv(req, site, key);
    }

    // Reserved route: the shared injected client, available on every subdomain.
    if (pathname === INJECT_PATH) return serveInjectScript();

    // Everything else: a static file from the site's public/ dir.
    return serveStatic(site, pathname);
  },
});

console.log(`Serving sites from ${import.meta.dir}/sites`);
console.log(`Listening on http://${BASE_DOMAIN}:${server.port}`);
console.log(`Try http://test-site.${BASE_DOMAIN}:${server.port}/`);
