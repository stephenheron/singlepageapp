import { test, expect, afterAll } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { readSiteEnv } from "./env.ts";
import { SITES_DIR } from "./config.ts";

const TEST_SITE = "_env_test_site";
const envPath = join(SITES_DIR, TEST_SITE, ".env");
afterAll(() => rmSync(join(SITES_DIR, TEST_SITE), { recursive: true, force: true }));

test("readSiteEnv reads the site .env, returns {} when absent, and refreshes on change", async () => {
  // Absent file -> empty object.
  expect(readSiteEnv(TEST_SITE)).toEqual({});

  await Bun.write(envPath, "API_KEY=first\n");
  expect(readSiteEnv(TEST_SITE)).toEqual({ API_KEY: "first" });

  // Rewrite with new content — the mtime/size signature changes, so the cache
  // must not serve the stale value.
  await Bun.write(envPath, "API_KEY=second\nEXTRA=x\n");
  expect(readSiteEnv(TEST_SITE)).toEqual({ API_KEY: "second", EXTRA: "x" });

  // Removing the file drops back to empty.
  rmSync(envPath);
  expect(readSiteEnv(TEST_SITE)).toEqual({});
});
