import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { cloudKeyFingerprint } from "../extensions/alibaba.ts";

// Boots the real extension factory against a fake ExtensionAPI and reports what
// it registered: providers (chat vs image cards), each tool's exposure,
// namespace, annotations and outputSchema, and what the `before_agent_start`
// handler adds to the prompt sections. A second mode drives `alibaba_image`
// through a fake model registry to pin parameter mapping, structured content,
// `save` on/off, and error results.
//
// The fixture seeds the private catalog snapshot and the key fingerprint, so
// boot is fully offline (the non-routable domain is never contacted).

const EXT_PATH = pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "alibaba.ts")).href;

const CHILD = `
import fs from "node:fs";
const dir = process.env.PI_CODING_AGENT_DIR;
const providers = {}; const tools = {}; const commands = {}; const handlers = {};
const sent = []; const notified = []; const statuses = [];
const mod = await import(${JSON.stringify(EXT_PATH)});
await mod.default({
  registerProvider: (n, c) => { providers[n] = c; },
  registerTool: (t) => { tools[t.name] = t; },
  registerCommand: (n, c) => { commands[n] = c; },
  on: (ev, h) => { (handlers[ev] ??= []).push(h); },
  sendMessage: async (m) => { sent.push(m); },
});

if (process.env.MODE === "info") {
  const toolInfo = {};
  for (const [name, t] of Object.entries(tools)) {
    toolInfo[name] = {
      exposure: t.exposure,
      namespaceName: t.namespace?.name,
      namespaceDescription: Boolean(t.namespace?.description),
      namespaceInstructions: Boolean(t.namespace?.instructions),
      annotations: t.annotations,
      outputSchema: Boolean(t.outputSchema),
      outputSchemaRequired: t.outputSchema?.required ?? null,
      hasPromptSnippet: Boolean(t.promptSnippet),
    };
  }
  const providerInfo = {};
  for (const [name, p] of Object.entries(providers)) {
    providerInfo[name] = {
      types: (p.models || []).map((m) => m.type || "chat"),
      imageIds: (p.models || []).filter((m) => m.type === "image").map((m) => m.id),
      imageApis: Object.keys(p.images || {}),
      refresh: typeof p.refreshModels === "function",
    };
  }
  // pi 1.2.0: before_agent_start is a union — "user" events carry a prompt,
  // "custom" events (pi.sendMessage(..., { triggerTurn: true })) carry the
  // starting message and no prompt. Drive the handler with both shapes.
  const userEvent = { messageType: "user", prompt: "hi", systemPrompt: "", systemPromptOptions: { sections: {} } };
  const customEvent = { messageType: "custom", message: { role: "user", customType: "alibaba-image", content: [] }, systemPrompt: "", systemPromptOptions: { sections: {} } };
  for (const h of handlers.before_agent_start ?? []) {
    await h(userEvent, {});
    await h(customEvent, {});
  }
  process.stdout.write(JSON.stringify({
    tools: toolInfo,
    providers: providerInfo,
    section: userEvent.systemPromptOptions.sections.alibaba ?? null,
    sectionCount: Object.keys(userEvent.systemPromptOptions.sections).length,
    sectionCustom: customEvent.systemPromptOptions.sections.alibaba ?? null,
  }));
} else if (process.env.MODE.startsWith("command")) {
  const registryMode = process.env.REGISTRY_MODE || "ok";
  const fakeRegistry = {
    findOfType: (type, provider, id) => registryMode === "missing"
      ? undefined
      : { type: "image", api: "dashscope-images", provider, id, baseUrl: "https://dashscope.example/api/v1/services/aigc/multimodal-generation" },
    generateImages: async (model) => ({
      api: "dashscope-images", provider: "alibaba-cloud", model: model.id,
      output: [{ type: "image", data: "QUJD", mimeType: "image/png" }],
      stopReason: "stop", timestamp: 0,
    }),
  };
  const ctx = {
    signal: undefined,
    modelRegistry: fakeRegistry,
    reload: async () => {},
    ui: {
      select: async () => undefined,
      confirm: async () => true,
      input: async () => undefined,
      notify: (message, type) => { notified.push({ message, type }); },
      setStatus: (key, value) => { statuses.push({ key, value }); },
    },
  };
  const savePath = process.env.SAVE_PATH;
  await commands.alibaba.handler(process.env.CMD_ARGS, ctx);
  process.stdout.write(JSON.stringify({
    sent: sent.map((m) => ({
      customType: m.customType,
      contentTypes: m.content.map((c) => c.type),
      text: m.content.filter((c) => c.type === "text").map((c) => c.text).join(" "),
    })),
    notified,
    statusProgress: statuses.some((s) => typeof s.value === "string" && s.value.startsWith("Generating image")),
    statusCleared: statuses.some((s) => s.value === undefined),
    savedExists: savePath ? fs.existsSync(savePath) : false,
    savedBytes: savePath && fs.existsSync(savePath) ? fs.readFileSync(savePath).toString() : null,
  }));
} else if (process.env.MODE.startsWith("stream")) {
  const caseName = process.env.MODE;
  if (caseName === "stream-rate") {
    for (const h of handlers.provider_stream_event ?? []) await h({ provider: "alibaba-cloud", api: "openai-responses", model: "qwen3.7-plus", data: { type: "error", error: { code: "Throttling.RateQuota" } } }, {});
  } else if (caseName === "stream-backend") {
    for (const h of handlers.provider_stream_event ?? []) await h({ provider: "alibaba-cloud", api: "openai-responses", model: "qwen3.7-plus", data: { type: "server_error", message: "Backend buffer overflow." } }, {});
  } else if (caseName === "stream-invalid") {
    for (const h of handlers.provider_stream_event ?? []) await h({ provider: "alibaba-cloud", api: "openai-responses", model: "qwen3.7-plus", data: { type: "error", message: "InternalError.Algo.InvalidParameter: bad size" } }, {});
  }
  const message = { role: "assistant", stopReason: "error", provider: "alibaba-cloud", model: "qwen3.7-plus", errorMessage: "Generation stopped." };
  let rewritten = null;
  for (const h of handlers.message_end ?? []) {
    const res = await h({ message }, {});
    if (res?.message) rewritten = res.message.errorMessage;
  }
  process.stdout.write(JSON.stringify({ rewritten }));
} else {
  const savePath = process.env.SAVE_PATH;
  let capturedContext = null; let capturedOptions = null;
  const fakeCtx = {
    signal: undefined,
    modelRegistry: {
      findOfType: (type, provider, id) => ({ type: "image", api: "dashscope-images", provider, id, baseUrl: "https://dashscope.example/api/v1/services/aigc/multimodal-generation" }),
      generateImages: async (model, context, options) => {
        capturedContext = context; capturedOptions = options;
        if (process.env.MODE === "exec-error") {
          return { api: "dashscope-images", provider: "alibaba-cloud", model: model.id, output: [], stopReason: "error", errorMessage: "model rejected the size", timestamp: 0 };
        }
        return {
          api: "dashscope-images", provider: "alibaba-cloud", model: model.id,
          output: [{ type: "image", data: "QUJD", mimeType: "image/png" }],
          stopReason: "stop", timestamp: 0,
          usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
      },
    },
  };
  const params = {
    task: "a cat",
    size: "1024*1024",
    n: 2,
    seed: 7,
    negative_prompt: "blurry",
    watermark: false,
    prompt_extend: true,
    prompt_extend_mode: "direct",
    enable_thinking: false,
    ...(process.env.MODE === "exec-save" ? { save: savePath } : {}),
    ...(process.env.MODE === "exec-refuse" ? { images: ["a.png", "b.png", "c.png", "d.png"] } : {}),
    ...(process.env.MODE === "exec-editor" ? { model: "qwen-image-edit-plus" } : {}),
    ...(process.env.MODE === "exec-hybrid" ? { model: "qwen-image-3.0" } : {}),
  };
  let output;
  try {
    const result = await tools.alibaba_image.execute("call-1", params, undefined, undefined, fakeCtx);
    output = {
      isError: Boolean(result.isError),
      contentTypes: result.content.map((c) => c.type),
      text: result.content.filter((c) => c.type === "text").map((c) => c.text).join(" "),
      structuredContent: result.structuredContent,
      refCount: (capturedContext?.input ?? []).filter((i) => i.type === "image").length,
      metadata: capturedOptions?.metadata ?? null,
      savedExists: savePath ? fs.existsSync(savePath) : false,
      savedBytes: savePath && fs.existsSync(savePath) ? fs.readFileSync(savePath).toString() : null,
    };
  } catch (e) {
    output = { threw: e.message };
  }
  process.stdout.write(JSON.stringify(output));
}
`;

