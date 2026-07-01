import { test, expect } from "bun:test";
import { allow, clientIp } from "./ratelimit.ts";

test("allows up to burst, then denies", () => {
  const key = "t:burst";
  const t = 1_000_000;
  for (let i = 0; i < 5; i++) {
    expect(allow(key, 1, 5, t)).toBe(true); // 5 tokens available at t
  }
  expect(allow(key, 1, 5, t)).toBe(false); // 6th at the same instant -> denied
});

test("refills at the configured rate over time", () => {
  const key = "t:refill";
  const t = 2_000_000;
  for (let i = 0; i < 5; i++) allow(key, 2, 5, t); // drain the bucket
  expect(allow(key, 2, 5, t)).toBe(false);

  // 2 tokens/sec -> after 1s, one full token is back.
  expect(allow(key, 2, 5, t + 1000)).toBe(true);
  expect(allow(key, 2, 5, t + 1000)).toBe(true);
  expect(allow(key, 2, 5, t + 1000)).toBe(false);
});

test("refill is capped at burst (no unbounded accrual while idle)", () => {
  const key = "t:cap";
  const t = 3_000_000;
  allow(key, 1, 3, t); // 2 left
  // Idle a long time; the bucket refills only up to burst (3), not 3 + hours.
  expect(allow(key, 1, 3, t + 3_600_000)).toBe(true);
  expect(allow(key, 1, 3, t + 3_600_000)).toBe(true);
  expect(allow(key, 1, 3, t + 3_600_000)).toBe(true);
  expect(allow(key, 1, 3, t + 3_600_000)).toBe(false);
});

test("separate keys have independent buckets", () => {
  const t = 4_000_000;
  expect(allow("t:a", 1, 1, t)).toBe(true);
  expect(allow("t:a", 1, 1, t)).toBe(false); // a is drained
  expect(allow("t:b", 1, 1, t)).toBe(true); // b is untouched
});

// A minimal Server stand-in exposing just requestIP.
function fakeServer(address: string | null) {
  return { requestIP: () => (address ? { address, port: 0, family: "IPv4" } : null) } as any;
}

test("clientIp takes the rightmost non-internal X-Forwarded-For entry", () => {
  // Client tries to spoof by prepending a fake; Caddy appends the real IP, then
  // kamal-proxy appends the loopback hop. We must return the real IP (203.0.113.7).
  const req = new Request("http://x/", {
    headers: { "x-forwarded-for": "9.9.9.9, 203.0.113.7, 127.0.0.1" },
  });
  expect(clientIp(req, fakeServer(null))).toBe("203.0.113.7");
});

test("clientIp falls back to the socket address without a proxy header", () => {
  const req = new Request("http://x/");
  expect(clientIp(req, fakeServer("198.51.100.4"))).toBe("198.51.100.4");
  expect(clientIp(req, fakeServer(null))).toBe("local");
});
