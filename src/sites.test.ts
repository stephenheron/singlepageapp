import { test, expect, afterAll } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SITES_DIR } from "./config.ts";
import { isKnownHost, siteExists } from "./sites.ts";

// BASE_DOMAIN defaults to "localhost" (no env set), so sites are "<name>.localhost".
const SITE = "known-host-test";
mkdirSync(join(SITES_DIR, SITE), { recursive: true });
afterAll(() => rmSync(join(SITES_DIR, SITE), { recursive: true, force: true }));

test("isKnownHost accepts the apex domain", () => {
  expect(isKnownHost("localhost")).toBe(true);
  expect(isKnownHost("localhost:3000")).toBe(true); // port is ignored
});

test("isKnownHost accepts an existing site's subdomain", () => {
  expect(siteExists(SITE)).toBe(true);
  expect(isKnownHost(`${SITE}.localhost`)).toBe(true);
});

test("isKnownHost rejects unknown, bogus, or missing hosts", () => {
  expect(isKnownHost(`no-such-site.localhost`)).toBe(false);
  expect(isKnownHost("evil.attacker.com")).toBe(false); // wrong base domain
  expect(isKnownHost(`${SITE}.sub.localhost`)).toBe(false); // multi-label, not a site
  expect(isKnownHost(null)).toBe(false);
  expect(isKnownHost("")).toBe(false);
});
