import { PORT, BASE_DOMAIN, SITES_DIR } from "./config.ts";
import {
  EVENTS_PATH,
  addClient,
  removeClient,
  onSubMessage,
  type WsData,
} from "./events.ts";
import { handleKv } from "./kv.ts";
import { handleApi } from "./api.ts";
import {
  siteFromHost,
  apexResponse,
  INJECT_PATH,
  serveInjectScript,
  serveStatic,
} from "./sites.ts";
import { FN_PREFIX, handleServer } from "./server.ts";
import { startCron } from "./cron.ts";

/**
 * Subdomain-routed static file server. Each <site>.<BASE_DOMAIN> maps to
 * sites/<site>/public/, with a per-site key/value store (/__kv), live event
 * stream (/__events), and a token-gated management API (/api/*). See the
 * individual modules for details.
 */
const server = Bun.serve<WsData>({
  port: PORT,
  async fetch(req, server) {
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

    // Reserved route: per-site event stream (live reload + kv changes) over a
    // WebSocket. The socket's per-page subscription filter lives on ws.data.
    if (pathname === EVENTS_PATH) {
      if (server.upgrade(req, { data: { site, patterns: new Set() } })) return;
      return new Response("expected websocket", { status: 426 });
    }

    // Reserved route: per-site key/value store (host-scoped, browser-accessible).
    if (pathname === "/__kv" || pathname.startsWith("/__kv/")) {
      const rawKey = pathname === "/__kv" ? "" : pathname.slice("/__kv/".length);
      const key = rawKey ? decodeURIComponent(rawKey) : null;
      return handleKv(req, site, key);
    }

    // Reserved route: the shared injected client, available on every subdomain.
    if (pathname === INJECT_PATH) return serveInjectScript();

    // Reserved route: per-site server-side function handlers.
    if (pathname === FN_PREFIX || pathname.startsWith(FN_PREFIX + "/")) {
      return handleServer(req, site, url);
    }

    // Everything else: a static file from the site's public/ dir.
    return serveStatic(site, pathname);
  },
  websocket: {
    open: addClient,
    message: onSubMessage,
    close: removeClient,
  },
});

// Schedule each site's cron jobs from its singlepage.json.
startCron();

console.log(`Serving sites from ${SITES_DIR}`);
console.log(`Listening on http://${BASE_DOMAIN}:${server.port}`);
console.log(`Try http://test-site.${BASE_DOMAIN}:${server.port}/`);
