import { join } from "node:path";
import { statSync, readFileSync } from "node:fs";
import { SITES_DIR } from "./config.ts";

/**
 * Per-site environment variables, exposed to server/cron code as `ctx.env`.
 *
 * A site's secrets live in a plain `.env` file at the site root
 * (sites/<name>/.env) — uploaded via the deploy-key API, kept OUTSIDE public/ so
 * it is never served, and never broadcast. This module parses that file and
 * hands the values to the sandbox. There is no writing from user code: the file
 * is the single source of truth, managed out-of-band by whoever holds the
 * deploy key (see the CLI's `.env` sync and api.ts's upload allow-list).
 */

// Valid variable names: shell-style, so they read naturally as ctx.env.NAME.
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Parse the text of a `.env` file into a flat string map. Supports `KEY=value`,
 * an optional `export ` prefix, `#` comments (whole-line, or trailing on
 * unquoted values), and single- or double-quoted values (double quotes honor
 * \n \r \t \\ \" escapes; single quotes are literal). Lines without a valid
 * name are skipped rather than throwing, so a malformed file degrades to the
 * entries it can parse instead of taking every handler down.
 */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (let raw of text.split("\n")) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trimStart();

    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const name = line.slice(0, eq).trim();
    if (!NAME_RE.test(name)) continue;

    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
      if (quote === '"') {
        value = value.replace(/\\([nrt"\\])/g, (_, c) =>
          c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : c,
        );
      }
    } else {
      // Unquoted: strip a trailing ` # comment` (whitespace before the hash).
      const hash = value.search(/\s#/);
      if (hash !== -1) value = value.slice(0, hash).trimEnd();
    }
    out[name] = value;
  }
  return out;
}

// Cache the parsed result per site, keyed on the file's mtime+size so an updated
// `.env` (re-uploaded through the API) is picked up on the next run without a
// server restart, while unchanged files avoid a re-read + re-parse each call.
const cache = new Map<string, { sig: string; env: Record<string, string> }>();

/** Parsed `.env` for a site (empty object if the file is absent or unreadable). */
export function readSiteEnv(site: string): Record<string, string> {
  const path = join(SITES_DIR, site, ".env");
  let sig: string;
  try {
    const s = statSync(path);
    sig = `${s.mtimeMs}:${s.size}`;
  } catch {
    cache.delete(site); // file gone -> forget any cached values
    return {};
  }
  const hit = cache.get(site);
  if (hit && hit.sig === sig) return hit.env;

  let env: Record<string, string> = {};
  try {
    env = parseEnv(readFileSync(path, "utf8"));
  } catch {
    env = {}; // unreadable between stat and read -> treat as empty
  }
  cache.set(site, { sig, env });
  return env;
}
