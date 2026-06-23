// Per-site event bus over SSE. Browsers open one stream and receive multiple
// event types: "change" (live reload), "kv" (key/value store changes), and
// "log" (console output from server/cron code; see appendLog in kv.ts).
export const EVENTS_PATH = "/__events";

const siteClients = new Map<string, Set<ReadableStreamDefaultController>>();
const sseEncoder = new TextEncoder();

// NOTE on scale: every event for a site is broadcast to ALL of that site's open
// browsers; per-key filtering happens client-side. Fine for chat-sized loads,
// but a high-write site or many keys means redundant traffic. The eventual fix
// is server-side per-key subscriptions (a client->server subscribe channel).
export function broadcast(site: string, event: string, data: string): void {
  const set = siteClients.get(site);
  if (!set) return;
  const msg = sseEncoder.encode(`event: ${event}\ndata: ${data}\n\n`);
  for (const ctrl of set) {
    try {
      ctrl.enqueue(msg);
    } catch {
      set.delete(ctrl); // stream already closed
    }
  }
}

/** Map an uploaded relpath to a browser path and notify, if it's a public file. */
export function notifyReloadForPath(site: string, relpath: string): void {
  const prefix = "public/";
  if (!relpath.startsWith(prefix)) return; // server/cron/config don't affect the page
  broadcast(site, "change", "/" + relpath.slice(prefix.length));
}

/** Open SSE stream that registers this browser as a subscriber for the site. */
export function eventStream(site: string): Response {
  let ctrlRef: ReadableStreamDefaultController | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream({
    start(controller) {
      ctrlRef = controller;
      let set = siteClients.get(site);
      if (!set) siteClients.set(site, (set = new Set()));
      set.add(controller);
      controller.enqueue(sseEncoder.encode("retry: 2000\n\n")); // reconnect hint
      // Keep intermediaries from dropping an idle connection.
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(sseEncoder.encode(": ping\n\n"));
        } catch {
          /* closed; cancel() will clean up */
        }
      }, 25000);
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
      if (ctrlRef) siteClients.get(site)?.delete(ctrlRef);
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
