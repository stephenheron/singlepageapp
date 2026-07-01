import { join, resolve, sep } from "node:path";
import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { SITES_DIR, BASE_DOMAIN, PORT } from "./config.ts";
import { metaGet } from "./kv.ts";

// Shared client script injected into every served HTML page.
export const INJECT_PATH = "/__inject.js"; // reserved URL, served on every subdomain
const INJECT_FILE = resolve(import.meta.dir, "client", "inject.js");
const INJECT_TAG = `<script type="module" src="${INJECT_PATH}"></script>`;

/** Extract the site name from a Host header, or null for the apex domain. */
export function siteFromHost(host: string | null): string | null {
  if (!host) return null;
  const hostname = host.split(":")[0]!.toLowerCase(); // strip port
  if (hostname === BASE_DOMAIN) return null; // apex, no subdomain
  const suffix = `.${BASE_DOMAIN}`;
  if (!hostname.endsWith(suffix)) return null;
  const label = hostname.slice(0, -suffix.length);
  // only support a single subdomain label, and reject anything path-ish
  if (!label || label.includes("/") || label.includes("..")) return null;
  return label;
}

/** True if `site` has a directory on disk under SITES_DIR. */
export function siteExists(site: string): boolean {
  return existsSync(join(SITES_DIR, site));
}

/**
 * Whether a cert should exist for `host`: true for the apex domain or any
 * existing site, false otherwise. Lets a front proxy mint a per-subdomain
 * TLS cert on demand (no wildcard) while refusing unknown/bogus hosts.
 */
export function isKnownHost(host: string | null): boolean {
  if (!host) return false;
  const hostname = host.split(":")[0]!.toLowerCase(); // strip port
  if (hostname === BASE_DOMAIN) return true; // apex landing page
  const site = siteFromHost(hostname);
  return site !== null && siteExists(site);
}

/**
 * Resolve a request pathname to an absolute file path inside `root`,
 * guarding against path-traversal escapes. Returns null if it escapes.
 */
function resolveFilePath(root: string, pathname: string): string | null {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith("/")) rel += "index.html"; // directory -> index.html
  const filePath = resolve(root, "." + (rel.startsWith("/") ? rel : "/" + rel));
  // must stay within root
  if (filePath !== root && !filePath.startsWith(root + sep)) return null;
  return filePath;
}

/** Escape a string for safe interpolation into HTML text/attributes. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Best-effort "last deployed" time for a site (epoch ms), or null if unknown.
 * Prefers the deployed_at recorded on each file write; falls back to the newest
 * mtime of the site's key source files for sites deployed before it was tracked.
 */
async function siteDeployedAt(name: string): Promise<number | null> {
  const recorded = Number(metaGet(name, "deployed_at"));
  if (Number.isFinite(recorded) && recorded > 0) return recorded;

  let newest = 0;
  for (const rel of ["public/index.html", "singlepage.json"]) {
    try {
      const s = await stat(join(SITES_DIR, name, rel));
      newest = Math.max(newest, s.mtimeMs);
    } catch {
      // file absent — ignore
    }
  }
  return newest || null;
}

/** Compact relative time, e.g. "just now", "5 minutes ago", "3 days ago". */
function timeAgo(ts: number): string {
  const sec = Math.round((Date.now() - ts) / 1000);
  if (sec < 45) return "just now";
  const units: [number, string][] = [
    [60, "minute"],
    [60, "hour"],
    [24, "day"],
    [30, "month"],
    [12, "year"],
  ];
  let value = sec / 60; // start in minutes
  let label = "minute";
  for (let i = 1; i < units.length && value >= units[i]![0]; i++) {
    value /= units[i]![0];
    label = units[i]![1]!;
  }
  const n = Math.round(value);
  return `${n} ${label}${n === 1 ? "" : "s"} ago`;
}

/** Best-effort read of a site's <title> for a friendlier card label. */
async function siteTitle(name: string): Promise<string | null> {
  try {
    const file = Bun.file(join(SITES_DIR, name, "public", "index.html"));
    if (!(await file.exists())) return null;
    // Only scan the head; titles live near the top and files can be large.
    const head = (await file.text()).slice(0, 4096);
    const m = head.match(/<title>([^<]*)<\/title>/i);
    const title = m?.[1]?.trim();
    return title || null;
  } catch {
    return null;
  }
}

