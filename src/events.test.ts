import { test, expect } from "bun:test";
import { matches } from "./events.ts";

const set = (...p: string[]) => new Set(p);

test("exact patterns match only the same key", () => {
  expect(matches(set("counter"), "counter")).toBe(true);
  expect(matches(set("counter"), "counter2")).toBe(false);
  expect(matches(set("counter"), "count")).toBe(false);
});

test("prefix patterns match by leading segment", () => {
  expect(matches(set("chat:*"), "chat:msg:1")).toBe(true);
  expect(matches(set("chat:*"), "chat:")).toBe(true);
  expect(matches(set("chat:*"), "chatroom")).toBe(false);
  expect(matches(set("chat:*"), "other")).toBe(false);
});

test('"*" matches everything', () => {
  expect(matches(set("*"), "anything")).toBe(true);
  expect(matches(set("*"), "")).toBe(true);
  expect(matches(set("*"), "chat:msg:1")).toBe(true);
});

test("an empty pattern set matches nothing", () => {
  expect(matches(set(), "counter")).toBe(false);
});

test("a key matches if any pattern in the set matches", () => {
  expect(matches(set("a", "chat:*"), "chat:msg:1")).toBe(true);
  expect(matches(set("a", "chat:*"), "a")).toBe(true);
  expect(matches(set("a", "chat:*"), "b")).toBe(false);
});
