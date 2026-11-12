import { describe, expect, test } from "bun:test";
import { isCacheFresh } from "../extensions/alibaba";

const TTL_MS = 4 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

describe("isCacheFresh — the startup fast path", () => {
  test("a just-written cache is fresh, so startup skips the network", () => {
    expect(isCacheFresh(NOW, NOW)).toBe(true);
  });

  test("a cache inside the TTL is fresh", () => {
    expect(isCacheFresh(NOW - TTL_MS + 1000, NOW)).toBe(true);
  });

  test("a cache at or past the TTL is stale, so a live fetch happens", () => {
    expect(isCacheFresh(NOW - TTL_MS, NOW)).toBe(false);
    expect(isCacheFresh(NOW - TTL_MS - 1000, NOW)).toBe(false);
  });

  test("a missing fetchedAt is never fresh", () => {
    expect(isCacheFresh(undefined, NOW)).toBe(false);
    expect(isCacheFresh(NaN, NOW)).toBe(false);
  });
});
