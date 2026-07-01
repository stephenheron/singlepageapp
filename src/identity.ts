import { existsSync } from "node:fs";
import { join } from "node:path";
import { createHmac, createHash, timingSafeEqual, randomUUID } from "node:crypto";
import { SITES_DIR, json, MAX_KV_VALUE_BYTES } from "./config.ts";
import { kvGet, kvSet, kvRemove, kvKeys, readLimitedBody, KvQuotaError } from "./kv.ts";

/**
 * Anonymous end-user identity. Every visitor gets a stable, *unforgeable* id with
 * zero interaction (no login, no UI): the server mints a UUID, signs it
 * HMAC(secret, site + ":" + uuid), and sets it as the HttpOnly `sp_uid` cookie.
 * Because the server signs it, the id can be *trusted* to scope private per-user
 * data — unlike a client-generated UUID, which is trivially spoofable.
 *
 * Binding the signature to `site` stops an id minted on one subdomain from being
 * replayed on another. `HttpOnly` means page JS can neither read nor forge it; a
 * page learns its own id from GET /__me (see handleMe).
 *
 * Per-user data lives in the existing kv store under the reserved `user:<id>:*`
 * namespace, stored "private" so it never broadcasts or leaks over /__kv. The
 * /__me/kv boundary scopes every access to the caller's *own* namespace, derived
 * from the verified cookie — the visitor never names another user's id, so
 * isolation is server-enforced.
 */

const COOKIE_NAME = "sp_uid";
// Browsers clamp cookie lifetime to 400 days (RFC 6265bis, enforced by Chrome
// 104+, Firefox, Safari), so this is the practical maximum — a larger value, or
// an "expires never", is silently capped to this anyway. The cookie is HttpOnly
// and server-set, so it's exempt from WebKit's separate 7-day script-cookie cap.
const COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

/** Reserved kv namespace for per-user data; see the prefix guard in kv.ts. */
export const USER_KEY_PREFIX = "user:";

/** Per-user key for a given verified id, e.g. user:<id>:cart. */
function userKey(id: string, key: string): string {
  return `${USER_KEY_PREFIX}${id}:${key}`;
}

/**
 * The HMAC key for signing ids. Prefer SINGLEPAGE_AUTH_SECRET so it can rotate
 * independently of the admin token; otherwise derive one from SINGLEPAGE_APP_TOKEN
 * (hashed, so the raw admin token is never used directly as the signing key) so
 * identity works out of the box. Read lazily so importing this module never
 * depends on env-load ordering (mirrors how tests set the token before use).
 */
function authSecret(): string {
  const explicit = process.env.SINGLEPAGE_AUTH_SECRET;
  if (explicit) return explicit;
  const token = process.env.SINGLEPAGE_APP_TOKEN ?? "";
  return createHash("sha256").update(`sp-identity:${token}`).digest("hex");
}

/** Signature for an id bound to its site (base64url, no dots — see verify). */
function signature(site: string, uuid: string): string {
  return createHmac("sha256", authSecret()).update(`${site}:${uuid}`).digest("base64url");
}

/** Build a signed cookie value `<uuid>.<sig>`. */
function sign(site: string, uuid: string): string {
  return `${uuid}.${signature(site, uuid)}`;
}

/**
 * Recover the verified id from a cookie value, or null if it is malformed,
 * tampered, or signed for another site. A UUID has no dots and the signature is
 * base64url, so the last dot cleanly separates them.
 */
export function verify(site: string, cookieValue: string): string | null {
  const dot = cookieValue.lastIndexOf(".");
  if (dot <= 0) return null;
  const uuid = cookieValue.slice(0, dot);
  const sig = cookieValue.slice(dot + 1);
  const expected = signature(site, uuid);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return uuid;
}

/** Read a named cookie from a Cookie header ("" -> null). */
function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** Whether the request reached us over HTTPS (direct or via a TLS-terminating proxy). */
function isHttps(req: Request): boolean {
  const xfp = req.headers.get("x-forwarded-proto");
  if (xfp) return xfp.split(",")[0]!.trim() === "https";
  try {
    return new URL(req.url).protocol === "https:";
  } catch {
    return false;
  }
}

