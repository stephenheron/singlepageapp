import { join, resolve, sep } from "node:path";
import { readdir, rm } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { SITES_DIR, BASE_DOMAIN, PORT, json } from "./config.ts";
import { notifyReloadForPath } from "./events.ts";
import { ensureDb } from "./kv.ts";

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

/** Management API (host-agnostic; mounted under /api/). */
export async function handleApi(req: Request, url: URL): Promise<Response> {
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
