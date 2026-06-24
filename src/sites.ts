import { join, resolve, sep } from "node:path";
import { readdir } from "node:fs/promises";
import { SITES_DIR, BASE_DOMAIN, PORT } from "./config.ts";

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

/** Apex landing page: list the sites currently on disk (read live). */
export async function apexResponse(): Promise<Response> {
  let entries: string[] = [];
  try {
    const dirents = await readdir(SITES_DIR, { withFileTypes: true });
    entries = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    // sites dir missing — fall through to empty list
  }
  const links = entries
    .map((name) => {
      const url = `http://${name}.${BASE_DOMAIN}:${PORT}/`;
      return `<li><a href="${url}">${name}</a></li>`;
    })
    .join("\n");
  const body = `<!doctype html>
<meta charset="utf-8">
<title>Sites</title>
<h1>Available sites</h1>
<ul>
${links || "<li><em>No sites found in ./sites</em></li>"}
</ul>`;
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
