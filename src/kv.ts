import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { SITES_DIR, json } from "./config.ts";
import { broadcast, broadcastKv } from "./events.ts";

// Open SQLite connections, one cached per site. The database lives at
// sites/<name>/data/db.sqlite — outside public/server/cron, so it is never
// served, synced, or overwritable through the upload API.
const dbCache = new Map<string, Database>();

export function ensureDb(site: string): Database {
  let db = dbCache.get(site);
  if (db) return db;
  const dataDir = join(SITES_DIR, site, "data");
  mkdirSync(dataDir, { recursive: true });
  db = new Database(join(dataDir, "db.sqlite"), { create: true });
  db.exec("PRAGMA journal_mode = WAL;"); // concurrent reads; flushes file to disk
  db.exec(
    "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL, class TEXT NOT NULL DEFAULT 'readwrite');",
  );
  // Migrate kv tables created before visibility classes existed: add the column
  // with a default so every existing row becomes read-write (prior behavior).
  const hasClass = (db.query("PRAGMA table_info(kv)").all() as { name: string }[]).some(
    (c) => c.name === "class",
  );
  if (!hasClass) {
    db.exec("ALTER TABLE kv ADD COLUMN class TEXT NOT NULL DEFAULT 'readwrite';");
  }
  db.exec(
    "CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, source TEXT NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL);",
  );
  // Backend-only key/value store: secrets and server state that must never be
  // exposed over /__kv or broadcast to clients (e.g. the deploy-key hash).
  db.exec(
    "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
  );
  dbCache.set(site, db);
  return db;
}

// --- Meta (backend-only) -----------------------------------------------------
// Unlike kv, the meta table is never reachable from the browser and never
// broadcast. Use it for server-side secrets and state (see api.ts deploy keys).

