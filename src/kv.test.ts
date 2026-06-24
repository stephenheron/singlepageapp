import { test, expect, afterAll } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { SITES_DIR } from "./config.ts";
import {
  ensureDb,
  kvGet,
  kvSet,
  kvSetClass,
  kvClass,
  kvKeys,
  kvVisibleKeys,
  handleKv,
} from "./kv.ts";
import { addClient, removeClient, type WsData } from "./events.ts";

const SITE = "_kv_test_site";
afterAll(() => rmSync(join(SITES_DIR, SITE), { recursive: true, force: true }));

// A minimal stand-in for a browser socket: captures every frame the bus sends it
// so we can assert which kv changes are (and aren't) broadcast.
function fakeSocket(site: string, ...patterns: string[]) {
  const frames: any[] = [];
  const ws = {
    data: { site, patterns: new Set(patterns) } as WsData,
    send: (frame: string) => frames.push(JSON.parse(frame)),
  };
  addClient(ws as any);
  return { ws, frames, close: () => removeClient(ws as any) };
}

test("migration adds the class column to a pre-existing kv table", () => {
  const site = "_kv_migration_test_site";
  const dir = join(SITES_DIR, site, "data");
  mkdirSync(dir, { recursive: true });
  // Create an old-schema kv table (no class column), as shipped before classes.
  const old = new Database(join(dir, "db.sqlite"), { create: true });
  old.exec(
    "CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);",
  );
  old.query("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)").run("old", '"v"', 1);
  old.close();

  try {
    // ensureDb opens a fresh (uncached) handle and migrates the table in place.
    ensureDb(site);
    const cols = (ensureDb(site).query("PRAGMA table_info(kv)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toContain("class");
    // The pre-existing row backfills to the default class.
    expect(kvClass(site, "old")).toBe("readwrite");
  } finally {
    rmSync(join(SITES_DIR, site), { recursive: true, force: true });
  }
});

test("new keys default to readwrite", () => {
  kvSet(SITE, "plain", '"hello"');
  expect(kvClass(SITE, "plain")).toBe("readwrite");
});

test("private keys are invisible to clients but readable by the backend", async () => {
  kvSet(SITE, "secret", '"shh"', "private");

  // Backend keeps full access.
  expect(kvGet(SITE, "secret")).toBe('"shh"');
  expect(kvKeys(SITE)).toContain("secret");

  // Client GET on a private key is indistinguishable from an absent key.
  const get = await handleKv(new Request("http://x/__kv/secret"), SITE, "secret");
  expect(get.status).toBe(404);
  expect(await get.text()).toBe("null");

  // Client writes/deletes also look absent — leaking nothing about existence.
  const put = await handleKv(
    new Request("http://x/__kv/secret", { method: "PUT", body: '"x"' }),
    SITE,
    "secret",
  );
  expect(put.status).toBe(404);
  expect(kvGet(SITE, "secret")).toBe('"shh"'); // not overwritten

  const del = await handleKv(
    new Request("http://x/__kv/secret", { method: "DELETE" }),
    SITE,
    "secret",
  );
  expect(del.status).toBe(404);
  expect(kvGet(SITE, "secret")).toBe('"shh"'); // not deleted

  // Excluded from the client keys listing.
  expect(kvVisibleKeys(SITE)).not.toContain("secret");
  const list = await handleKv(new Request("http://x/__kv"), SITE, null);
  expect(await list.json()).not.toContain("secret");
});

test("private key changes are never broadcast", () => {
  const sock = fakeSocket(SITE, "*");
  try {
    kvSet(SITE, "secret2", '"a"', "private");
    kvSet(SITE, "secret2", '"b"'); // plain update preserves the private class
    expect(sock.frames).toHaveLength(0);
  } finally {
    sock.close();
  }
});

test("read-only keys are client-readable but reject client writes", async () => {
  kvSet(SITE, "config", '{"theme":"dark"}', "readonly");

  const get = await handleKv(new Request("http://x/__kv/config"), SITE, "config");
  expect(get.status).toBe(200);
  expect(await get.text()).toBe('{"theme":"dark"}');

  const put = await handleKv(
    new Request("http://x/__kv/config", { method: "PUT", body: '"hacked"' }),
    SITE,
    "config",
  );
  expect(put.status).toBe(403);

  const del = await handleKv(
    new Request("http://x/__kv/config", { method: "DELETE" }),
    SITE,
    "config",
  );
  expect(del.status).toBe(403);

  expect(kvVisibleKeys(SITE)).toContain("config");
});

test("read-only key changes are broadcast (clients may read)", () => {
  const sock = fakeSocket(SITE, "*");
  try {
    kvSet(SITE, "ro:broadcast", '"v"', "readonly");
    expect(sock.frames).toHaveLength(1);
    expect(sock.frames[0]).toEqual({ type: "kv", data: { key: "ro:broadcast", action: "set", value: "v" } });
  } finally {
    sock.close();
  }
});

test("read-write keys behave as before over the client boundary", async () => {
  const sock = fakeSocket(SITE, "*");
  try {
    const put = await handleKv(
      new Request("http://x/__kv/rw", { method: "PUT", body: '"v"' }),
      SITE,
      "rw",
    );
    expect(put.status).toBe(200);
    expect(kvClass(SITE, "rw")).toBe("readwrite");
    expect(sock.frames).toHaveLength(1);

    const del = await handleKv(new Request("http://x/__kv/rw", { method: "DELETE" }), SITE, "rw");
    expect(del.status).toBe(200);
  } finally {
    sock.close();
  }
});

test("kvSetClass reclassifies an existing key", async () => {
  kvSet(SITE, "promote", '"v"'); // starts readwrite
  kvSetClass(SITE, "promote", "private");
  const get = await handleKv(new Request("http://x/__kv/promote"), SITE, "promote");
  expect(get.status).toBe(404); // now invisible
});

test("kvSet rejects an invalid class", () => {
  expect(() => kvSet(SITE, "bad", '"v"', "nope" as any)).toThrow();
});
