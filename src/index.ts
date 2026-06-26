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
  isKnownHost,
  apexResponse,
  INJECT_PATH,
  serveInjectScript,
  serveStatic,
} from "./sites.ts";
import { FN_PREFIX, handleServer } from "./server.ts";
import { resolveIdentity, handleMe } from "./identity.ts";
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

    // Liveness/readiness probe (kamal-proxy health check, uptime monitors).
    if (url.pathname === "/up") return new Response("ok");

    // Management API — handled before host-based routing.
    if (url.pathname.startsWith("/api/")) return handleApi(req, url);

    // On-demand TLS gate for a front proxy: does this host map to a real site?
    // Used by Caddy's on_demand_tls `ask` to scope cert issuance (see
    // config/Caddyfile). Host-agnostic, so it must precede subdomain routing.
    if (url.pathname === "/internal/allow_domain") {
      return isKnownHost(url.searchParams.get("domain"))
        ? new Response("ok")
        : new Response("unknown host", { status: 404 });
    }

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
    // Handled before identity since an upgrade response carries no cookie.
    if (pathname === EVENTS_PATH) {
      if (server.upgrade(req, { data: { site, patterns: new Set() } })) return;
      return new Response("expected websocket", { status: 426 });
    }

    // Resolve the anonymous visitor identity (signed sp_uid cookie). Minted once
    // and then carried by the browser; attach the Set-Cookie to whatever response
    // the route below produces.
    const identity = resolveIdentity(req, site);
    const withCookie = (res: Response): Response => {
      if (identity.setCookie) res.headers.append("set-cookie", identity.setCookie);
      return res;
    };

    // Reserved route: per-user identity + per-user kv (scoped to the cookie's id).
    if (pathname === "/__me" || pathname.startsWith("/__me/")) {
      return withCookie(await handleMe(req, site, identity.id, pathname));
    }

    // Reserved route: per-site key/value store (host-scoped, browser-accessible).
    if (pathname === "/__kv" || pathname.startsWith("/__kv/")) {
      const rawKey = pathname === "/__kv" ? "" : pathname.slice("/__kv/".length);
      const key = rawKey ? decodeURIComponent(rawKey) : null;
      return withCookie(await handleKv(req, site, key));
    }

    // Reserved route: the shared injected client, available on every subdomain.
    if (pathname === INJECT_PATH) return withCookie(await serveInjectScript());

    // Reserved route: per-site server-side function handlers.
    if (pathname === FN_PREFIX || pathname.startsWith(FN_PREFIX + "/")) {
      return withCookie(await handleServer(req, site, url, identity.id));
    }

    // Everything else: a static file from the site's public/ dir.
    return withCookie(await serveStatic(site, pathname));
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
