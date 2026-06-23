import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { SITES_DIR, json } from "./config.ts";
import { broadcast } from "./events.ts";

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
    "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, source TEXT NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL);",
  );
  dbCache.set(site, db);
  return db;
}

// --- KV helpers --------------------------------------------------------------
// Synchronous primitives shared by the HTTP handler (handleKv) and the server
// /cron sandbox. Values are opaque text — callers store JSON. kvSet broadcasts a
// "kv" SSE event so every open page (and any sandbox writer) stays live.

/** Stored value for a key, or null if absent. */
export function kvGet(site: string, key: string): string | null {
  const row = ensureDb(site).query("SELECT value FROM kv WHERE key = ?").get(key) as
    | { value: string }
    | null;
  return row ? row.value : null;
}

/** Store `value` (opaque text) under `key` and notify open pages. */
export function kvSet(site: string, key: string, value: string): void {
  ensureDb(site)
    .query(
      "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .run(key, value, Date.now());
  // Values are JSON from the writer; fall back to the raw text if it isn't valid.
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = value;
  }
  broadcast(site, "kv", JSON.stringify({ key, action: "set", value: parsed }));
}

/** Remove `key` and notify open pages. */
export function kvRemove(site: string, key: string): void {
  ensureDb(site).query("DELETE FROM kv WHERE key = ?").run(key);
  broadcast(site, "kv", JSON.stringify({ key, action: "delete" }));
}

/** All keys, sorted. */
export function kvKeys(site: string): string[] {
  const rows = ensureDb(site).query("SELECT key FROM kv ORDER BY key").all() as {
    key: string;
  }[];
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
  broadcast(site, "log", JSON.stringify({ ts, source, level, message }));
}

/**
 * Per-site key/value store, reachable from the browser at /__kv (host-scoped,
 * no admin token). Values are opaque text — the client stores JSON.
 *   GET    /__kv          -> ["key", ...]
 *   GET    /__kv/<key>    -> stored value (404 if absent)
 *   PUT    /__kv/<key>    -> store request body as the value
 *   DELETE /__kv/<key>    -> remove the key
 */
export async function handleKv(req: Request, site: string, key: string | null): Promise<Response> {
  if (!existsSync(join(SITES_DIR, site))) {
    return new Response("Unknown site", { status: 404 });
  }

  if (key === null) {
    if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
    return json(kvKeys(site));
  }

  if (req.method === "GET") {
    const value = kvGet(site, key);
    if (value === null) {
      return new Response("null", { status: 404, headers: { "content-type": "application/json" } });
    }
    return new Response(value, { headers: { "content-type": "application/json" } });
  }
  if (req.method === "PUT") {
    kvSet(site, key, await req.text());
    return json({ ok: true });
  }
  if (req.method === "DELETE") {
    kvRemove(site, key);
    return json({ ok: true });
  }
  return json({ error: "method not allowed" }, 405);
}
