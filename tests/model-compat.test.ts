import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyAuthorizedFilter,
  buildCloudModels,
  buildPlanModels,
  formatQuota,
  inferAnthropicMaxTokens,
  isReasoningModel,
  isVisionModel,
  parseApiV1Prices,
} from "../extensions/alibaba.ts";

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
  id: "qwen-plus",
  name: "Qwen Plus",
  reasoning: false,
  compat: undefined,
};

const EXPECTED_REASONING_MAP = {
  off: null,
  minimal: null,
  low: null,
  medium: null,
  high: "high",
  xhigh: null,
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
  it("opts reasoning models into high and max without aliasing unused levels", () => {
    const [plan] = buildPlanModels(
      [{ ...reasoningQwen, openaiOnly: false }],
      "https://plan.example/openai",
      "https://plan.example/anthropic",
    );
    const [cloud] = buildCloudModels([reasoningQwen], "dashscope.example", "anthropic-messages");

    assert.deepEqual(plan.thinkingLevelMap, EXPECTED_REASONING_MAP);
    assert.deepEqual(cloud.thinkingLevelMap, EXPECTED_REASONING_MAP);
  });

  it("leaves non-reasoning models without a thinking map", () => {
    const [plan] = buildPlanModels(
      [{ ...nonReasoning, openaiOnly: false }],
      "https://plan.example/openai",
      "https://plan.example/anthropic",
    );
    const [cloud] = buildCloudModels([nonReasoning], "dashscope.example", "anthropic-messages");

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

  it("does not flag plain qwen-plus", () => {
    assert.equal(isReasoningModel("qwen-plus"), false);
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

    const [cloudAnthropic] = buildCloudModels([reasoningQwen], "dashscope.example", "anthropic-messages");
    const [cloudOpenAI] = buildCloudModels([reasoningQwen], "dashscope.example", "openai-completions");

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
    const [cloud] = buildCloudModels([reasoningQwen], "dashscope.example", "openai-responses");
    assert.equal(cloud.api, "openai-responses");
    assert.equal(cloud.baseUrl, "https://dashscope.example/compatible-mode/v1");
    assert.equal(compatFlags(cloud).supportsDeveloperRole, false);
    assert.equal(compatFlags(cloud).supportsStore, false);
    assert.deepEqual(cloud.thinkingLevelMap, {
      off: "none",
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    });
  });

  it("keeps DeepSeek on Chat Completions when the Cloud format is Anthropic", () => {
    const deepseek = { ...reasoningQwen, id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" };
    const [anthropicFmt] = buildCloudModels([deepseek], "dashscope.example", "anthropic-messages");
    const [responsesFmt] = buildCloudModels([deepseek], "dashscope.example", "openai-responses");
    assert.equal(anthropicFmt.api, "openai-completions");
    assert.equal(responsesFmt.api, "openai-responses");
  });
});

describe("maxTokens vs API shape", () => {
  it("clamps Anthropic reasoning models to the verified 32768 ceiling", () => {
    const fat = { ...reasoningQwen, maxTokens: 131_072 };
    const [cloud] = buildCloudModels([fat], "dashscope.example", "anthropic-messages");
    assert.equal(inferAnthropicMaxTokens("qwen3.7-max"), 32_768);
    assert.equal(cloud.maxTokens, 32_768);
  });

  it("keeps catalog maxTokens on OpenAI Completions and Responses", () => {
    const fat = { ...reasoningQwen, maxTokens: 131_072 };
    const [completions] = buildCloudModels([fat], "dashscope.example", "openai-completions");
    const [responses] = buildCloudModels([fat], "dashscope.example", "openai-responses");
    assert.equal(completions.maxTokens, 131_072);
    assert.equal(responses.maxTokens, 131_072);
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
  it("parses Default-range CNY-per-million prices", () => {
    assert.deepEqual(
      parseApiV1Prices([
        {
          range_name: "Default",
          prices: [
            { type: "input", price: "2.4", price_unit: "元/百万Tokens" },
            { type: "output", price: "9.6", price_unit: "元/百万Tokens" },
          ],
        },
      ]),
      { input: 2.4, output: 9.6 },
    );
  });

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