/** Backend-only stored value for `key`, or null if absent. */
export function metaGet(site: string, key: string): string | null {
  const row = ensureDb(site).query("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | null;
  return row ? row.value : null;
}

/** Store a backend-only `value` under `key` (no broadcast). */
export function metaSet(site: string, key: string, value: string): void {
  ensureDb(site)
    .query(
      "INSERT INTO meta (key, value) VALUES (?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(key, value);
}

// --- KV helpers --------------------------------------------------------------
// Synchronous primitives shared by the HTTP handler (handleKv) and the server
// /cron sandbox. Values are opaque text — callers store JSON. kvSet broadcasts a
// "kv" change so subscribed pages (and any sandbox writer) stay live; delivery
// is filtered per-socket by each page's subscription (see broadcastKv).
//
// Every key carries a visibility class controlling client access at the /__kv
// boundary (enforced in handleKv) and the event fan-out. The backend (sandbox
// ctx.kv) ignores the class and sees everything.
//   - "private"   backend only; never returned over /__kv, never broadcast.
//   - "readonly"  clients may read + subscribe, only the backend may write.
//   - "readwrite" clients may read + write (the default).

export type KvClass = "private" | "readonly" | "readwrite";

const KV_CLASSES: readonly KvClass[] = ["private", "readonly", "readwrite"];

/** Visibility class of `key`; "readwrite" if the key doesn't exist. */
export function kvClass(site: string, key: string): KvClass {
  const row = ensureDb(site).query("SELECT class FROM kv WHERE key = ?").get(key) as
    | { class: string }
    | null;
  return (row?.class as KvClass) ?? "readwrite";
}

/** Stored value for a key, or null if absent. */
export function kvGet(site: string, key: string): string | null {
  const row = ensureDb(site).query("SELECT value FROM kv WHERE key = ?").get(key) as
    | { value: string }
    | null;
  return row ? row.value : null;
}

/**
 * Store `value` (opaque text) under `key` and notify open pages. Pass `cls` to
 * (re)classify the key; omit it to write the value while preserving an existing
 * key's class (new keys default to "readwrite"). Private keys are never
 * broadcast — their values stay on the backend.
 */
export function kvSet(site: string, key: string, value: string, cls?: KvClass): void {
  if (cls && !KV_CLASSES.includes(cls)) throw new Error(`invalid kv class: ${cls}`);
  const db = ensureDb(site);
  if (cls) {
    db.query(
      "INSERT INTO kv (key, value, updated_at, class) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, class = excluded.class",
    ).run(key, value, Date.now(), cls);
  } else {
    // No class given: a new row defaults to "readwrite"; an existing row keeps
    // its class (ON CONFLICT doesn't touch the class column).
    db.query(
      "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    ).run(key, value, Date.now());
  }
  if ((cls ?? kvClass(site, key)) === "private") return; // value never leaves the backend
  // Values are JSON from the writer; fall back to the raw text if it isn't valid.
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = value;
  }
  broadcastKv(site, key, { key, action: "set", value: parsed });
}

/** Set only the visibility class of an existing `key` (no-op if absent). */
export function kvSetClass(site: string, key: string, cls: KvClass): void {
  if (!KV_CLASSES.includes(cls)) throw new Error(`invalid kv class: ${cls}`);
  ensureDb(site).query("UPDATE kv SET class = ? WHERE key = ?").run(cls, key);
}

/** Remove `key` and notify open pages (private keys are never broadcast). */
export function kvRemove(site: string, key: string): void {
  const wasPrivate = kvClass(site, key) === "private";
  ensureDb(site).query("DELETE FROM kv WHERE key = ?").run(key);
  if (wasPrivate) return;
  broadcastKv(site, key, { key, action: "delete" });
}

/** All keys, sorted. Includes private keys — for backend use only. */
export function kvKeys(site: string): string[] {
  const rows = ensureDb(site).query("SELECT key FROM kv ORDER BY key").all() as {
    key: string;
  }[];
  return rows.map((r) => r.key);
}

/** Client-visible keys (private keys excluded), sorted. */
export function kvVisibleKeys(site: string): string[] {
  const rows = ensureDb(site)
    .query("SELECT key FROM kv WHERE class != 'private' ORDER BY key")
    .all() as { key: string }[];
  return rows.map((r) => r.key);
}

// --- Logs --------------------------------------------------------------------

const LOG_RETENTION = 1000; // keep the most recent N rows per site

/** Persist a log line from server/cron code and broadcast it for live tailing. */
export function appendLog(site: string, source: string, level: string, message: string): void {
  const db = ensureDb(site);
  const ts = Date.now();
  db.query("INSERT INTO logs (ts, source, level, message) VALUES (?, ?, ?, ?)").run(
    ts,
    source,
    level,
    message,
  );
  // Trim to the retention window so a chatty job can't grow the DB unbounded.
  db.query(
    "DELETE FROM logs WHERE id <= (SELECT MAX(id) FROM logs) - ?",
  ).run(LOG_RETENTION);
  broadcast(site, "log", { ts, source, level, message });
}

/**
 * Per-site key/value store, reachable from the browser at /__kv (host-scoped,
 * no admin token). Values are opaque text — the client stores JSON. Access is
 * gated by each key's visibility class (see kvClass): private keys appear absent
 * (404) for every method, read-only keys reject client writes (403).
 *   GET    /__kv          -> ["key", ...]   (private keys excluded)
 *   GET    /__kv/<key>    -> stored value (404 if absent or private)
 *   PUT    /__kv/<key>    -> store request body as the value (403 if read-only)
 *   DELETE /__kv/<key>    -> remove the key (403 if read-only)
 */
export async function handleKv(req: Request, site: string, key: string | null): Promise<Response> {
  if (!existsSync(join(SITES_DIR, site))) {
    return new Response("Unknown site", { status: 404 });
  }

  if (key === null) {
    if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
    return json(kvVisibleKeys(site)); // private keys are not enumerable by clients
  }

  // Private keys are invisible to clients: respond exactly as if the key is
  // absent (404 + "null") for every method, leaking nothing about its existence.
  const cls = kvClass(site, key);
  if (cls === "private") {
    return new Response("null", { status: 404, headers: { "content-type": "application/json" } });
  }

  if (req.method === "GET") {
    const value = kvGet(site, key);
    if (value === null) {
      return new Response("null", { status: 404, headers: { "content-type": "application/json" } });
    }
    return new Response(value, { headers: { "content-type": "application/json" } });
  }
  if (req.method === "PUT") {
    if (cls === "readonly") return json({ error: "read-only key" }, 403);
    kvSet(site, key, await req.text());
    return json({ ok: true });
  }
  if (req.method === "DELETE") {
    if (cls === "readonly") return json({ error: "read-only key" }, 403);
    kvRemove(site, key);
    return json({ ok: true });
  }
  return json({ error: "method not allowed" }, 405);
}
