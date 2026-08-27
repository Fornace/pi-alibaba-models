import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isCacheFresh } from "../extensions/alibaba.ts";

// Spec: catalogs younger than 4 hours are the startup fast path.
const TTL_MS = 4 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

describe("isCacheFresh — startup fast path", () => {
  it("treats a just-written cache as fresh", () => {
    assert.equal(isCacheFresh(NOW, NOW), true);
  });

  it("treats a cache still inside the 4h TTL as fresh", () => {
    assert.equal(isCacheFresh(NOW - TTL_MS + 1000, NOW), true);
  });

  it("treats a cache at or past the 4h TTL as stale", () => {
    assert.equal(isCacheFresh(NOW - TTL_MS, NOW), false);
    assert.equal(isCacheFresh(NOW - TTL_MS - 1000, NOW), false);
  });

  it("never treats a missing or non-finite fetchedAt as fresh", () => {
    assert.equal(isCacheFresh(undefined, NOW), false);
    assert.equal(isCacheFresh(NaN, NOW), false);
  });
});
