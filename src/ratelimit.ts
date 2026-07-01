/**
 * In-process token-bucket rate limiter. Buckets are keyed by an arbitrary string
 * the caller composes (e.g. "fn:<ip>:<site>"), created lazily, and pruned
 * opportunistically so the map can't grow without bound. State is per-process —
 * a backstop against a single visitor hammering the expensive routes, not a
 * distributed quota. See index.ts for where it's applied.
 */

type Bucket = { tokens: number; ts: number };

const buckets = new Map<string, Bucket>();

// Opportunistic pruning (no timers, so it's inert in tests): drop buckets that
// have been idle long enough to have fully refilled — recreating them fresh
// yields the same result, so deleting them is lossless.
const PRUNE_INTERVAL_MS = 5 * 60_000;
const IDLE_MS = 10 * 60_000;
let lastPrune = 0;

function maybePrune(now: number): void {
  if (now - lastPrune < PRUNE_INTERVAL_MS) return;
  lastPrune = now;
  for (const [key, b] of buckets) {
    if (now - b.ts > IDLE_MS) buckets.delete(key);
  }
}

/**
 * Consume one token from `key`'s bucket, which refills at `rps` tokens/second up
 * to `burst`. Returns true if a token was available (allow), false if the bucket
 * is empty (deny -> 429). `now` is injectable for tests.
 */
export function allow(key: string, rps: number, burst: number, now: number = Date.now()): boolean {
  maybePrune(now);
  let b = buckets.get(key);
  if (!b) {
    b = { tokens: burst, ts: now };
    buckets.set(key, b);
  }
  // Refill for the time elapsed since the last hit, capped at burst.
  b.tokens = Math.min(burst, b.tokens + ((now - b.ts) / 1000) * rps);
  b.ts = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

/** True for loopback/private hops we skip when trusting X-Forwarded-For. */
function isInternal(ip: string): boolean {
  return (
    ip === "" ||
    ip === "::1" ||
    ip.startsWith("127.") ||
    ip.startsWith("::ffff:127.") ||
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    ip.startsWith("fc") ||
    ip.startsWith("fd")
  );
}

/**
 * Best-effort real client IP. We sit behind Caddy (which sets the client IP in
 * X-Forwarded-For) and kamal-proxy (a loopback hop). Reading the *rightmost*
 * non-internal entry returns the address Caddy saw and ignores any X-Forwarded-For
 * a client tries to prepend to dodge the limiter. Falls back to the socket
 * address (or "local") when there's no proxy, e.g. local dev.
 */
export function clientIp(
  req: Request,
  server: { requestIP(req: Request): { address: string } | null },
): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim());
    for (let i = parts.length - 1; i >= 0; i--) {
      if (!isInternal(parts[i]!)) return parts[i]!;
    }
  }
  return server.requestIP(req)?.address ?? "local";
}