function runChild(agentDir: string, mode: string, env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["--input-type=module", "-e", CHILD],
      { env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, MODE: mode, ...env }, timeout: 30_000 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`child failed: ${err.message}\n${stderr}`));
        else resolve(stdout);
      },
    );
  });
}

function makeFixture(config: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-alibaba-factory-"));
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  const key = "sk-fake-cloud-key";
  fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "alibaba-cloud": { type: "api_key", key } }));
  fs.writeFileSync(path.join(agentDir, "alibaba-config.json"), JSON.stringify({
    // Non-routable domain + a matching fingerprint: no probe, no fetch.
    cloudDomain: "127.0.0.1:9",
    cloudKeyFingerprint: cloudKeyFingerprint(key),
    ...config,
  }));
  fs.writeFileSync(path.join(agentDir, "alibaba-models.cache.json"), JSON.stringify({
    v: 2,
    cloud: {
      fetchedAt: Date.now(),
      models: [
        { id: "qwen3.7-plus", name: "Qwen 3.7 Plus", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1048576, maxTokens: 65536 },
      ],
    },
    cloudImages: {
      fetchedAt: Date.now(),
      models: [{ id: "qwen-image-plus", name: "Qwen Image Plus" }, { id: "z-image-turbo", name: "Z-Image Turbo" }],
    },
  }));
  return agentDir;
}

