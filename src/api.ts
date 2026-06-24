import { join, resolve, sep } from "node:path";
import { readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { timingSafeEqual, createHash, randomBytes } from "node:crypto";
import { SITES_DIR, BASE_DOMAIN, PORT, json } from "./config.ts";
import { notifyReloadForPath } from "./events.ts";
import { ensureDb, metaGet, metaSet } from "./kv.ts";
import { invalidate } from "./sandbox.ts";
import { rescheduleSite } from "./cron.ts";

/**
 * Keep the running server in sync with an uploaded/deleted source file: drop any
 * cached server/cron module so the next run recompiles it, and reschedule cron
 * when the config itself changes.
 */
function onSourceChange(site: string, relpath: string): void {
  const rel = relpath.replace(/^\/+/, "");
  if (rel === "singlepage.json") rescheduleSite(site);
  else if (rel.startsWith("server/") || rel.startsWith("cron/")) invalidate(site, rel);
}

// Admin token: a single shared secret that authorizes site creation and deploy-
// key rotation (but NOT file writes — those require the per-site deploy key).
// Sent as `Authorization: Bearer <token>`. The server refuses to start without it.
const ADMIN_TOKEN: string = process.env.SINGLEPAGE_TOKEN ?? "";
if (!ADMIN_TOKEN) {
  console.error("SINGLEPAGE_TOKEN is required. Set it to a shared secret and restart.");
  process.exit(1);
}

const DEPLOY_KEY_META = "deploy_key_hash"; // meta-table key for a site's deploy-key hash

/** Extract the bearer token from the Authorization header ("" if absent). */
function bearer(req: Request): string {
  const header = req.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

/** Constant-time compare of two secrets (false on length mismatch). */
function secretEquals(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** True if the request carries the admin token (site creation + key rotation). */
function authorized(req: Request): boolean {
  return secretEquals(bearer(req), ADMIN_TOKEN);
}

const KEY_PREFIX = "sp_";

/** Generate a fresh, random deploy key (the only time the raw value exists). */
function generateDeployKey(): string {
  return KEY_PREFIX + randomBytes(32).toString("base64url");
}

/** SHA-256 hash (hex) of a raw key — what we store, never the key itself. */
function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Generate a deploy key for `site`, store only its hash, return the raw key. */
function setSiteDeployKey(site: string): string {
  const raw = generateDeployKey();
  metaSet(site, DEPLOY_KEY_META, hashKey(raw));
  return raw;
}

/**
 * True if the request carries `site`'s deploy key. A site with no key stored
 * (e.g. created before deploy keys existed) cannot be written to until an admin
 * rotates one in.
 */
function verifyDeployKey(site: string, req: Request): boolean {
  const stored = metaGet(site, DEPLOY_KEY_META);
  if (!stored) return false;
  return secretEquals(hashKey(bearer(req)), stored);
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

/**
 * Management API (host-agnostic; mounted under /api/).
 *
 * Auth model: site creation and deploy-key rotation require the admin token
 * (SINGLEPAGE_TOKEN); file writes require the target site's own deploy key. The
 * admin token cannot deploy files — keys are strictly scoped to their site.
 */
export async function handleApi(req: Request, url: URL): Promise<Response> {
  // Create a site (admin only) -> returns a fresh deploy key (shown once).
  if (req.method === "POST" && url.pathname === "/api/sites") {
    if (!authorized(req)) return json({ error: "unauthorized" }, 401);

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
    const deployKey = setSiteDeployKey(name);

    return json(
      { name, url: `http://${name}.${BASE_DOMAIN}:${PORT}/`, deployKey },
      201,
    );
  }

  // Rotate a site's deploy key (admin only) -> returns the new key (shown once).
  // Also how a key is first issued for a site created before deploy keys existed.
  const keyMatch = url.pathname.match(/^\/api\/sites\/([^/]+)\/deploy-key$/);
  if (keyMatch && req.method === "POST") {
    if (!authorized(req)) return json({ error: "unauthorized" }, 401);
    const name = decodeURIComponent(keyMatch[1]!);
    if (!existsSync(join(SITES_DIR, name))) return json({ error: "unknown site" }, 404);
    const deployKey = setSiteDeployKey(name);
    return json({ name, deployKey });
  }

  // File transfer: PUT/DELETE /api/sites/<name>/files?path=<relpath>
  // Gated by the target site's deploy key (not the admin token).
  const fileMatch = url.pathname.match(/^\/api\/sites\/([^/]+)\/files$/);
  if (fileMatch && (req.method === "PUT" || req.method === "DELETE")) {
    const name = decodeURIComponent(fileMatch[1]!);
    if (!verifyDeployKey(name, req)) return json({ error: "unauthorized" }, 401);

    const relpath = url.searchParams.get("path") ?? "";
    if (!relpath) return json({ error: "'path' query param is required" }, 400);

    const abs = resolveSiteFile(name, relpath);
    if (!abs) return json({ error: "path not allowed" }, 400);

    if (req.method === "PUT") {
      await Bun.write(abs, await req.arrayBuffer()); // creates parent dirs
      notifyReloadForPath(name, relpath);
      onSourceChange(name, relpath);
      return json({ ok: true, path: relpath });
    }
    await rm(abs, { force: true });
    notifyReloadForPath(name, relpath);
    onSourceChange(name, relpath);
    return json({ ok: true, path: relpath, deleted: true });
  }

  return json({ error: "not found" }, 404);
}
