import { join, resolve, sep } from "node:path";
import { readdir, rm } from "node:fs/promises";
import { mkdirSync, existsSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { Database } from "bun:sqlite";

/**
 * Subdomain-routed static file server.
 *
 *   <site>.<BASE_DOMAIN>  ->  sites/<site>/public/
 *
 * Locally, browsers resolve *.localhost to 127.0.0.1 automatically (RFC 6761),
 * so `http://test-site.localhost:3000` works with zero DNS config.
 * In production, set BASE_DOMAIN to your real domain (e.g. example.com).
 *
 * Files are resolved from disk on every request, so newly deployed sites and
 * index.html files are served immediately without restarting the server.
 */

const PORT = Number(process.env.PORT ?? 3000);
const BASE_DOMAIN = process.env.BASE_DOMAIN ?? "localhost";
const SITES_DIR = resolve(import.meta.dir, "sites");

// Required shared secret guarding the write API (/api/*). Requests must send
// `Authorization: Bearer <token>`. The server refuses to start without it.
const API_TOKEN: string = process.env.SINGLEPAGE_TOKEN ?? "";
if (!API_TOKEN) {
  console.error("SINGLEPAGE_TOKEN is required. Set it to a shared secret and restart.");
  process.exit(1);
}

/** Constant-time bearer-token check for the management API. */
function authorized(req: Request): boolean {
  const header = req.headers.get("authorization") ?? "";
  const got = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(got);
  const b = Buffer.from(API_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Shared client script injected into every served HTML page.
const INJECT_PATH = "/__inject.js"; // reserved URL, served on every subdomain
const INJECT_FILE = resolve(import.meta.dir, "client", "inject.js");
const INJECT_TAG = `<script type="module" src="${INJECT_PATH}"></script>`;

// Live reload: browsers subscribe to an SSE stream per site; the file-upload
// API broadcasts a "change" event so open pages refresh on deploy.
const RELOAD_PATH = "/__reload";
const reloadClients = new Map<string, Set<ReadableStreamDefaultController>>();
const sseEncoder = new TextEncoder();

/** Broadcast a changed browser-path to every open page of a site. */
function notifyReload(site: string, browserPath: string): void {
  const set = reloadClients.get(site);
  if (!set) return;
  const msg = sseEncoder.encode(`event: change\ndata: ${browserPath}\n\n`);
  for (const ctrl of set) {
    try {
      ctrl.enqueue(msg);
    } catch {
      set.delete(ctrl); // stream already closed
    }
  }
}

/** Map an uploaded relpath to a browser path and notify, if it's a public file. */
function notifyReloadForPath(site: string, relpath: string): void {
  const prefix = "public/";
  if (!relpath.startsWith(prefix)) return; // server/cron/config don't affect the page
  notifyReload(site, "/" + relpath.slice(prefix.length));
}

/** Open SSE stream that registers this browser as a reload subscriber. */
function reloadStream(site: string): Response {
  let ctrlRef: ReadableStreamDefaultController | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream({
    start(controller) {
      ctrlRef = controller;
      let set = reloadClients.get(site);
      if (!set) reloadClients.set(site, (set = new Set()));
      set.add(controller);
      controller.enqueue(sseEncoder.encode("retry: 2000\n\n")); // reconnect hint
      // Keep intermediaries from dropping an idle connection.
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(sseEncoder.encode(": ping\n\n"));
        } catch {
          /* closed; cancel() will clean up */
        }
      }, 25000);
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
      if (ctrlRef) reloadClients.get(site)?.delete(ctrlRef);
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

/** Extract the site name from a Host header, or null for the apex domain. */
function siteFromHost(host: string | null): string | null {
  if (!host) return null;
  const hostname = host.split(":")[0]!.toLowerCase(); // strip port
  if (hostname === BASE_DOMAIN) return null; // apex, no subdomain
  const suffix = `.${BASE_DOMAIN}`;
  if (!hostname.endsWith(suffix)) return null;
  const label = hostname.slice(0, -suffix.length);
  // only support a single subdomain label, and reject anything path-ish
  if (!label || label.includes("/") || label.includes("..")) return null;
  return label;
}

/**
 * Resolve a request pathname to an absolute file path inside `root`,
 * guarding against path-traversal escapes. Returns null if it escapes.
 */
function resolveFilePath(root: string, pathname: string): string | null {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith("/")) rel += "index.html"; // directory -> index.html
  const filePath = resolve(root, "." + (rel.startsWith("/") ? rel : "/" + rel));
  // must stay within root
  if (filePath !== root && !filePath.startsWith(root + sep)) return null;
  return filePath;
}

/** Apex landing page: list the sites currently on disk (read live). */
async function apexResponse(): Promise<Response> {
  let entries: string[] = [];
  try {
    const dirents = await readdir(SITES_DIR, { withFileTypes: true });
    entries = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    // sites dir missing — fall through to empty list
  }
  const links = entries
    .map((name) => {
      const url = `http://${name}.${BASE_DOMAIN}:${PORT}/`;
      return `<li><a href="${url}">${name}</a></li>`;
    })
    .join("\n");
  const body = `<!doctype html>
<meta charset="utf-8">
<title>Sites</title>
<h1>Available sites</h1>
<ul>
${links || "<li><em>No sites found in ./sites</em></li>"}
</ul>`;
  return new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Turn an arbitrary string into a safe subdomain label. */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** First free name: `base`, else `base-1`, `base-2`, ... */
async function uniqueSiteName(base: string): Promise<string> {
  let existing = new Set<string>();
  try {
    const dirents = await readdir(SITES_DIR, { withFileTypes: true });
    existing = new Set(dirents.filter((d) => d.isDirectory()).map((d) => d.name));
  } catch {
    // sites dir missing — nothing exists yet
  }
  if (!existing.has(base)) return base;
  let n = 1;
  while (existing.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

function starterHtml(name: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${name}</title>
  </head>
  <body>
    <h1>${name}</h1>
    <p>New site created by <code>singlepage init</code>.</p>
  </body>
</html>
`;
}

// Top-level dirs (plus singlepage.json) the upload API is allowed to write.
const WRITABLE_ROOTS = ["public/", "server/", "cron/"];

/**
 * Resolve a site-relative upload path to an absolute path inside the site dir.
 * Restricted to the writable allow-list and guarded against traversal escapes.
 * Returns null if the path is disallowed or escapes the site directory.
 */
function resolveSiteFile(name: string, relpath: string): string | null {
  const rel = relpath.replace(/^\/+/, "");
  const allowed =
    rel === "singlepage.json" || WRITABLE_ROOTS.some((r) => rel.startsWith(r));
  if (!allowed) return null;

  const siteRoot = join(SITES_DIR, name);
  const abs = resolve(siteRoot, rel);
  if (abs !== siteRoot && !abs.startsWith(siteRoot + sep)) return null;
  return abs;
}

// Open SQLite connections, one cached per site. The database lives at
// sites/<name>/data/db.sqlite — outside public/server/cron, so it is never
// served, synced, or overwritable through the upload API.
const dbCache = new Map<string, Database>();

function ensureDb(site: string): Database {
  let db = dbCache.get(site);
  if (db) return db;
  const dataDir = join(SITES_DIR, site, "data");
  mkdirSync(dataDir, { recursive: true });
  db = new Database(join(dataDir, "db.sqlite"), { create: true });
  db.exec("PRAGMA journal_mode = WAL;"); // concurrent reads; flushes file to disk
  db.exec(
    "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);",
  );
  dbCache.set(site, db);
  return db;
}

/**
 * Per-site key/value store, reachable from the browser at /__kv (host-scoped,
 * no admin token). Values are opaque text — the client stores JSON.
 *   GET    /__kv          -> ["key", ...]
 *   GET    /__kv/<key>    -> stored value (404 if absent)
 *   PUT    /__kv/<key>    -> store request body as the value
 *   DELETE /__kv/<key>    -> remove the key
 */
async function handleKv(req: Request, site: string, key: string | null): Promise<Response> {
  if (!existsSync(join(SITES_DIR, site))) {
    return new Response("Unknown site", { status: 404 });
  }
  const db = ensureDb(site);

  if (key === null) {
    if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
    const rows = db.query("SELECT key FROM kv ORDER BY key").all() as { key: string }[];
    return json(rows.map((r) => r.key));
  }

  if (req.method === "GET") {
    const row = db.query("SELECT value FROM kv WHERE key = ?").get(key) as
      | { value: string }
      | null;
    if (!row) return new Response("null", { status: 404, headers: { "content-type": "application/json" } });
    return new Response(row.value, { headers: { "content-type": "application/json" } });
  }
  if (req.method === "PUT") {
    const value = await req.text();
    db.query(
      "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    ).run(key, value, Date.now());
    return json({ ok: true });
  }
  if (req.method === "DELETE") {
    db.query("DELETE FROM kv WHERE key = ?").run(key);
    return json({ ok: true });
  }
  return json({ error: "method not allowed" }, 405);
}

/** Management API (host-agnostic; mounted under /api/). */
async function handleApi(req: Request, url: URL): Promise<Response> {
  if (!authorized(req)) return json({ error: "unauthorized" }, 401);

  if (req.method === "POST" && url.pathname === "/api/sites") {
    let body: { name?: unknown };
    try {
      body = (await req.json()) as { name?: unknown };
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    const base = slugify(String(body?.name ?? ""));
    if (!base) return json({ error: "a valid 'name' is required" }, 400);

    const name = await uniqueSiteName(base);
    // Bun.write creates parent directories as needed.
    await Bun.write(join(SITES_DIR, name, "public", "index.html"), starterHtml(name));
    ensureDb(name); // provision the site's SQLite database + kv table

    return json(
      { name, url: `http://${name}.${BASE_DOMAIN}:${PORT}/` },
      201,
    );
  }

  // File transfer: PUT/DELETE /api/sites/<name>/files?path=<relpath>
  const fileMatch = url.pathname.match(/^\/api\/sites\/([^/]+)\/files$/);
  if (fileMatch && (req.method === "PUT" || req.method === "DELETE")) {
    const name = decodeURIComponent(fileMatch[1]!);
    const relpath = url.searchParams.get("path") ?? "";
    if (!relpath) return json({ error: "'path' query param is required" }, 400);

    const abs = resolveSiteFile(name, relpath);
    if (!abs) return json({ error: "path not allowed" }, 400);

    if (req.method === "PUT") {
      await Bun.write(abs, await req.arrayBuffer()); // creates parent dirs
      notifyReloadForPath(name, relpath);
      return json({ ok: true, path: relpath });
    }
    await rm(abs, { force: true });
    notifyReloadForPath(name, relpath);
    return json({ ok: true, path: relpath, deleted: true });
  }

  return json({ error: "not found" }, 404);
}

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

    // Reserved route: live-reload event stream for this site.
    if (pathname === RELOAD_PATH) return reloadStream(site);

    // Reserved route: per-site key/value store (host-scoped, browser-accessible).
    if (pathname === "/__kv" || pathname.startsWith("/__kv/")) {
      const rawKey = pathname === "/__kv" ? "" : pathname.slice("/__kv/".length);
      const key = rawKey ? decodeURIComponent(rawKey) : null;
      return handleKv(req, site, key);
    }

    // Reserved route: the shared injected client, available on every subdomain.
    if (pathname === INJECT_PATH) {
      const f = Bun.file(INJECT_FILE);
      if (await f.exists()) {
        return new Response(f, {
          headers: {
            "content-type": "text/javascript; charset=utf-8",
            "cache-control": "no-cache", // always pick up edits/deploys
          },
        });
      }
      return new Response("// inject script not found", {
        status: 404,
        headers: { "content-type": "text/javascript; charset=utf-8" },
      });
    }

    const root = join(SITES_DIR, site, "public");
    const filePath = resolveFilePath(root, pathname);

    if (!filePath) return new Response("Forbidden", { status: 403 });

    const file = Bun.file(filePath);
    if (await file.exists()) {
      // Inject the shared client into HTML; serve everything else as-is.
      if (filePath.endsWith(".html")) {
        const html = await file.text();
        const out = html.includes("</body>")
          ? html.replace("</body>", `${INJECT_TAG}\n</body>`)
          : html + INJECT_TAG;
        return new Response(out, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      return new Response(file); // Bun infers Content-Type from extension
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Serving sites from ${SITES_DIR}`);
console.log(`Listening on http://${BASE_DOMAIN}:${server.port}`);
console.log(`Try http://test-site.${BASE_DOMAIN}:${server.port}/`);
