import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizePlanBaseUrls } from "../extensions/alibaba.ts";

// The Plan provider moved off `token-plan.ap-southeast-1.maas.aliyuncs.com`
// when Alibaba reassigned that host to the separate, credits-billed Token Plan;
// Coding Plan now lives on coding-intl / coding.dashscope. A base URL recorded
// by an older install must be moved, while a deliberate custom URL (including
// someone pointing the provider at a Token Plan host on purpose) must survive.

const LEGACY_OPENAI = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";
const LEGACY_ANTHROPIC = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic";
const CURRENT_OPENAI = "https://coding-intl.dashscope.aliyuncs.com/v1";
const CURRENT_ANTHROPIC = "https://coding-intl.dashscope.aliyuncs.com/apps/anthropic";
const CHINA_OPENAI = "https://coding.dashscope.aliyuncs.com/v1";
const CHINA_ANTHROPIC = "https://coding.dashscope.aliyuncs.com/apps/anthropic";

describe("normalizePlanBaseUrls", () => {
  it("moves the retired host onto the current Coding Plan pair", () => {
    assert.deepEqual(normalizePlanBaseUrls(LEGACY_OPENAI, LEGACY_ANTHROPIC), {
      openai: CURRENT_OPENAI,
      anthropic: CURRENT_ANTHROPIC,
    });
  });

  it("leaves a custom pair (China) untouched", () => {
    assert.deepEqual(normalizePlanBaseUrls(CHINA_OPENAI, CHINA_ANTHROPIC), {
      openai: CHINA_OPENAI,
      anthropic: CHINA_ANTHROPIC,
    });
  });

  it("leaves a deliberate Token Plan pair untouched", () => {
    const tokenOpenAI = "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
    const tokenAnthropic = "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic";
    assert.deepEqual(normalizePlanBaseUrls(tokenOpenAI, tokenAnthropic), {
      openai: tokenOpenAI,
      anthropic: tokenAnthropic,
    });
  });

  it("normalizes only the legacy half of a mixed pair", () => {
    assert.deepEqual(normalizePlanBaseUrls(LEGACY_OPENAI, CHINA_ANTHROPIC), {
      openai: CURRENT_OPENAI,
      anthropic: CHINA_ANTHROPIC,
    });
  });

  it("is idempotent", () => {
    const once = normalizePlanBaseUrls(LEGACY_OPENAI, LEGACY_ANTHROPIC);
    assert.deepEqual(normalizePlanBaseUrls(once.openai, once.anthropic), once);
  });
});
