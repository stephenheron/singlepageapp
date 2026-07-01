import { test, expect, beforeAll, afterAll } from "bun:test";
import { rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { SITES_DIR } from "./config.ts";
import { ensureDb, kvSet, kvGet, kvRemove, KvQuotaError, handleKv } from "./kv.ts";

// Tight caps make the limits cheap to hit. kvQuota() reads these at write time,
// so setting them in beforeAll (and restoring in afterAll) scopes them to this
// file and keeps the real defaults for every other test file.
const CAPS: Record<string, string> = {
  SINGLEPAGE_MAX_SITE_KV_BYTES: "600",
  SINGLEPAGE_MAX_SITE_KV_ROWS: "3",
  SINGLEPAGE_MAX_USER_KV_KEYS: "2",
};
const saved: Record<string, string | undefined> = {};
const SITES: string[] = [];

// Distinct site per test so their counters don't interfere.
function site(name: string): string {
  const s = `_quota_${name}`;
  SITES.push(s);
  return s;
}

beforeAll(() => {
  for (const k of Object.keys(CAPS)) {
    saved[k] = process.env[k];
    process.env[k] = CAPS[k];
  }
});

afterAll(() => {
  for (const k of Object.keys(CAPS)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const s of SITES) rmSync(join(SITES_DIR, s), { recursive: true, force: true });
});

test("site byte cap rejects the overflowing write and stores nothing", () => {
  const s = site("bytes");
  kvSet(s, "a", "x".repeat(500)); // 1 + 500 = 501 bytes, under 600
  expect(kvGet(s, "a")).toBe("x".repeat(500));

  expect(() => kvSet(s, "b", "x".repeat(500))).toThrow(KvQuotaError); // 501 + 501 > 600
  expect(kvGet(s, "b")).toBeNull();

  // Shrinking an existing key is always allowed (projected total drops).
  kvSet(s, "a", "x".repeat(10));
  expect(kvGet(s, "a")).toBe("x".repeat(10));
});

test("removing a key frees quota for a later write", () => {
  const s = site("free");
  kvSet(s, "a", "x".repeat(500));
  expect(() => kvSet(s, "b", "x".repeat(500))).toThrow(KvQuotaError);

  kvRemove(s, "a");
  kvSet(s, "b", "x".repeat(500)); // space reclaimed
  expect(kvGet(s, "b")).toBe("x".repeat(500));
});

test("site key cap rejects new keys but still allows updates", () => {
  const s = site("rows");
  kvSet(s, "k1", "1");
  kvSet(s, "k2", "2");
  kvSet(s, "k3", "3"); // at the 3-key cap

  expect(() => kvSet(s, "k4", "4")).toThrow(KvQuotaError);
  expect(kvGet(s, "k4")).toBeNull();

  kvSet(s, "k1", "updated"); // not a new row
  expect(kvGet(s, "k1")).toBe("updated");
});

test("per-user key cap is scoped to one user:<id>:* namespace", () => {
  const s = site("user");
  kvSet(s, "user:U:a", "1", "private");
  kvSet(s, "user:U:b", "2", "private"); // at the 2-key user cap

  expect(() => kvSet(s, "user:U:c", "3", "private")).toThrow(KvQuotaError);
  expect(kvGet(s, "user:U:c")).toBeNull();

  // A different user is unaffected (and still within the site key cap).
  kvSet(s, "user:V:a", "1", "private");
  expect(kvGet(s, "user:V:a")).toBe("1");
});

test("handleKv PUT over quota returns 507 and stores nothing", async () => {
  const s = site("http");
  ensureDb(s); // create the site dir so handleKv sees a known site
  kvSet(s, "a", "x".repeat(500));

  const res = await handleKv(
    new Request("http://x/__kv/b", { method: "PUT", body: "x".repeat(500) }),
    s,
    "b",
  );
  expect(res.status).toBe(507);
  expect(kvGet(s, "b")).toBeNull();
});

test("counters seed from pre-existing rows on first open", () => {
  const s = site("seed");
  // Pre-create a db with a row, bypassing the counters entirely.
  mkdirSync(join(SITES_DIR, s, "data"), { recursive: true });
  const raw = new Database(join(SITES_DIR, s, "data", "db.sqlite"), { create: true });
  raw.exec(
    "CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL, class TEXT NOT NULL DEFAULT 'readwrite');",
  );
  raw.query("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)").run("a", "x".repeat(500), 1);
  raw.close();

  // First open seeds the counters (501 bytes) from that row; a 201-byte write
  // that would otherwise fit now pushes the total over 600.
  expect(() => kvSet(s, "b", "x".repeat(200))).toThrow(KvQuotaError);
});
