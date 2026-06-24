import type { ServerWebSocket } from "bun";

// Per-site event bus over a WebSocket. Browsers open one socket per page and
// receive JSON-enveloped frames { type, data } of three types: "change" (live
// reload), "kv" (key/value store changes), and "log" (console output from
// server/cron code; see appendLog in kv.ts).
//
// "kv" frames are filtered server-side: each socket declares the keys/prefixes
// it cares about by sending { type: "sub", patterns: [...] }, and only matching
// changes are delivered to it. "change" and "log" always go to every socket.
export const EVENTS_PATH = "/__events";

/** Per-socket state attached at upgrade time (see server.upgrade in index.ts). */
export type WsData = { site: string; patterns: Set<string> };
type Ws = ServerWebSocket<WsData>;

const siteSockets = new Map<string, Set<Ws>>();
const MAX_PATTERNS = 256; // defensive cap on a single socket's subscription set

/** Does `key` match any subscription pattern? Trailing "*" is a prefix match
 *  (so "*" alone matches everything); otherwise the pattern must equal the key. */
export function matches(patterns: Set<string>, key: string): boolean {
  for (const p of patterns) {
    if (p.endsWith("*")) {
      if (key.startsWith(p.slice(0, -1))) return true;
    } else if (p === key) {
      return true;
    }
  }
  return false;
}

/** Register a freshly-opened socket as a subscriber for its site. */
export function addClient(ws: Ws): void {
  let set = siteSockets.get(ws.data.site);
  if (!set) siteSockets.set(ws.data.site, (set = new Set()));
  set.add(ws);
}

/** Drop a closed socket from its site's subscriber set. */
export function removeClient(ws: Ws): void {
  siteSockets.get(ws.data.site)?.delete(ws);
}

/** Handle a client->server message; the only kind today is a subscription update. */
export function onSubMessage(ws: Ws, raw: string | Buffer): void {
  let msg: unknown;
  try {
    msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
  } catch {
    return; // ignore malformed frames
  }
  if (
    !msg ||
    typeof msg !== "object" ||
    (msg as { type?: unknown }).type !== "sub" ||
    !Array.isArray((msg as { patterns?: unknown }).patterns)
  ) {
    return;
  }
  const patterns = (msg as { patterns: unknown[] }).patterns
    .filter((p): p is string => typeof p === "string")
    .slice(0, MAX_PATTERNS);
  ws.data.patterns = new Set(patterns);
}

/** Send a frame to every open socket of `site` (unfiltered: "change"/"log"). */
export function broadcast(site: string, type: string, data: unknown): void {
  const set = siteSockets.get(site);
  if (!set) return;
  const frame = JSON.stringify({ type, data });
  for (const ws of set) ws.send(frame);
}

/** Send a "kv" change only to sockets whose patterns match `key`. */
export function broadcastKv(site: string, key: string, data: unknown): void {
  const set = siteSockets.get(site);
  if (!set) return;
  const frame = JSON.stringify({ type: "kv", data });
  for (const ws of set) {
    if (matches(ws.data.patterns, key)) ws.send(frame);
  }
}

/** Map an uploaded relpath to a browser path and notify, if it's a public file. */
export function notifyReloadForPath(site: string, relpath: string): void {
  const prefix = "public/";
  if (!relpath.startsWith(prefix)) return; // server/cron/config don't affect the page
  broadcast(site, "change", "/" + relpath.slice(prefix.length));
}
