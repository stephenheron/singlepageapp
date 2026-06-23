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
export async function handleKv(req: Request, site: string, key: string | null): Promise<Response> {
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
    // Push to every open page of this site (incl. the writer). Values are JSON
    // from the client; fall back to the raw text if it isn't valid JSON.
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = value;
    }
    broadcast(site, "kv", JSON.stringify({ key, action: "set", value: parsed }));
    return json({ ok: true });
  }
  if (req.method === "DELETE") {
    db.query("DELETE FROM kv WHERE key = ?").run(key);
    broadcast(site, "kv", JSON.stringify({ key, action: "delete" }));
    return json({ ok: true });
  }
  return json({ error: "method not allowed" }, 405);
}
