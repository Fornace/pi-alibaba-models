import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCloudModels, buildPlanModels, isReasoningModel } from "../extensions/alibaba.ts";

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
  return (model.compat ?? {}) as { supportsDeveloperRole?: boolean; thinkingFormat?: string };
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
  });
});
