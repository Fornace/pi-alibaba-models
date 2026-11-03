/**
 * The coercion contract between the two Alibaba tools' parameter schemas and the
 * host validator — pinned against pi 1.5.0.
 *
 * pi 1.5.0 validates tool arguments with `@earendil-works/pi-schema` instead of
 * TypeBox's checker, and that release is the one that gives *plain JSON Schema*
 * tools the same coercion TypeBox-built tools always had: numeric strings to
 * numbers, `"true"` to `true`, a single value to a one-item array, `null` in an
 * optional property dropped. Both schemas here are plain JSON Schema (`as const`),
 * so the behaviour of 1.5.0 is what the model actually gets — and the error text
 * it sees is pi-schema's (`- /task: missing`, `- /n: expected number, got string`),
 * not TypeBox's (`must be number`).
 *
 * Two things are asserted here and nowhere else:
 *
 *  1. neither schema holds a TypeBox-only feature (`Type.Refine`, `Type.BigInt`,
 *     `Type.Undefined`, codecs, `Format.Set()` formats) — 1.5.0 silently ignores
 *     those for tool arguments, so a schema relying on one would validate
 *     nothing while looking like it validates something;
 *  2. loose arguments a model really emits (`"5"` for a number, a bare path for
 *     the `images` array, `null` for an optional field) are accepted and
 *     normalised, and the failure text a model sees on a bad call is pi-schema's.
 *
 * `@earendil-works/pi-schema` is a dependency of the host and is hoisted into
 * this repo's `node_modules` by the 1.5.0 `devDependencies`, so this suite runs
 * offline against the very validator the host will use.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compile } from "@earendil-works/pi-schema";
import { formats } from "@earendil-works/pi-schema/formats";
import { ALIBABA_IMAGE_PARAMETERS } from "../extensions/image.ts";
import { ALIBABA_TOOLS_PARAMETERS } from "../extensions/sidecar.ts";

const toolsValidator = compile(ALIBABA_TOOLS_PARAMETERS, { coerce: true });
const imageValidator = compile(ALIBABA_IMAGE_PARAMETERS, { coerce: true });

/** Every path a schema can carry that 1.5.0 stops honouring for tool arguments. */
function typeBoxOnlyPaths(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((item, i) => typeBoxOnlyPaths(item, `${path}/${i}`));
  if (!value || typeof value !== "object") return [];
  const found: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    // TypeBox encodes Refine/BigInt/Undefined/codecs as custom `[Kind]` symbols,
    // which survive JSON serialisation as a string key only when a schema is
    // passed around as `kind`; a registered format shows up in `format`. A schema
    // is allowed exactly the formats pi-schema knows — anything else would
    // silently stop being checked.
    if (key === "format" && typeof child === "string" && !(child in formats)) {
      found.push(`${path}/format=${child}`);
    }
    if (key === "TypeBox" || key === "~kind" || key === "[Kind]") found.push(`${path}/${key}`);
    found.push(...typeBoxOnlyPaths(child, `${path}/${key}`));
  }
  return found;
}

describe("alibaba_tools schema — pi 1.5.0 validation contract", () => {
  it("carries no TypeBox-only feature that 1.5.0 would silently ignore", () => {
    assert.deepEqual(typeBoxOnlyPaths(ALIBABA_TOOLS_PARAMETERS), []);
  });

  it("drops a null in the optional strategy instead of rejecting the call", () => {
    const result = toolsValidator.parse({ task: "GLM release notes", strategy: null });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal("strategy" in (result.value as object), false);
  });

  it("accepts the enums it advertises and nothing else", () => {
    for (const action of ["search", "research", "code", "image"]) {
      assert.equal(toolsValidator.parse({ task: "x", action }).ok, true, action);
    }
    for (const strategy of ["turbo", "max", "agent", "agent_max"]) {
      assert.equal(toolsValidator.parse({ task: "x", strategy }).ok, true, strategy);
    }
    assert.equal(toolsValidator.parse({ task: "x", action: "not-an-action" }).ok, false);
    assert.equal(toolsValidator.parse({ task: "x", strategy: "not-a-strategy" }).ok, false);
  });

  it("reports a missing required field with pi-schema's message, not TypeBox's", () => {
    const result = toolsValidator.parse({});
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.deepEqual(
      result.errors.map(({ path, keyword, message }) => ({ path, keyword, message })),
      [{ path: "/task", keyword: "required", message: "missing" }],
    );
  });
});

describe("alibaba_image schema — pi 1.5.0 validation contract", () => {
  it("carries no TypeBox-only feature that 1.5.0 would silently ignore", () => {
    assert.deepEqual(typeBoxOnlyPaths(ALIBABA_IMAGE_PARAMETERS), []);
  });

  it("turns a numeric string into a number", () => {
    for (const key of ["n", "seed"] as const) {
      const result = imageValidator.parse({ task: "a cat", [key]: "5" });
      assert.equal(result.ok, true, key);
      if (!result.ok) continue;
      assert.equal((result.value as Record<string, unknown>)[key], 5, key);
    }
  });

  it("turns a single reference path into a one-item array", () => {
    const result = imageValidator.parse({ task: "a cat", images: "pic.png" });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual((result.value as { images?: unknown }).images, ["pic.png"]);
  });

  it("drops a null in an optional property instead of rejecting the call", () => {
    const result = imageValidator.parse({ task: "a cat", n: null, watermark: null });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const value = result.value as Record<string, unknown>;
    assert.equal("n" in value, false);
    assert.equal("watermark" in value, false);
  });

  it("reports a missing required field with pi-schema's message, not TypeBox's", () => {
    const result = imageValidator.parse({});
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.deepEqual(
      result.errors.map(({ path, keyword, message }) => ({ path, keyword, message })),
      [{ path: "/task", keyword: "required", message: "missing" }],
    );
  });

  it("reports a wrong type as 'expected number, got string'", () => {
    const result = imageValidator.parse({ task: "a cat", n: "not-a-number" });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.deepEqual(
      result.errors.map(({ path, keyword, message }) => ({ path, keyword, message })),
      [{ path: "/n", keyword: "type", message: "expected number, got string" }],
    );
  });
});
