import { describe, expect, test } from "bun:test";
import { stream as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { convertMessages } from "@earendil-works/pi-ai/api/openai-completions";
import { buildCloudModels, buildPlanModels } from "../extensions/alibaba";

const ALIBABA_ROLE_ERROR = "developer is not one of ['system', 'assistant', 'user', 'tool', 'function']";
const baseModel = {
  id: "qwen3.7-max", name: "Qwen 3.7 Max", reasoning: true, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_048_576, maxTokens: 8_192,
  compat: { thinkingFormat: "qwen" },
};
const context = {
  systemPrompt: "FIRSTMATE_OPERATIONAL_INSTRUCTIONS",
  messages: [
    { role: "user", content: "USER_BEFORE_TOOL", timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "ASSISTANT_HANDOFF" }], api: "openai-completions", provider: "alibaba-cloud", model: "qwen3.7-max", timestamp: 2 },
    { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "lookup", arguments: { query: "x" } }], api: "openai-completions", provider: "alibaba-cloud", model: "qwen3.7-max", timestamp: 3 },
    { role: "toolResult", toolCallId: "call_1", toolName: "lookup", content: [{ type: "text", text: "TOOL_RESULT" }], isError: false, timestamp: 4 },
    { role: "user", content: "USER_AFTER_TOOL", timestamp: 5 },
  ],
  tools: [],
};

const wireMessages = (model: any) => convertMessages(model, context as any, { ...model.compat } as any);

async function captureAnthropicPayload(model: unknown) {
  let payload: unknown;
  const stream = anthropicStream(model as any, context as any, {
    client: { messages: { create: () => { throw new Error("unexpected live call"); } } },
    cacheRetention: "none",
    onPayload: (value: unknown) => {
      payload = value;
      throw new Error("capture payload");
    },
  } as any);
  await stream.result();
  return payload as { system?: unknown; messages: { role: string; content: unknown }[] };
}

async function postToAlibaba(messages: unknown[]) {
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = await request.json() as { messages?: { role?: string }[] };
      const invalid = body.messages?.find((message) => message.role === "developer");
      return invalid
        ? Response.json({ error: { message: ALIBABA_ROLE_ERROR } }, { status: 400 })
        : Response.json({ ok: true });
    },
  });
  try {
    const response = await fetch(server.url, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages }),
    });
    return { status: response.status, body: await response.json() as { error?: { message?: string } } };
  } finally { server.stop(); }
}

describe("Alibaba provider request roles", () => {
  test("reproduces Alibaba's developer rejection and maps operational input to system", async () => {
    const [model] = buildCloudModels([baseModel], "dashscope-intl.aliyuncs.com", "openai-completions");
    expect(model.api).toBe("openai-completions");
    expect(model.compat?.supportsDeveloperRole).toBe(false);

    const rejectedModel = { ...model, compat: { ...model.compat, supportsDeveloperRole: true } };
    const rejectedResponse = await postToAlibaba(wireMessages(rejectedModel));
    expect(rejectedResponse.status).toBe(400);
    expect(rejectedResponse.body.error?.message).toBe(ALIBABA_ROLE_ERROR);

    const accepted = wireMessages(model);
    expect((await postToAlibaba(accepted)).status).toBe(200);
    expect(accepted.map((message) => message.role)).toEqual(["system", "user", "assistant", "assistant", "tool", "user"]);
    expect(accepted[0]).toEqual({ role: "system", content: "FIRSTMATE_OPERATIONAL_INSTRUCTIONS" });
    expect(accepted.slice(1).every((message) => JSON.stringify(message).includes("FIRSTMATE_OPERATIONAL_INSTRUCTIONS"))).toBe(false);
  });

  test("preserves Anthropic system separation and role order from the built model", async () => {
    const [model] = buildCloudModels([baseModel], "dashscope.example", "anthropic-messages");
    const payload = await captureAnthropicPayload(model);

    expect(model.api).toBe("anthropic-messages");
    expect(model.baseUrl).toBe("https://dashscope.example/apps/anthropic");
    expect(payload.system).toEqual([{ type: "text", text: "FIRSTMATE_OPERATIONAL_INSTRUCTIONS" }]);
    expect(payload.messages.map((message) => message.role)).toEqual(["user", "assistant", "assistant", "user", "user"]);
    expect(payload.messages[3].content).toEqual([{
      type: "tool_result", tool_use_id: "call_1", content: "TOOL_RESULT", is_error: false,
    }]);
    expect(JSON.stringify(payload.messages)).not.toContain("FIRSTMATE_OPERATIONAL_INSTRUCTIONS");
  });

  test("sets the compatibility override on both Alibaba OpenAI shapes only", () => {
    const [planAnthropic, planOpenAI] = buildPlanModels(
      [{ ...baseModel, id: "qwen3.7-max", openaiOnly: false }, { ...baseModel, id: "deepseek-v4", openaiOnly: true }],
      "https://plan.example/openai", "https://plan.example/anthropic",
    );
    expect(planAnthropic.api).toBe("anthropic-messages");
    expect(planAnthropic.compat?.supportsDeveloperRole).toBeUndefined();
    expect(planOpenAI.api).toBe("openai-completions");
    expect(planOpenAI.compat?.supportsDeveloperRole).toBe(false);

    const [cloudAnthropic] = buildCloudModels([baseModel], "dashscope.example", "anthropic-messages");
    const [cloudOpenAI] = buildCloudModels([baseModel], "dashscope.example", "openai-completions");
    expect(cloudAnthropic.api).toBe("anthropic-messages");
    expect(cloudAnthropic.compat?.supportsDeveloperRole).toBeUndefined();
    expect(cloudOpenAI.api).toBe("openai-completions");
    expect(cloudOpenAI.compat?.supportsDeveloperRole).toBe(false);
  });
});