/** Apex landing page: a card grid of the sites currently on disk (read live). */
export async function apexResponse(): Promise<Response> {
  let entries: string[] = [];
  try {
    const dirents = await readdir(SITES_DIR, { withFileTypes: true });
    entries = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    // sites dir missing — fall through to empty list
  }
  const sites = await Promise.all(
    entries.map(async (name) => ({
      name,
      url: `http://${name}.${BASE_DOMAIN}:${PORT}/`,
      title: (await siteTitle(name)) ?? name,
      deployedAt: await siteDeployedAt(name),
    })),
  );

  // Most recently deployed first; sites with no known deploy time sink to the
  // bottom, tie-broken alphabetically.
  sites.sort((a, b) => {
    if (a.deployedAt !== b.deployedAt) return (b.deployedAt ?? 0) - (a.deployedAt ?? 0);
    return a.name.localeCompare(b.name);
  });

  // Each card embeds the real site in a scaled-down iframe, giving a live
  // "screenshot" that never goes stale. The iframe renders at desktop width and
  // is scaled by --preview-scale (see CSS) to fit the fixed card thumbnail.
  const cards = sites
    .map((s) => {
      const url = escapeHtml(s.url);
      const title = escapeHtml(s.title);
      const sub = escapeHtml(`${s.name}.${BASE_DOMAIN}`);
      const deployed =
        s.deployedAt !== null
          ? `<span class="deployed" title="${escapeHtml(new Date(s.deployedAt).toLocaleString())}">Deployed ${escapeHtml(timeAgo(s.deployedAt))}</span>`
          : "";
      return `      <a class="card" href="${url}">
        <div class="thumb">
          <iframe src="${url}" loading="lazy" scrolling="no" tabindex="-1"
                  aria-hidden="true" sandbox="allow-scripts allow-same-origin"></iframe>
        </div>
        <div class="meta">
          <span class="title">${title}</span>
          <span class="sub">${sub}</span>
          ${deployed}
        </div>
      </a>`;
    })
    .join("\n");

  const grid = sites.length
    ? `<div class="grid">\n${cards}\n    </div>`
    : `<p class="empty">No sites found in <code>./sites</code> yet.</p>`;

  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sites</title>
<style>
  :root {
    color-scheme: light dark;
    --preview-w: 1280px;    /* virtual viewport the iframe renders at */
    --card-w: 340px;        /* on-screen thumbnail width */
    --preview-scale: 0.265625; /* = card-w / preview-w */
  }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    margin: 0; padding: 3rem 1.5rem 4rem;
    background: #0b0d12; color: #e8e8ea;
    background-image: radial-gradient(1200px 600px at 50% -10%, #1a2030 0%, #0b0d12 60%);
    min-height: 100vh;
  }
  header { max-width: 1120px; margin: 0 auto 2.5rem; }
  h1 { margin: 0 0 .4rem; font-size: 2rem; letter-spacing: -0.02em; }
  header p { margin: 0; color: #9aa0ac; }
  .grid {
    max-width: 1120px; margin: 0 auto;
    display: grid; gap: 1.5rem; justify-content: center;
    grid-template-columns: repeat(auto-fill, var(--card-w));
  }
  .card {
    display: flex; flex-direction: column;
    text-decoration: none; color: inherit;
    background: #141821; border: 1px solid #232838; border-radius: 14px;
    overflow: hidden;
    transition: transform .15s ease, border-color .15s ease, box-shadow .15s ease;
  }
  .card:hover {
    transform: translateY(-3px);
    border-color: #3a4258;
    box-shadow: 0 12px 30px rgba(0,0,0,.45);
  }
  .thumb {
    position: relative; width: var(--card-w); aspect-ratio: 4 / 3;
    overflow: hidden; background: #0f1218;
    border-bottom: 1px solid #232838;
  }
  .thumb iframe {
    position: absolute; top: 0; left: 0;
    width: var(--preview-w); height: calc(var(--preview-w) * 3 / 4);
    border: 0;
    transform: scale(var(--preview-scale)); transform-origin: top left;
    pointer-events: none;
  }
  .meta { display: flex; flex-direction: column; gap: .15rem; padding: .85rem 1rem 1rem; }
  .title { font-weight: 600; font-size: 1rem; }
  .sub { font-size: .8rem; color: #8b91a0; }
  .deployed { font-size: .75rem; color: #6f7686; margin-top: .35rem; }
  .empty { max-width: 1120px; margin: 0 auto; color: #9aa0ac; }
  code { background: #1b2130; padding: .1rem .35rem; border-radius: 5px; }
</style>
</head>
<body>
  <header>
    <h1>Sites</h1>
  </header>
  ${grid}
</body>
</html>`;
  return new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/** Serve the shared injected client (reserved INJECT_PATH route). */
export async function serveInjectScript(): Promise<Response> {
  const f = Bun.file(INJECT_FILE);
  if (await f.exists()) {
    return new Response(f, {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-cache", // always pick up edits/deploys
      },
    });
  }
  return new Response("// inject script not found", {
    status: 404,
    headers: { "content-type": "text/javascript; charset=utf-8" },
  });
}

/** Serve a static file from a site's public/ dir, injecting the client into HTML. */
export async function serveStatic(site: string, pathname: string): Promise<Response> {
  const root = join(SITES_DIR, site, "public");
  const filePath = resolveFilePath(root, pathname);
  if (!filePath) return new Response("Forbidden", { status: 403 });

  const file = Bun.file(filePath);
  if (await file.exists()) {
    // Inject the shared client into HTML; serve everything else as-is.
    if (filePath.endsWith(".html")) {
      const html = await file.text();
      const out = html.includes("</body>")
        ? html.replace("</body>", `${INJECT_TAG}\n</body>`)
        : html + INJECT_TAG;
      return new Response(out, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return new Response(file); // Bun infers Content-Type from extension
  }

  return new Response("Not found", { status: 404 });
}