describe("factory registration: mixed provider + tool exposure", () => {
  it("registers chat and image cards on one Cloud provider, with the image implementation", async () => {
    const dir = makeFixture({});
    const out = JSON.parse(await runChild(dir, "info"));
    const cloud = out.providers["alibaba-cloud"];
    assert.deepEqual(cloud.types, ["chat", "image", "image"]);
    assert.deepEqual(cloud.imageIds, ["qwen-image-plus", "z-image-turbo"]);
    assert.deepEqual(cloud.imageApis, ["dashscope-images"]);
    assert.equal(cloud.refresh, true);
    assert.deepEqual(out.providers["alibaba-plan"].imageIds, []);
  });

  it("defaults both tools to codemode exposure, one namespace, and the right annotations", async () => {
    const dir = makeFixture({});
    const out = JSON.parse(await runChild(dir, "info"));
    const { alibaba_tools: tools, alibaba_image: image } = out.tools;
    assert.equal(tools.exposure, "codemode");
    assert.equal(image.exposure, "codemode");
    assert.equal(tools.namespaceName, "alibaba");
    assert.equal(image.namespaceName, "alibaba");
    assert.equal(tools.namespaceInstructions, true);
    assert.deepEqual(tools.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
    assert.deepEqual(image.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
    assert.equal(tools.outputSchema, true);
    assert.deepEqual(tools.outputSchemaRequired, ["action", "result", "sources", "calls", "retries"]);
    assert.equal(image.outputSchema, true);
  });

  it("adds one prompt section naming the codemode tools and the preferred family", async () => {
    const dir = makeFixture({});
    const out = JSON.parse(await runChild(dir, "info"));
    assert.equal(out.sectionCount, 1);
    assert.match(out.section, /alibaba_tools/);
    assert.match(out.section, /alibaba_image/);
    assert.match(out.section, /qwen-image-\*/);
  });

  it("adds the same section to a custom-message run (pi 1.2.0 event union)", async () => {
    const dir = makeFixture({});
    const out = JSON.parse(await runChild(dir, "info"));
    // A run started by pi.sendMessage(..., { triggerTurn: true }) reaches the
    // same codemode tools, so the section must not be gated on messageType.
    assert.match(out.sectionCustom, /alibaba_tools/);
    assert.equal(out.sectionCustom, out.section);
  });

  it("honors per-tool exposure and drops an off tool entirely", async () => {
    const dir = makeFixture({ alibabaToolsExposure: "off", alibabaImageExposure: "direct" });
    const out = JSON.parse(await runChild(dir, "info"));
    assert.equal(out.tools.alibaba_tools, undefined);
    assert.equal(out.tools.alibaba_image.exposure, "direct");
    // Only the direct (non-codemode) tool is registered: no codemode section.
    assert.equal(out.section, null);
  });

  it("adds no prompt section when both tools are not codemode-exposed", async () => {
    const dir = makeFixture({ alibabaToolsExposure: "off", alibabaImageExposure: "off" });
    const out = JSON.parse(await runChild(dir, "info"));
    assert.deepEqual(out.tools, {});
    assert.equal(out.section, null);
  });

  it("migrates the legacy cloudSidecarTools=false opt-out to exposure off", async () => {
    const dir = makeFixture({ cloudSidecarTools: false });
    const out = JSON.parse(await runChild(dir, "info"));
    assert.equal(out.tools.alibaba_tools, undefined);
    assert.equal(out.tools.alibaba_image.exposure, "codemode");
    const config = JSON.parse(fs.readFileSync(path.join(dir, "alibaba-config.json"), "utf8"));
    assert.equal(config.alibabaToolsExposure, "off");
    assert.equal(config.cloudSidecarTools, undefined);
  });
});

describe("stream-error rewriting path", () => {
  it("prefixes an unrecognized error from the recorded raw event", async () => {
    const dir = makeFixture({});
    assert.equal(JSON.parse(await runChild(dir, "stream-rate")).rewritten, "429 Generation stopped.");
    assert.equal(JSON.parse(await runChild(dir, "stream-backend")).rewritten, "server_error Generation stopped.");
  });

  it("leaves a permanent InvalidParameter error untouched", async () => {
    const dir = makeFixture({});
    assert.equal(JSON.parse(await runChild(dir, "stream-invalid")).rewritten, null);
  });

  it("does nothing when no raw event was seen", async () => {
    const dir = makeFixture({});
    assert.equal(JSON.parse(await runChild(dir, "stream-none")).rewritten, null);
  });
});

describe("alibaba_image tool behaviour", () => {
  it("maps parameters to metadata and returns structured image content", async () => {
    const dir = makeFixture({});
    const out = JSON.parse(await runChild(dir, "exec-ok"));
    assert.equal(out.isError, false);
    assert.deepEqual(out.metadata, {
      size: "1024*1024", n: 2, seed: 7, negativePrompt: "blurry",
      watermark: false, promptExtend: true, promptExtendMode: "direct", enableThinking: false,
    });
    assert.deepEqual(out.structuredContent.images, [{ type: "image", data: "QUJD", mimeType: "image/png" }]);
    assert.equal(out.structuredContent.model, "qwen-image-plus");
    assert.equal(out.structuredContent.size, "1024*1024");
    assert.equal(out.structuredContent.usage.totalTokens, 3);
    assert.deepEqual(out.contentTypes, ["text", "image"]);
    assert.equal(out.savedExists, false); // save omitted -> no write
  });

  it("writes the image only when save is given", async () => {
    const dir = makeFixture({});
    const save = path.join(dir, "out", "cat.png");
    const out = JSON.parse(await runChild(dir, "exec-save", { SAVE_PATH: save }));
    assert.equal(out.savedExists, true);
    assert.equal(out.savedBytes, "ABC");
    assert.match(out.text, /saved to/);
  });

  it("returns an error result, with structured detail, when generation fails", async () => {
    const dir = makeFixture({});
    const out = JSON.parse(await runChild(dir, "exec-error"));
    assert.equal(out.isError, true);
    assert.equal(out.structuredContent.error, "model rejected the size");
    assert.deepEqual(out.structuredContent.images, []);
    assert.match(out.text, /alibaba_image failed/);
  });

  it("refuses more than three reference images", async () => {
    const dir = makeFixture({});
    const out = JSON.parse(await runChild(dir, "exec-refuse"));
    assert.match(out.threw, /at most 3/);
  });

  it("refuses an editor call with no reference images before spending it", async () => {
    const dir = makeFixture({});
    const out = JSON.parse(await runChild(dir, "exec-editor"));
    assert.equal(out.isError, true);
    assert.match(out.structuredContent.error, /image editor and needs 1–3 reference images/);
    assert.deepEqual(out.structuredContent.images, []);
  });

  it("lets a qwen-image-3.0 hybrid generate with no reference images", async () => {
    const dir = makeFixture({});
    const out = JSON.parse(await runChild(dir, "exec-hybrid"));
    assert.equal(out.isError, false);
    assert.equal(out.refCount, 0); // text-only request body reached the registry
    assert.equal(out.structuredContent.model, "qwen-image-3.0");
    assert.deepEqual(out.contentTypes, ["text", "image"]);
  });
});

describe("/alibaba image subcommand (no codemode)", () => {
  it("generates, reports progress, saves, and posts a custom message with the image", async () => {
    const dir = makeFixture({});
    const save = path.join(dir, "cmd", "cat.png");
    const out = JSON.parse(await runChild(dir, "command-ok", {
      CMD_ARGS: "image a cat --size 512*512 --save " + save,
      SAVE_PATH: save,
    }));
    assert.equal(out.sent.length, 1);
    assert.equal(out.sent[0].customType, "alibaba-image");
    assert.deepEqual(out.sent[0].contentTypes, ["text", "image"]);
    assert.match(out.sent[0].text, /Generated 1 image with qwen-image-plus at 512\*512 — saved to/);
    assert.equal(out.statusProgress, true);
    assert.equal(out.statusCleared, true);
    assert.equal(out.savedExists, true);
    assert.equal(out.savedBytes, "ABC");
  });

  it("reports a clear error when no image model is registered", async () => {
    const dir = makeFixture({});
    const out = JSON.parse(await runChild(dir, "command-missing", {
      CMD_ARGS: "image a cat",
      REGISTRY_MODE: "missing",
    }));
    assert.equal(out.sent.length, 0);
    assert.match(out.notified.map((n) => n.message).join(" "), /is not registered/);
  });

  it("reports a clear error when an editor is called without references", async () => {
    const dir = makeFixture({});
    const out = JSON.parse(await runChild(dir, "command-editor", {
      CMD_ARGS: "image edit it --model qwen-image-edit-plus",
    }));
    assert.equal(out.sent.length, 0);
    assert.match(out.notified.map((n) => n.message).join(" "), /image editor and needs 1–3 reference images/);
  });

  it("reports an unknown subcommand instead of opening the menu", async () => {
    const dir = makeFixture({});
    // No UI select answers are supplied, so a fallthrough to the menu would
    // produce no notification at all.
    const out = JSON.parse(await runChild(dir, "command-bad", { CMD_ARGS: "frobnicate" }));
    assert.match(out.notified.map((n) => n.message).join(" "), /Unknown \/alibaba subcommand/);
  });
});
