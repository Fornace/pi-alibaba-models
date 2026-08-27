import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applySidecarStreamEvent,
  buildSidecarRequest,
  completionsSearchAllowed,
  consumeSseChunk,
  dashScopeErrorMessage,
  formatSidecarProgress,
  formatSidecarResult,
  parseSidecarResponse,
  pickSidecarModel,
  pickSidecarTransport,
  postSidecar,
  responsesToolsAllowed,
  sidecarTimeoutMessage,
  sidecarTimeoutMs,
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

  it("prefers Flash/Plus over Max for search so the sidecar is not a second flagship bill", () => {
    const picked = pickSidecarModel({
      catalogIds: ["qwen3.8-max", "qwen-plus", "glm-5.2"],
      action: "search",
    });
    assert.deepEqual(picked, { id: "qwen-plus", transport: "responses" });
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
    assert.equal(req.body.stream, true);
    assert.equal(req.timeoutMs, 480_000);
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
    assert.equal(req.body.stream, true);
    assert.equal(req.timeoutMs, 180_000);
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

  it("accumulates SSE text deltas and tool-call items", () => {
    const parsed = { text: "", sources: [], calls: [] };
    const rest = consumeSseChunk(
      'event: x\ndata: {"type":"response.output_text.delta","delta":"Hel"}\n\ndata: {"type":"response.output_item.added","item":{"type":"web_search_call","action":{"query":"qwen"}}}\n\npartial',
      (ev) => applySidecarStreamEvent(parsed, ev),
    );
    assert.equal(rest, "partial");
    assert.equal(parsed.text, "Hel");
    assert.deepEqual(parsed.calls, ["web_search: qwen"]);
  });

  it("splits CRLF-delimited SSE frames instead of gluing them", () => {
    const parsed = { text: "", sources: [], calls: [] };
    const rest = consumeSseChunk(
      'data: {"type":"response.output_text.delta","delta":"Hel"}\r\n\r\ndata: {"type":"response.output_text.delta","delta":"lo"}\r\n\r\npartial',
      (ev) => applySidecarStreamEvent(parsed, ev),
    );
    assert.equal(rest, "partial");
    assert.equal(parsed.text, "Hello");
  });

  it("uses a longer research timeout and search-first timeout hint", () => {
    assert.equal(sidecarTimeoutMs("research", {}), 480_000);
    assert.equal(sidecarTimeoutMs("search", {}), 180_000);
    assert.equal(sidecarTimeoutMs("search", { ALIBABA_SIDECAR_TIMEOUT_MS: "12000" }), 12_000);
    assert.match(sidecarTimeoutMessage("research", 480_000, false), /action=search/);
    assert.match(formatSidecarProgress("search", 4000, { text: "", sources: [], calls: [] }), /4s/);
  });
});

describe("postSidecar abort", () => {
  it("fails immediately when the input signal is already aborted", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }
      return await new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }) as typeof fetch;
    try {
      const ac = new AbortController();
      ac.abort();
      await assert.rejects(
        () => postSidecar(
          "dashscope-intl.aliyuncs.com",
          "sk-test",
          { url: "/responses", body: {}, timeoutMs: 200, action: "search" },
          ac.signal,
        ),
        /DashScope sidecar aborted/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
