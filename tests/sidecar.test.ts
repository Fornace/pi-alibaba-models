import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSidecarRequest,
  completionsSearchAllowed,
  dashScopeErrorMessage,
  formatSidecarResult,
  parseSidecarResponse,
  pickSidecarModel,
  pickSidecarTransport,
  responsesToolsAllowed,
  sidecarToolsFor,
  SIDECAR_RESULT_CHAR_LIMIT,
} from "../extensions/sidecar.ts";

describe("allowlists", () => {
  it("allows Qwen Responses built-in tools and rejects third-party ids", () => {
    assert.equal(responsesToolsAllowed("qwen3.7-max"), true);
    assert.equal(responsesToolsAllowed("qwen3.8-max"), true);
    assert.equal(responsesToolsAllowed("qwen3.6-plus"), true);
    assert.equal(responsesToolsAllowed("qwen-plus"), true);
    assert.equal(responsesToolsAllowed("deepseek-v4-pro"), false);
    assert.equal(responsesToolsAllowed("kimi-k2.6"), false);
    assert.equal(responsesToolsAllowed("glm-5.2"), false);
    assert.equal(responsesToolsAllowed("qwen3.5-omni-plus"), false);
  });

  it("keeps Completions enable_search off for Responses-only search models", () => {
    assert.equal(completionsSearchAllowed("qwen-plus"), true);
    assert.equal(completionsSearchAllowed("qwen3.7-plus"), true);
    assert.equal(completionsSearchAllowed("qwen3.7-max"), false);
    assert.equal(completionsSearchAllowed("qwen3.6-plus"), false);
    assert.equal(completionsSearchAllowed("qwen3.8-max"), false);
  });
});

describe("pickSidecarModel", () => {
  it("prefers a catalog Qwen for research on Responses", () => {
    const picked = pickSidecarModel({
      catalogIds: ["glm-5.2", "qwen3.7-plus", "kimi-k2.6"],
      action: "research",
    });
    assert.deepEqual(picked, { id: "qwen3.7-plus", transport: "responses" });
  });

  it("picks Responses for qwen-plus search (Completions is the fallback path)", () => {
    assert.equal(pickSidecarTransport("qwen-plus", "search"), "responses");
    const picked = pickSidecarModel({
      catalogIds: ["qwen-plus"],
      action: "search",
    });
    assert.deepEqual(picked, { id: "qwen-plus", transport: "responses" });
    assert.equal(pickSidecarTransport("qwen3.7-plus", "search"), "responses");
  });

  it("rejects a preferred non-Qwen id", () => {
    const picked = pickSidecarModel({
      preferred: "deepseek-v4-pro",
      catalogIds: ["deepseek-v4-pro", "qwen3.7-plus"],
      action: "research",
    });
    assert.equal("error" in picked, true);
  });
});

describe("request + parse", () => {
  it("sends the recommended built-in set for research", () => {
    assert.deepEqual(sidecarToolsFor("research"), [
      { type: "web_search" },
      { type: "web_extractor" },
      { type: "code_interpreter" },
    ]);
    const req = buildSidecarRequest({
      model: "qwen3.7-plus",
      transport: "responses",
      action: "research",
      task: "Hangzhou weather",
    });
    assert.equal(req.url, "/responses");
    assert.equal(req.body.enable_thinking, true);
    assert.deepEqual(req.body.tools, sidecarToolsFor("research"));
  });

  it("puts enable_search on Completions search", () => {
    const req = buildSidecarRequest({
      model: "qwen-plus",
      transport: "completions",
      action: "search",
      task: "Hangzhou weather",
      strategy: "turbo",
    });
    assert.equal(req.url, "/chat/completions");
    assert.equal(req.body.enable_search, true);
    assert.deepEqual(req.body.search_options, { search_strategy: "turbo" });
  });

  it("lifts output_text and citation sources from Responses output items", () => {
    const parsed = parseSidecarResponse({
      output_text: "Sunny in Hangzhou.",
      output: [
        {
          type: "web_search_call",
          action: {
            query: "Hangzhou weather",
            sources: [{ title: "Weather", url: "https://example.com/w" }],
          },
        },
        { type: "web_extractor_call", action: { url: "https://example.com/w" } },
      ],
    });
    assert.equal(parsed.text, "Sunny in Hangzhou.");
    assert.deepEqual(parsed.calls, ["web_search: Hangzhou weather", "web_extractor: https://example.com/w"]);
    assert.equal(parsed.sources[0]?.url, "https://example.com/w");
    const formatted = formatSidecarResult(parsed);
    assert.match(formatted, /Sunny in Hangzhou/);
    assert.match(formatted, /https:\/\/example.com\/w/);
  });

  it("falls back to Completions choices[].message.content", () => {
    const parsed = parseSidecarResponse({
      choices: [{ message: { content: "42" } }],
    });
    assert.equal(parsed.text, "42");
  });

  it("surfaces DashScope error bodies", () => {
    assert.match(
      dashScopeErrorMessage(400, { error: { message: "model not supported" } }),
      /400.*model not supported/,
    );
  });

  it("truncates oversized sidecar text", () => {
    const formatted = formatSidecarResult({ text: "x".repeat(SIDECAR_RESULT_CHAR_LIMIT + 10), sources: [], calls: [] });
    assert.ok(formatted.length < SIDECAR_RESULT_CHAR_LIMIT + 80);
    assert.match(formatted, /truncated sidecar output/);
  });
});
