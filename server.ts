import { existsSync } from "node:fs";
import { join } from "node:path";
import { SITES_DIR } from "./config.ts";
import { runModule } from "./sandbox.ts";

// Per-site server-side function handlers, mounted under the reserved /__fn/*
// prefix (collision-free with /api/*, /__kv, /__events, /__inject.js, and static
// files). A request to /__fn/<rest> runs sites/<site>/server/<rest>.js; /__fn and
// /__fn/ run server/index.js. The handler's default export receives a plain,
// pre-marshalled request object and returns a plain response descriptor.
export const FN_PREFIX = "/__fn";

const SERVER_DEADLINE_MS = 60_000; // wall-clock budget per request (allows slow outbound fetches)

/** Map /__fn/<rest> to a site-relative server/<rest>.js path. */
function relpathFor(pathname: string): string {
  let rest = pathname === FN_PREFIX ? "" : pathname.slice(FN_PREFIX.length + 1); // drop "/__fn/"
  rest = decodeURIComponent(rest);
  if (rest === "" || rest.endsWith("/")) rest += "index";
  return `server/${rest}.js`;
}

/** Build the plain request object handed to user code (never the live Request). */
async function marshalRequest(req: Request, url: URL): Promise<Record<string, unknown>> {
  const query: Record<string, string> = {};
  for (const [k, v] of url.searchParams) query[k] = v;
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => (headers[k] = v));
  // Read the body once on the host; user code can't stream a host body.
  let body = "";
  if (req.method !== "GET" && req.method !== "HEAD") {
    try {
      body = await req.text();
    } catch {
      body = "";
    }
  }
  return { method: req.method, path: url.pathname, query, headers, body };
}

/** Turn the handler's return value into a real Response. */
function toResponse(value: unknown): Response {
  // A plain { status?, headers?, body } descriptor (incl. ctx.json/text/html sugar).
  if (value && typeof value === "object" && "body" in (value as any)) {
    const v = value as { status?: number; headers?: Record<string, string>; body?: unknown };
    const headers = { "content-type": "text/plain; charset=utf-8", ...(v.headers ?? {}) };
    const body = typeof v.body === "string" ? v.body : JSON.stringify(v.body ?? null);
    return new Response(body, { status: v.status ?? 200, headers });
  }
  // Bare value -> JSON.
  return new Response(JSON.stringify(value ?? null), {
    headers: { "content-type": "application/json" },
  });
}

/** Handle a /__fn/* request for a site. */
export async function handleServer(req: Request, site: string, url: URL): Promise<Response> {
  if (!existsSync(join(SITES_DIR, site))) {
    return new Response("Unknown site", { status: 404 });
  }
  const relpath = relpathFor(url.pathname);
  const request = await marshalRequest(req, url);

  const result = await runModule(site, relpath, request, {
    deadlineMs: SERVER_DEADLINE_MS,
    source: relpath,
  });

  if (result.ok) return toResponse(result.value);
  if (result.notFound) return new Response("Not found", { status: 404 });
  const status = result.timeout ? 504 : 500;
  return new Response(JSON.stringify({ error: result.error }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
