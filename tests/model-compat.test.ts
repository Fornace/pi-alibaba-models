import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyAuthorizedFilter,
  buildCloudModels,
  buildPlanModels,
  chatRows,
  catalogFresh,
  countFallbackModels,
  formatQuota,
  hostVersionSupported,
  imageRows,
  inferAnthropicMaxTokens,
  isReasoningModel,
  isVisionModel,
  modelCachesPrompt,
  ownedRows,
  parseCatalogCache,
  resolveCloudApi,
  supportsCloudResponses,
  thinkingConfigFor,
} from "../extensions/alibaba.ts";
import { resolveWarmSettings } from "../extensions/cache-warm.ts";
import type { CatalogPrices } from "../extensions/prices.ts";

const reasoningQwen = {
  id: "qwen3.7-max",
  name: "Qwen 3.7 Max",
  reasoning: true,
  input: ["text" as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_048_576,
  maxTokens: 32_768,
  compat: { thinkingFormat: "qwen" as const },
};

const nonReasoning = {
  ...reasoningQwen,
  id: "qwen-turbo",
  name: "Qwen Turbo",
  reasoning: false,
  compat: undefined,
};

const ANTHROPIC_LEVELS = {
  off: "off",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

function compatFlags(model: { compat?: object }) {
  return (model.compat ?? {}) as {
    supportsDeveloperRole?: boolean;
    supportsStore?: boolean;
    supportsReasoningEffort?: boolean;
    thinkingFormat?: string;
  };
}

describe("thinkingLevelMap", () => {
  it("exposes every level on the Anthropic path, with a string `off`", () => {
    // `off` must not be null: pi clamps an unsupported level *upward*, so a
    // null `off` silently upgraded "thinking off" into a real thinking budget.
    const [plan] = buildPlanModels(
      [{ ...reasoningQwen, openaiOnly: false }],
      "https://plan.example/openai",
      "https://plan.example/anthropic",
    );
    const [cloud] = buildCloudModels([reasoningQwen], { domain: "dashscope.example", fmt: "anthropic-messages" });

    assert.deepEqual(plan.thinkingLevelMap, ANTHROPIC_LEVELS);
    assert.deepEqual(cloud.thinkingLevelMap, ANTHROPIC_LEVELS);
    assert.equal(plan.thinkingLevelMap?.off, "off");
  });

  it("leaves non-reasoning models without a thinking map", () => {
    const [plan] = buildPlanModels(
      [{ ...nonReasoning, openaiOnly: false }],
      "https://plan.example/openai",
      "https://plan.example/anthropic",
    );
    const [cloud] = buildCloudModels([nonReasoning], { domain: "dashscope.example", fmt: "anthropic-messages" });

    assert.equal(plan.thinkingLevelMap, undefined);
    assert.equal(cloud.thinkingLevelMap, undefined);
  });
});

describe("isReasoningModel", () => {
  it("does not flag kimi — DashScope rejects thinking_budget for those ids", () => {
    assert.equal(isReasoningModel("kimi-k3"), false);
    assert.equal(isReasoningModel("kimi-k2.7-code"), false);
    assert.equal(isReasoningModel("kimi-k2.5"), false);
  });

  it("still flags qwen max, glm, deepseek, and minimax as reasoning", () => {
    assert.equal(isReasoningModel("qwen3.7-max"), true);
    assert.equal(isReasoningModel("qwen3.7-plus"), true);
    assert.equal(isReasoningModel("glm-5.2"), true);
    assert.equal(isReasoningModel("deepseek-v4-pro"), true);
    assert.equal(isReasoningModel("deepseek-v4-flash"), true);
    assert.equal(isReasoningModel("minimax-m2.5"), true);
  });

  it("flags Qwen plus/flash and the open-weight qwen3-<size>b line", () => {
    assert.equal(isReasoningModel("qwen-plus"), true);
    assert.equal(isReasoningModel("qwen-flash"), true);
    assert.equal(isReasoningModel("qwen3-30b-a3b"), true);
  });

  it("does not flag qwen-turbo, which accepts no thinking controls", () => {
    assert.equal(isReasoningModel("qwen-turbo"), false);
  });

  it("does not flag the -character roleplay variants", () => {
    assert.equal(isReasoningModel("qwen-plus-character"), false);
    assert.equal(isReasoningModel("qwen-flash-character"), false);
    assert.equal(isReasoningModel("qwen3-max-character"), false);
  });

  it("flags qwen3-coder/next via the family table (the heuristic missed them)", () => {
    assert.equal(isReasoningModel("qwen3-coder-plus"), true);
    assert.equal(isReasoningModel("qwen3-next"), true);
  });
});

describe("supportsDeveloperRole", () => {
  it("disables the developer role only on the OpenAI-compat path", () => {
    const [planAnthropic, planOpenAI] = buildPlanModels(
      [
        { ...reasoningQwen, id: "qwen3.7-max", openaiOnly: false },
        { ...reasoningQwen, id: "deepseek-v4", openaiOnly: true },
      ],
      "https://plan.example/openai",
      "https://plan.example/anthropic",
    );

    assert.equal(planAnthropic.api, "anthropic-messages");
    assert.equal(compatFlags(planAnthropic).supportsDeveloperRole, undefined);
    assert.equal(compatFlags(planAnthropic).thinkingFormat, "qwen");

    assert.equal(planOpenAI.api, "openai-completions");
    assert.equal(compatFlags(planOpenAI).supportsDeveloperRole, false);
    assert.equal(compatFlags(planOpenAI).thinkingFormat, "qwen");

    const [cloudAnthropic] = buildCloudModels([reasoningQwen], { domain: "dashscope.example", fmt: "anthropic-messages" });
    const [cloudOpenAI] = buildCloudModels([reasoningQwen], { domain: "dashscope.example", fmt: "openai-completions" });

    assert.equal(cloudAnthropic.api, "anthropic-messages");
    assert.equal(compatFlags(cloudAnthropic).supportsDeveloperRole, undefined);
    assert.equal(cloudOpenAI.api, "openai-completions");
    assert.equal(compatFlags(cloudOpenAI).supportsDeveloperRole, false);
    assert.equal(compatFlags(cloudOpenAI).supportsStore, false);
    assert.equal(compatFlags(cloudAnthropic).supportsStore, undefined);
  });
});

describe("openai-responses", () => {
  it("routes Cloud models to compatible-mode/v1 with api openai-responses", () => {
    const [cloud] = buildCloudModels([reasoningQwen], { domain: "dashscope.example", fmt: "openai-responses" });
    assert.equal(cloud.api, "openai-responses");
    assert.equal(cloud.baseUrl, "https://dashscope.example/compatible-mode/v1");
    assert.equal(compatFlags(cloud).supportsDeveloperRole, false);
    assert.equal(compatFlags(cloud).supportsStore, false);
    // Derived from the family's Completions map — qwen3.7-max rejects `max`.
    assert.deepEqual(cloud.thinkingLevelMap, {
      off: "none",
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: null,
    });
  });

  it("keeps DeepSeek on Chat Completions when the Cloud format is Anthropic", () => {
    const deepseek = { ...reasoningQwen, id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" };
    const [anthropicFmt] = buildCloudModels([deepseek], { domain: "dashscope.example", fmt: "anthropic-messages" });
    const [responsesFmt] = buildCloudModels([deepseek], { domain: "dashscope.example", fmt: "openai-responses" });
    assert.equal(anthropicFmt.api, "openai-completions");
    assert.equal(responsesFmt.api, "openai-responses");
  });

  it("falls back to Chat Completions for models the Responses endpoint rejects", () => {
    // Measured against the live endpoint: these ids answer `Agent
    // capabilities are not enabled` on /responses even though they work on
    // /chat/completions, so exposing them on Responses would only 400.
    assert.equal(supportsCloudResponses("kimi-k2.6"), false);
    assert.equal(supportsCloudResponses("glm-5.1"), false);
    assert.equal(supportsCloudResponses("MiniMax-M2.5"), false);
    assert.equal(supportsCloudResponses("qwen-max"), false);

    assert.equal(resolveCloudApi("kimi-k2.6", "openai-responses"), "openai-completions");
    assert.equal(resolveCloudApi("qwen3.8-max", "openai-responses"), "openai-responses");
    assert.equal(resolveCloudApi("kimi-k3", "openai-responses"), "openai-responses");
    // The Anthropic format still only re-routes DeepSeek.
    assert.equal(resolveCloudApi("kimi-k2.6", "anthropic-messages"), "anthropic-messages");
  });
});

describe("thinkingConfigFor", () => {
  it("keeps `off` sendable on the Anthropic path", () => {
    // pi clamps an unsupported level *upward*, so `off: null` would silently
    // turn "thinking off" into a real budget instead of sending
    // `thinking: {type: "disabled"}`.
    const cfg = thinkingConfigFor("qwen3.8-max", "anthropic-messages");
    assert.equal(cfg?.thinkingLevelMap.off, "off");
    assert.equal(cfg?.compat.thinkingFormat, "qwen");
    assert.equal(cfg?.compat.supportsReasoningEffort, undefined);
  });

  it("hides `off` on the Anthropic path for families that cannot disable thinking", () => {
    // MiniMax-M2.5 rejects `thinking: {type: "disabled"}` with
    // `400 … The value of the enable_thinking parameter is restricted to True`.
    // Its Completions row already has no `off`, so the Anthropic map inherits
    // that and pi clamps `--thinking off` up to a real effort.
    const mini = thinkingConfigFor("MiniMax-M2.5", "anthropic-messages");
    assert.equal(mini?.thinkingLevelMap.off, null);
    // Families that *can* switch off keep the sendable literal.
    assert.equal(thinkingConfigFor("glm-5", "anthropic-messages")?.thinkingLevelMap.off, "off");
  });

  it("hides the levels Chat Completions cannot express per family", () => {
    const glm53 = thinkingConfigFor("glm-5.3", "openai-completions");
    // Only low/high/max are distinct — the docs coerce medium to high and
    // xhigh to max — so the coerced levels are hidden and pi clamps onto the
    // very same values.
    assert.deepEqual(glm53?.thinkingLevelMap, {
      off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max",
    });
    // Everything above `medium` is rejected on qwen3.6-plus.
    const qwen36 = thinkingConfigFor("qwen3.6-plus", "openai-completions");
    assert.equal(qwen36?.thinkingLevelMap.max, null);
    assert.equal(qwen36?.thinkingLevelMap.high, "high");
  });

  it("does not advertise reasoning_effort for GLM-4.5", () => {
    // GLM-4.5 rejects `reasoning_effort` outright, so pi must not send it.
    const cfg = thinkingConfigFor("glm-4.5", "openai-completions");
    assert.equal(cfg?.compat.supportsReasoningEffort, undefined);
  });

  it("returns undefined for non-reasoning ids", () => {
    assert.equal(thinkingConfigFor("qwen-turbo", "anthropic-messages"), undefined);
    assert.equal(thinkingConfigFor("qwen-turbo", "openai-completions"), undefined);
  });
});

describe("maxTokens vs API shape", () => {
  it("uses the per-model catalog ceiling on the Anthropic path", () => {
    // The endpoint rejects `max_tokens` above the model's own limit
    // (`Range of max_tokens should be [1, N]`), and the catalog reports N per
    // model, so that value is authoritative — never an id-based guess.
    const plus = { ...reasoningQwen, id: "qwen-plus", maxTokens: 32_768 };
    const coder = { ...reasoningQwen, id: "qwen3-coder-plus", maxTokens: 65_536 };
    const [cloud] = buildCloudModels([plus], { domain: "dashscope.example", fmt: "anthropic-messages" });
    const [cloudCoder] = buildCloudModels([coder], { domain: "dashscope.example", fmt: "anthropic-messages" });
    assert.equal(cloud.maxTokens, 32_768);
    assert.equal(cloudCoder.maxTokens, 65_536);
  });

  it("falls back to a conservative ceiling when the catalog has no row", () => {
    assert.equal(inferAnthropicMaxTokens("qwen3.7-max"), 32_768);
    assert.equal(inferAnthropicMaxTokens("qwen-turbo"), 8_192);
    // The open-weight qwen3-<size>b line is measured at 8192.
    assert.equal(inferAnthropicMaxTokens("qwen3-30b-a3b"), 8_192);
    // 0 is how producers mark "the catalog has no row".
    assert.equal(inferAnthropicMaxTokens("qwen3.7-max", 0), 32_768);
  });

  it("never lets an id-based guess masquerade as a catalog row", () => {
    // OpenAI-path guesses (glm-5.1 128000, kimi-k3 1048576) must not leak
    // onto the Anthropic path — DashScope rejects overshoots outright with
    // `Range of max_tokens should be [1, N]`. (deepseek is force-routed to
    // Completions anyway; glm-5.1 and kimi-k3 stay on the Anthropic path.)
    const [glm51] = buildCloudModels([{ ...reasoningQwen, id: "glm-5.1", maxTokens: 0 }], { domain: "dashscope.example", fmt: "anthropic-messages" });
    assert.equal(glm51.maxTokens, 32_768);
    const [kimi] = buildCloudModels([{ ...nonReasoning, id: "kimi-k3", maxTokens: 0 }], { domain: "dashscope.example", fmt: "anthropic-messages" });
    assert.equal(kimi.maxTokens, 8_192);
  });

  it("honors a catalog row on the Plan path as well", () => {
    const def = {
      id: "qwen3-coder-plus",
      name: "Qwen 3 Coder Plus",
      reasoning: true,
      input: ["text" as const],
      contextWindow: 262_144,
    };
    const [withCatalog] = buildPlanModels(
      [{ ...def, catalogMaxTokens: 65_536 }],
      "https://plan.example/openai",
      "https://plan.example/anthropic",
    );
    assert.equal(withCatalog.maxTokens, 65_536);
    const [fallback] = buildPlanModels([def], "https://plan.example/openai", "https://plan.example/anthropic");
    assert.equal(fallback.maxTokens, 32_768);
  });

  it("keeps catalog maxTokens on OpenAI Completions and Responses", () => {
    const fat = { ...reasoningQwen, maxTokens: 131_072 };
    const [completions] = buildCloudModels([fat], { domain: "dashscope.example", fmt: "openai-completions" });
    const [responses] = buildCloudModels([fat], { domain: "dashscope.example", fmt: "openai-responses" });
    assert.equal(completions.maxTokens, 131_072);
    assert.equal(responses.maxTokens, 131_072);
  });
});

describe("per-family capability table", () => {
  it("splits DeepSeek v4-pro/flash from v4.1 (distinct efforts differ)", () => {
    // deepseek-v4-pro/flash: only high/max are distinct (the docs coerce
    // low/medium to high and xhigh to max); v4.1 adds low and an off switch.
    assert.deepEqual(thinkingConfigFor("deepseek-v4-pro", "openai-completions")?.thinkingLevelMap, {
      off: null, minimal: null, low: null, medium: null, high: "high", xhigh: null, max: "max",
    });
    assert.deepEqual(thinkingConfigFor("deepseek-v4.1-flash", "openai-completions")?.thinkingLevelMap, {
      off: "none", minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max",
    });
  });

  it("drops `max` for glm-5.1/glm-5, which reject it", () => {
    assert.equal(thinkingConfigFor("glm-5.1", "openai-completions")?.thinkingLevelMap.max, null);
    assert.equal(thinkingConfigFor("glm-5", "openai-completions")?.thinkingLevelMap.off, "none");
    assert.equal(thinkingConfigFor("glm-5.2", "openai-completions")?.thinkingLevelMap.max, "max");
  });

  it("derives Responses efforts from the family's Completions map", () => {
    // Docs: Responses accepts the same subset per family, with `off` as the
    // literal effort "none" wherever thinking can be disabled at all.
    assert.deepEqual(thinkingConfigFor("deepseek-v4-pro", "openai-responses")?.thinkingLevelMap, {
      off: null, minimal: null, low: null, medium: null, high: "high", xhigh: null, max: "max",
    });
    assert.equal(thinkingConfigFor("deepseek-v4.1-flash", "openai-responses")?.thinkingLevelMap.off, "none");
    // Measured narrower on Responses: qwen3.5–3.7 cap at medium.
    const qwen36 = thinkingConfigFor("qwen3.6-plus", "openai-responses");
    assert.equal(qwen36?.thinkingLevelMap.medium, "medium");
    assert.equal(qwen36?.thinkingLevelMap.high, null);
  });
});

describe("prompt caching + DashScope session cache", () => {
  it("leaves promptCache undeclared while this extension owns warming", () => {
    // `promptCache` is the only field pi's cache warmer reads, so declaring it
    // in the default (extension) mode would run two engines against the same
    // block. The engine's own schedule comes from config, not from the card.
    const [cloud] = buildCloudModels([reasoningQwen], { domain: "dashscope.example", fmt: "anthropic-messages" });
    assert.equal(cloud.promptCache, undefined);
  });

  it("declares the TTL that reproduces the refresh interval in mode pi", () => {
    // pi schedules at min(0.9·ttl, ttl − 10s), so a 270 s refresh is declared
    // as 300 s — the measured DashScope lifetime.
    const warm = { ...resolveWarmSettings({}), mode: "pi" as const, refreshSeconds: 270 };
    const [cloud] = buildCloudModels([reasoningQwen], { domain: "dashscope.example", fmt: "anthropic-messages", warm });
    assert.deepEqual(cloud.promptCache, { short: 300 });
  });

  it("leaves the Plan provider on pi's warmer", () => {
    // The warm engine replays Cloud requests only (its schedule comes from
    // DashScope's measured TTL and its transport from the Cloud key), so Plan
    // cards keep the declaration that makes pi's warmer eligible.
    const [plan] = buildPlanModels(
      [{ ...reasoningQwen, openaiOnly: false }],
      "https://plan.example/openai",
      "https://plan.example/anthropic",
    );
    assert.deepEqual(plan.promptCache, { short: 300 });
    // The Responses input guard is a Cloud Responses fact, not a Plan one.
    assert.equal(plan.contextWindow, reasoningQwen.contextWindow);
  });

  it("declares nothing for the open-weight qwen3-b line (no documented caching)", () => {
    const openWeight = { ...reasoningQwen, id: "qwen3-30b-a3b", maxTokens: 0 };
    const warm = { ...resolveWarmSettings({}), mode: "pi" as const };
    const [cloud] = buildCloudModels([openWeight], { domain: "dashscope.example", fmt: "anthropic-messages", warm });
    assert.equal(cloud.promptCache, undefined);
  });

  it("opts Responses requests into DashScope session cache — and only those", () => {
    // Session cache gives predictable multi-turn prefix hits (5-min window
    // renewed on hit, reads ~10% vs the implicit cache's 20–25%) and is
    // opt-in per request; the docs cover the Responses endpoint only.
    const [responses] = buildCloudModels([reasoningQwen], { domain: "dashscope.example", fmt: "openai-responses" });
    assert.deepEqual((responses as { headers?: Record<string, string> }).headers, {
      "x-dashscope-session-cache": "enable",
    });
    const [completions] = buildCloudModels([reasoningQwen], { domain: "dashscope.example", fmt: "openai-completions" });
    assert.equal((completions as { headers?: Record<string, string> }).headers, undefined);
    const [anthropic] = buildCloudModels([reasoningQwen], { domain: "dashscope.example", fmt: "anthropic-messages" });
    assert.equal((anthropic as { headers?: Record<string, string> }).headers, undefined);
  });
});

describe("declared cost and the Responses input guard", () => {
  const PRICES: CatalogPrices = {
    input: 12, output: 36, implicitRead: 1.5, explicitRead: 1, explicitWrite: 15,
    explicitCache: true, tier: "Default", tiered: false, thinkingOutput: false,
  };
  const IMPLICIT_ONLY: CatalogPrices = { ...PRICES, explicitRead: 0, explicitWrite: 0, explicitCache: false };
  const card = { ...reasoningQwen, id: "qwen3.8-max-0902", contextWindow: 1_000_000 };
  const build = (fmt: string, extra: Record<string, unknown> = {}) =>
    buildCloudModels([card], {
      domain: "dashscope.example", fmt,
      catalog: new Map([["qwen3.8-max-0902", { prices: extra.implicit ? IMPLICIT_ONLY : PRICES }]]),
      ...extra,
    })[0];

  it("declares the explicit pair while the session cache is on, the implicit pair without it", () => {
    assert.deepEqual(build("openai-responses").cost, { input: 12, output: 36, cacheRead: 1, cacheWrite: 15 });
    assert.deepEqual(build("openai-responses", { sessionCache: false }).cost,
      { input: 12, output: 36, cacheRead: 1.5, cacheWrite: 0 });
  });

  it("follows the wire on the other two shapes", () => {
    // Completions has no header: markers decide, and they are on by default.
    assert.deepEqual(build("openai-completions").cost, { input: 12, output: 36, cacheRead: 1, cacheWrite: 15 });
    assert.deepEqual(build("openai-completions", { cacheControl: false }).cost,
      { input: 12, output: 36, cacheRead: 1.5, cacheWrite: 0 });
    // pi-ai injects cache_control itself on the Anthropic shape.
    assert.deepEqual(build("anthropic-messages").cost, { input: 12, output: 36, cacheRead: 1, cacheWrite: 15 });
  });

  it("never declares an explicit write for a family without explicit rows", () => {
    assert.deepEqual(build("openai-responses", { implicit: true }).cost,
      { input: 12, output: 36, cacheRead: 1.5, cacheWrite: 0 });
  });

  it("converts to USD on request and keeps CNY by default", () => {
    assert.deepEqual(build("openai-responses", { currency: "usd", cnyPerUsd: 6 }).cost,
      { input: 2, output: 6, cacheRead: 1 / 6, cacheWrite: 2.5 });
    assert.deepEqual(build("openai-responses", { currency: "cny" }).cost.input, 12);
  });

  it("keeps a stored cost when the catalog has no rows for the id", () => {
    const kept = buildCloudModels([{ ...card, cost: { input: 7, output: 8, cacheRead: 0, cacheWrite: 0 } }],
      { domain: "dashscope.example", fmt: "openai-responses", catalog: new Map() })[0];
    assert.deepEqual(kept.cost, { input: 7, output: 8, cacheRead: 0, cacheWrite: 0 });
  });

  it("declares the measured input cap, per shape", () => {
    // qwen3.8-max-0902 was probed at 792,945 on Responses (silent truncation
    // above it) and 983,616 on the request shapes (a 400 above it) - neither is
    // the catalog's 1,000,000 window.
    assert.equal(build("openai-responses").contextWindow, 792_945);
    assert.equal(build("openai-completions").contextWindow, 983_616);
    assert.equal(build("anthropic-messages").contextWindow, 983_616);
    // The guard is the kill switch: full window, and the endpoint's truncation.
    assert.equal(build("openai-responses", { responsesInputGuard: false }).contextWindow, 983_616);
  });

  it("never declares more than the catalog window, even where the cap is larger", () => {
    // glm-5.3 accepts 1,048,576 input tokens against a 1,000,000 window.
    const [glm] = buildCloudModels([{ ...card, id: "glm-5.3", contextWindow: 1_000_000 }],
      { domain: "dashscope.example", fmt: "openai-completions", catalog: new Map() });
    assert.equal(glm.contextWindow, 1_000_000);
  });

  it("lets a context-window override win outright", () => {
    const [c] = buildCloudModels([card], {
      domain: "dashscope.example", fmt: "openai-responses", catalog: new Map(),
      overrides: { "qwen3.8-max-0902": 500_000 },
    });
    assert.equal(c.contextWindow, 500_000);
  });
});

describe("modelCachesPrompt", () => {
  const prices = (over: Partial<CatalogPrices>): CatalogPrices => ({
    input: 1, output: 2, implicitRead: 0, explicitRead: 0, explicitWrite: 0,
    explicitCache: false, tiered: false, thinkingOutput: false, ...over,
  });

  it("falls back to the family table when the catalog carried no rows", () => {
    assert.equal(modelCachesPrompt("qwen3.8-max-0902"), true);
    assert.equal(modelCachesPrompt("glm-5.3"), true);
    assert.equal(modelCachesPrompt("kimi-k3"), true);
    // The open-weight qwen3-<size>b line has no documented caching, and an
    // unknown family is not assumed to have one either: warming either would
    // spend quota to keep alive a block that is never created.
    assert.equal(modelCachesPrompt("qwen3-30b-a3b"), false);
    assert.equal(modelCachesPrompt("brand-new-family-9"), false);
  });

  it("trusts the catalog rows over the family table", () => {
    const catalog = new Map<string, { prices: CatalogPrices }>([
      ["explicit-only", { prices: prices({ explicitCache: true, explicitRead: 1, explicitWrite: 15 }) }],
      ["implicit-only", { prices: prices({ implicitRead: 1.5 }) }],
      ["no-cache-rows", { prices: prices({}) }],
    ]);
    assert.equal(modelCachesPrompt("explicit-only", catalog), true);
    assert.equal(modelCachesPrompt("implicit-only", catalog), true);
    assert.equal(modelCachesPrompt("no-cache-rows", catalog), false);
    // A model the rows know nothing about still falls back to the family table.
    assert.equal(modelCachesPrompt("glm-5.3", catalog), true);
  });
});

describe("catalog fetch freshness gate (many pi instances, one agent dir)", () => {
  it("lets one instance fetch per window and the rest skip", () => {
    const NOW = 1_800_000_000_000;
    const WINDOW_MS = 10 * 60 * 1000;
    assert.equal(catalogFresh(NOW, NOW), true);
    assert.equal(catalogFresh(NOW - WINDOW_MS + 1000, NOW), true);
    assert.equal(catalogFresh(NOW - WINDOW_MS, NOW), false);
    assert.equal(catalogFresh(undefined, NOW), false);
    assert.equal(catalogFresh(NaN, NOW), false);
  });
});

describe("private catalog snapshot (plan C: independent of pi's store)", () => {
  it("accepts only the current snapshot version", () => {
    // The 1.4.5 lesson, enforced in code: an old or foreign format must never
    // pose as catalog data.
    assert.equal(parseCatalogCache(null), null);
    assert.equal(parseCatalogCache("nope"), null);
    assert.equal(parseCatalogCache({ v: 1, cloud: { fetchedAt: 1, models: [{ id: "x" }] } }), null);
    const ok = { v: 2 as const, cloud: { fetchedAt: 1, models: [] } };
    assert.deepEqual(parseCatalogCache(ok), ok);
  });
});

describe("isVisionModel", () => {
  it("flags VL, Qwen 3.x Plus, Qwen 3.8, and Kimi", () => {
    assert.equal(isVisionModel("qwen-vl-max"), true);
    assert.equal(isVisionModel("qwen3.7-plus"), true);
    assert.equal(isVisionModel("qwen3.8-max"), true);
    assert.equal(isVisionModel("kimi-k2.7-code"), true);
    assert.equal(isVisionModel("qwen3.7-max"), false);
  });
});

describe("native catalog helpers", () => {
  it("intersects the catalog with authorized inference models, and keeps the full list if empty", () => {
    const models = [{ id: "qwen3.8-max" }, { id: "glm-5.2" }, { id: "secret-model" }];
    const filtered = applyAuthorizedFilter(models, new Set(["qwen3.8-max", "glm-5.2"]));
    assert.equal(filtered.authorizedOnly, true);
    assert.deepEqual(filtered.models.map((m) => m.id), ["qwen3.8-max", "glm-5.2"]);

    const empty = applyAuthorizedFilter(models, new Set(["nope"]));
    assert.equal(empty.authorizedOnly, false);
    assert.equal(empty.models.length, 3);

    const missing = applyAuthorizedFilter(models, null);
    assert.equal(missing.authorizedOnly, false);
    assert.equal(missing.models, models);
  });

  it("formats QPS and per-period usage quotas", () => {
    assert.equal(
      formatQuota({
        model: "qwen3.8-max",
        modelLimit: { request_limit: 10, request_limit_period: 1, usage_limit: 1_000_000, usage_limit_field: "tokens", usage_limit_period: 60 },
        hasWorkspaceLimit: true,
      }),
      "10 req/s; 1,000,000 tokens/per-60s; workspace-limit set",
    );
  });
});

describe("1.5.0: Responses is the default Cloud format", () => {
  const def = (id: string) => ({
    id,
    name: id,
    description: "",
    contextWindow: 0,
    maxTokens: 0,
    input: ["text"],
  }) as any;

  it("buildCloudModels defaults to openai-responses with the session-cache header", () => {
    const [card] = buildCloudModels([def("qwen3.7-plus")], { domain: "dashscope-intl.aliyuncs.com", fmt: "" });
    assert.equal(card.api, "openai-responses");
    assert.deepEqual(card.headers, { "x-dashscope-session-cache": "enable" });
  });

  it("cloudSessionCache=false strips the header (one-shot-heavy usage)", () => {
    const [card] = buildCloudModels([def("qwen3.7-plus")], { domain: "dashscope-intl.aliyuncs.com", fmt: "", sessionCache: false });
    assert.equal(card.headers, undefined);
  });

  it("session cache stays off non-Responses routes", () => {
    const [card] = buildCloudModels([def("kimi-k2.6")], { domain: "dashscope-intl.aliyuncs.com", fmt: "openai-responses" });
    assert.equal(card.api, "openai-completions"); // no Responses support -> fallback
    assert.equal(card.headers, undefined);
  });

  it("countFallbackModels surfaces silent per-model fallbacks", () => {
    assert.equal(countFallbackModels([def("qwen3.7-plus"), def("kimi-k2.6")], "openai-responses"), 1);
    assert.equal(countFallbackModels([def("qwen3.7-plus"), def("kimi-k2.6")], "openai-completions"), 0);
    assert.equal(countFallbackModels([def("deepseek-v4-pro")], "anthropic-messages"), 1);
  });
});

describe("host floor (ADR-0001)", () => {
  it("accepts pi 1.0.0 and newer, rejects the pre-1.0.0 host", () => {
    assert.equal(hostVersionSupported("1.0.0"), true);
    assert.equal(hostVersionSupported("1.5.3"), true);
    assert.equal(hostVersionSupported("2.4.1"), true);
    assert.equal(hostVersionSupported("0.87.0"), false);
  });

  it("does not block on an unknown or unparseable version", () => {
    assert.equal(hostVersionSupported(undefined), true);
    assert.equal(hostVersionSupported(""), true);
    assert.equal(hostVersionSupported("dev"), true);
  });
});

describe("ownedRows — the Cloud provider owns chat and image rows, not classifiers", () => {
  // pi 1.0.0 widened ModelsStoreEntry.models to `readonly AnyModel[]`, so the
  // offline re-serve can be handed an image or classifier row. The provider
  // registers chat *and* image models, so both are kept; a classifier row has
  // no implementation here and would register as a model that cannot run. An
  // absent `type` means chat — pi's own rule — so it is kept, which is also
  // what a pre-1.0.0 snapshot looks like.
  const row = (id: string, type?: string) => ({ id, ...(type ? { type } : {}) });

  it("keeps chat rows, rows without a type, and image rows", () => {
    assert.deepEqual(
      ownedRows([row("qwen3.7-max", "chat"), row("qwen-plus"), row("qwen-image-plus", "image")]).map((r) => r.id),
      ["qwen3.7-max", "qwen-plus", "qwen-image-plus"],
    );
  });

  it("drops classifier rows", () => {
    assert.deepEqual(
      ownedRows([row("qwen-plus"), row("qwen-image", "image"), row("jev-latest", "classifier")]).map((r) => r.id),
      ["qwen-plus", "qwen-image"],
    );
  });

  it("treats a missing snapshot as empty", () => {
    assert.deepEqual(ownedRows(undefined), []);
  });
});

describe("chatRows / imageRows — the Sidecar picker must stay chat-only", () => {
  const row = (id: string, type?: string) => ({ id, ...(type ? { type } : {}) });

  it("keeps chat rows and rows without a type", () => {
    assert.deepEqual(chatRows([row("qwen3.7-max", "chat"), row("qwen-plus")]).map((r) => r.id),
      ["qwen3.7-max", "qwen-plus"]);
  });

  it("drops image and classifier rows from the chat-only view", () => {
    assert.deepEqual(
      chatRows([row("qwen-plus"), row("qwen-image", "image"), row("jev-latest", "classifier")]).map((r) => r.id),
      ["qwen-plus"]);
    assert.deepEqual(chatRows(undefined), []);
  });

  it("keeps only image rows for the image builder", () => {
    assert.deepEqual(
      imageRows([row("qwen-plus"), row("qwen-image", "image"), row("qwen3.7-max", "chat")]).map((r) => r.id),
      ["qwen-image"],
    );
    assert.deepEqual(imageRows(undefined), []);
  });
});