/** Set-Cookie header value for a freshly minted id. */
function buildSetCookie(req: Request, value: string): string {
  const secure = isHttps(req) ? "; Secure" : "";
  return `${COOKIE_NAME}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}${secure}`;
}

export type Identity = {
  /** The verified (or freshly minted) user id. */
  id: string;
  /** A Set-Cookie header value when a new id was minted; null when the request's cookie was already valid. */
  setCookie: string | null;
};

/**
 * Resolve the caller's identity for `site`. Verifies an existing `sp_uid` cookie;
 * if it's missing, tampered, or foreign-site, mints a fresh signed id and returns
 * a Set-Cookie to persist it. Callers attach `setCookie` (when present) to the
 * response. Concurrent first-load requests may each mint an id, but the browser
 * keeps one and every later request carries it — the id is stable thereafter.
 */
export function resolveIdentity(req: Request, site: string): Identity {
  const raw = readCookie(req.headers.get("cookie"), COOKIE_NAME);
  if (raw) {
    const id = verify(site, raw);
    if (id) return { id, setCookie: null };
  }
  const id = randomUUID();
  return { id, setCookie: buildSetCookie(req, sign(site, id)) };
}

const ME_PREFIX = "/__me";
const ME_KV_PREFIX = "/__me/kv";

/** JSON 404 that mirrors handleKv's "absent" shape (body "null"). */
function absent(): Response {
  return new Response("null", { status: 404, headers: { "content-type": "application/json" } });
}

/**
 * Per-user identity endpoint (host-scoped, cookie-authenticated). `id` is the
 * verified caller resolved upstream in index.ts.
 *   GET    /__me            -> { id }   (page learns its own id; cookie is HttpOnly)
 *   GET    /__me/kv         -> ["key", ...]   (the caller's own keys, namespace stripped)
 *   GET    /__me/kv/<key>   -> stored value (404 if absent)
 *   PUT    /__me/kv/<key>   -> store request body (always "private")
 *   DELETE /__me/kv/<key>   -> remove the key
 * Every key is scoped to user:<id>:* derived from the cookie, so a caller can only
 * ever touch its own data.
 */
export async function handleMe(
  req: Request,
  site: string,
  id: string,
  pathname: string,
): Promise<Response> {
  if (!existsSync(join(SITES_DIR, site))) {
    return new Response("Unknown site", { status: 404 });
  }

  if (pathname === ME_PREFIX || pathname === ME_PREFIX + "/") {
    if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
    return json({ id });
  }

  if (pathname === ME_KV_PREFIX || pathname.startsWith(ME_KV_PREFIX + "/")) {
    const ns = userKey(id, "");
    const rawKey = pathname === ME_KV_PREFIX ? "" : pathname.slice(ME_KV_PREFIX.length + 1);
    const key = rawKey ? decodeURIComponent(rawKey) : null;

    if (key === null) {
      if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
      const keys = kvKeys(site)
        .filter((k) => k.startsWith(ns))
        .map((k) => k.slice(ns.length));
      return json(keys);
    }

    const fullKey = ns + key;
    if (req.method === "GET") {
      const value = kvGet(site, fullKey);
      if (value === null) return absent();
      return new Response(value, { headers: { "content-type": "application/json" } });
    }
    if (req.method === "PUT") {
      const body = await readLimitedBody(req, MAX_KV_VALUE_BYTES);
      if (body instanceof Response) return body;
      // Stored "private": per-user values never broadcast and never leak over /__kv.
      try {
        kvSet(site, fullKey, body, "private");
      } catch (e) {
        if (e instanceof KvQuotaError) return json({ error: "storage quota exceeded" }, 507);
        throw e;
      }
      return json({ ok: true });
    }
    if (req.method === "DELETE") {
      kvRemove(site, fullKey);
      return json({ ok: true });
    }
    return json({ error: "method not allowed" }, 405);
  }

  return new Response("Not found", { status: 404 });
}
