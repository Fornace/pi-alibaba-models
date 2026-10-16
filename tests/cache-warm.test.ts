import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendCacheLog,
  BLIND_HIT_FRACTION,
  buildWarmPayload,
  cacheFieldsFromStreamEvent,
  contextId,
  createCacheWarmer,
  DASHSCOPE_CACHE_TTL_SECONDS,
  declaredCacheTtlSeconds,
  DEFAULT_WARM_SETTINGS,
  isBlindWarm,
  MAX_BLIND_WARMS,
  parseCacheUsage,
  planWarm,
  readCacheLog,
  resolveWarmSettings,
  summarizeCacheLog,
  warmUrl,
  warmingDecisionOverride,
  type CacheLogRecord,
  type WarmSettings,
  type WarmState,
} from "../extensions/cache-warm.ts";

// ── Real provider payloads ──────────────────────────────────────────────
// Verbatim `usage` objects from docs/notes/2026-10-07-dashscope-cache-probe-
// results.jsonl (qwen3.8-max-0902, cn-beijing workspace).
const RESPONSES_EXPLICIT_CREATE = {
  input_tokens: 4569,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 16,
  total_tokens: 4585,
  x_details: [{
    prompt_tokens_details: {
      cached_tokens: 0,
      cache_type: "ephemeral",
      cache_creation_input_tokens: 4563,
      cache_creation: { ephemeral_5m_input_tokens: 4563 },
    },
    x_billing_type: "response_api",
  }],
};
const RESPONSES_EXPLICIT_HIT = {
  ...RESPONSES_EXPLICIT_CREATE,
  input_tokens_details: { cached_tokens: 4563 },
  x_details: [{ prompt_tokens_details: { cached_tokens: 4563, cache_type: "ephemeral", cache_creation_input_tokens: 0 } }],
};
const RESPONSES_IMPLICIT = {
  input_tokens: 4569,
  input_tokens_details: { cached_tokens: 4096 },
  output_tokens: 16,
  x_details: [{ prompt_tokens_details: { cached_tokens: 4096 } }],
};
const COMPLETIONS_CREATE = {
  prompt_tokens: 4549,
  completion_tokens: 26,
  total_tokens: 4575,
  prompt_tokens_details: {
    cached_tokens: 0, cache_type: "ephemeral", cache_creation_input_tokens: 4531, text_tokens: 4549,
  },
};
const ANTHROPIC_USAGE = {
  input_tokens: 12,
  output_tokens: 40,
  cache_read_input_tokens: 44_000,
  cache_creation_input_tokens: 0,
};
// deepseek-v4.1-flash, 2026-10-09T18:12:39Z onward: 27 replays of a 376 453-token
// context, each reporting the first block only and no creation tokens, each a
// 22–50 s cold prefill, and no real request ever came back for the block.
// Verbatim shape from ~/.pi/agent/alibaba-cache.jsonl.
const DEEPSEEK_BLIND_TINY_HIT = {
  input_tokens: 376_453,
  input_tokens_details: { cached_tokens: 1_024 },
  output_tokens: 16,
  x_details: [{ prompt_tokens_details: { cached_tokens: 1_024 }, x_billing_type: "response_api" }],
};
const DEEPSEEK_BLIND_ZERO = {
  ...DEEPSEEK_BLIND_TINY_HIT,
  input_tokens_details: { cached_tokens: 0 },
  x_details: [{ prompt_tokens_details: { cached_tokens: 0 }, x_billing_type: "response_api" }],
};

describe("resolveWarmSettings", () => {
  it("defaults to warming, at 216 s, for 4 h, above 20k tokens", () => {
    assert.deepEqual(resolveWarmSettings({}), DEFAULT_WARM_SETTINGS);
    assert.deepEqual(resolveWarmSettings({}), {
      mode: "extension", refreshSeconds: 216, horizonMinutes: 240, minPromptTokens: 20_000, telemetry: true,
    });
    assert.equal(DEFAULT_WARM_SETTINGS.refreshSeconds < DASHSCOPE_CACHE_TTL_SECONDS, true);
  });

  it("keeps every value inside its range and falls back on garbage", () => {
    assert.equal(resolveWarmSettings({ mode: "pi" }).mode, "pi");
    assert.equal(resolveWarmSettings({ mode: "off" }).mode, "off");
    assert.equal(resolveWarmSettings({ mode: "nonsense" }).mode, "extension");
    // Out-of-range means "use the default", not "clamp": a refresh above the
    // measured TTL would never hit, and a typo must not silently disable warming.
    assert.equal(resolveWarmSettings({ refreshSeconds: 900 }).refreshSeconds, 216);
    assert.equal(resolveWarmSettings({ refreshSeconds: 5 }).refreshSeconds, 216);
    assert.equal(resolveWarmSettings({ refreshSeconds: 150 }).refreshSeconds, 150);
    assert.equal(resolveWarmSettings({ horizonMinutes: 0 }).horizonMinutes, 240);
    assert.equal(resolveWarmSettings({ horizonMinutes: 9999 }).horizonMinutes, 240);
    assert.equal(resolveWarmSettings({ minPromptTokens: "abc" }).minPromptTokens, 20_000);
    // 0 is a legal floor: warm everything.
    assert.equal(resolveWarmSettings({ minPromptTokens: 0 }).minPromptTokens, 0);
    assert.equal(resolveWarmSettings({ telemetry: false }).telemetry, false);
    assert.equal(resolveWarmSettings({ telemetry: undefined }).telemetry, true);
  });
});

describe("declaredCacheTtlSeconds", () => {
  it("inverts pi's 0.9·ttl refresh schedule", () => {
    assert.equal(declaredCacheTtlSeconds(270), 300);
    assert.equal(declaredCacheTtlSeconds(216), 240);
    assert.equal(declaredCacheTtlSeconds(150), 167);
    assert.equal(declaredCacheTtlSeconds(1), 20);
  });
});

describe("planWarm", () => {
  const settings: WarmSettings = { ...DEFAULT_WARM_SETTINGS, minPromptTokens: 20_000 };
  const T0 = 1_800_000_000_000;
  const base: WarmState = { lastRequestAt: T0, promptTokens: 150_000, inFlight: false, failures: 0, blind: 0 };

  it("waits until the refresh is due, measured from the last renewal", () => {
    assert.deepEqual(planWarm(base, settings, T0 + 10_000), { action: "wait", delayMs: 206_000 });
    assert.deepEqual(planWarm(base, settings, T0 + 216_000), { action: "warm" });
    assert.deepEqual(planWarm(base, settings, T0 + 300_000), { action: "warm" });
    // A warm renews the block, so the next one is a full interval after it.
    const afterWarm = { ...base, lastWarmAt: T0 + 216_000 };
    assert.deepEqual(planWarm(afterWarm, settings, T0 + 220_000), { action: "wait", delayMs: 212_000 });
    assert.deepEqual(planWarm(afterWarm, settings, T0 + 432_000), { action: "warm" });
  });

  it("never warms while a request is in flight", () => {
    assert.deepEqual(planWarm({ ...base, inFlight: true }, settings, T0 + 999_000), { action: "wait", delayMs: 2_000 });
  });

  it("stops below the prompt-size floor and with no estimate", () => {
    assert.equal(planWarm({ ...base, promptTokens: 19_999 }, settings, T0).action, "stop");
    assert.equal(planWarm({ ...base, promptTokens: 0 }, settings, T0).action, "stop");
    assert.equal(planWarm({ ...base, promptTokens: 20_000 }, settings, T0 + 216_000).action, "warm");
    assert.equal(planWarm(base, { ...settings, minPromptTokens: 0 }, T0 + 216_000).action, "warm");
  });

  it("stops at the horizon instead of warming for days", () => {
    const fourHours = 240 * 60_000;
    // A timer that is already due still fires inside the horizon…
    assert.equal(planWarm(base, settings, T0 + fourHours - 1000).action, "warm");
    // …and the run ends once the horizon itself has passed.
    assert.deepEqual(planWarm(base, settings, T0 + fourHours + 1000), { action: "stop", reason: "240m horizon reached" });
    // A refresh whose *due time* lies past the horizon is never armed.
    const late = { ...base, lastWarmAt: T0 + fourHours - 60_000 };
    assert.equal(planWarm(late, settings, T0 + fourHours - 60_000).action, "stop");
  });

  it("backs off linearly on failures and gives up after four", () => {
    assert.deepEqual(planWarm({ ...base, failures: 1 }, settings, T0 + 216_000), { action: "wait", delayMs: 216_000 });
    assert.deepEqual(planWarm({ ...base, failures: 1 }, settings, T0 + 432_000), { action: "warm" });
    assert.deepEqual(planWarm({ ...base, failures: 3 }, settings, T0 + 216_000 * 3), { action: "wait", delayMs: 216_000 });
    assert.equal(planWarm({ ...base, failures: 4 }, settings, T0 + 999_000).action, "stop");
  });

  it("gives up on replays that renewed nothing, one short of the failure rule", () => {
    assert.equal(planWarm({ ...base, blind: MAX_BLIND_WARMS - 1 }, settings, T0 + 216_000).action, "warm");
    assert.deepEqual(planWarm({ ...base, blind: MAX_BLIND_WARMS }, settings, T0 + 216_000), {
      action: "stop", reason: `${MAX_BLIND_WARMS} warm replays renewed nothing`,
    });
    // Blindness is not a failure: no backoff, and the two rules stay independent.
    assert.deepEqual(planWarm({ ...base, blind: 2 }, settings, T0 + 216_000), { action: "warm" });
  });
});

describe("isBlindWarm", () => {
  it("counts a replay as blind only when nothing says the block is alive", () => {
    // No hit, no creation: nothing to show for a full prefill.
    assert.equal(isBlindWarm(0, 0, 376_453), true);
    assert.equal(isBlindWarm(undefined, undefined, 376_453), true);
    // The measured deepseek case: one or four blocks of a 376 453-token prefix.
    assert.equal(isBlindWarm(1_024, 0, 376_453), true);
    assert.equal(isBlindWarm(4_096, 0, 376_453), true);
    assert.equal(4_096 / 376_453 < BLIND_HIT_FRACTION, true);
    // A real hit, and a rewrite (creation reported), are both evidence.
    assert.equal(isBlindWarm(149_000, 0, 150_000), false);
    assert.equal(isBlindWarm(0, 149_000, 150_000), false);
    assert.equal(isBlindWarm(1_024, 375_000, 376_453), false);
    // A context that grew since the last renewal still counts as renewed.
    assert.equal(isBlindWarm(90_000, 0, 150_000), false);
    // At the fraction boundary, and with no prompt size to judge against, the
    // probe gets the benefit of the doubt.
    assert.equal(isBlindWarm(Math.round(150_000 * BLIND_HIT_FRACTION), 0, 150_000), false);
    assert.equal(isBlindWarm(Math.round(150_000 * BLIND_HIT_FRACTION) - 1, 0, 150_000), true);
    assert.equal(isBlindWarm(1_024, 0, 0), false);
  });
});

describe("contextId", () => {
  const responses = (over: Record<string, unknown> = {}) => ({
    model: "qwen3.8-max-0902",
    instructions: "You are pi. cwd: /Users/u/repo",
    input: [
      { role: "user", content: "read the report" },
      { role: "assistant", content: "reading it now" },
    ],
    tools: [{ name: "bash" }, { name: "read" }],
    ...over,
  });

  it("is one id for one conversation, however long the tail grows", () => {
    const head = contextId(responses(), "openai-responses");
    assert.match(head ?? "", /^[0-9a-f]{8}$/);
    const grown = responses({
      input: [
        ...responses().input as unknown[],
        ...Array.from({ length: 400 }, (_, i) => ({ role: "user", content: `turn ${i} ${"x".repeat(5_000)}` })),
      ],
    });
    assert.equal(contextId(grown, "openai-responses"), head);
  });

  it("separates what a provider cache separates", () => {
    const base = contextId(responses(), "openai-responses");
    assert.notEqual(contextId(responses({ instructions: "You are pi. cwd: /other" }), "openai-responses"), base);
    assert.notEqual(contextId(responses({ input: [{ role: "user", content: "something else" }] }), "openai-responses"), base);
    assert.notEqual(contextId(responses({ tools: [{ name: "bash" }] }), "openai-responses"), base);
  });

  it("reads the Completions shape as well", () => {
    const completions = {
      model: "deepseek-v4.1-flash",
      messages: [
        { role: "system", content: "You are pi." },
        { role: "user", content: "hi" },
      ],
    };
    const id = contextId(completions, "openai-completions");
    assert.match(id ?? "", /^[0-9a-f]{8}$/);
    assert.equal(contextId({ ...completions, messages: [...completions.messages, { role: "assistant", content: "hello" }] }, "openai-completions"), id);
    // The same words on the Responses shape are a different request, not the
    // same id: `instructions` is where its system prompt lives.
    assert.notEqual(contextId(completions, "openai-responses"), id);
  });

  it("is undefined when there is no head to hash", () => {
    assert.equal(contextId(undefined, "openai-responses"), undefined);
    assert.equal(contextId("payload", "openai-responses"), undefined);
    assert.equal(contextId({ model: "qwen3.8-max-0902" }, "openai-responses"), undefined);
  });
});

describe("warmingDecisionOverride (mode pi)", () => {
  const settings: WarmSettings = { ...DEFAULT_WARM_SETTINGS, mode: "pi" };

  it("forces a warm pi's dollar gate rejected, for prompts that are slow when cold", () => {
    assert.deepEqual(
      warmingDecisionOverride(settings, 150_000, { action: "stop" }),
      { action: "warm" },
    );
  });

  it("stays out of the way otherwise", () => {
    assert.equal(warmingDecisionOverride(settings, 150_000, { action: "warm" }), undefined);
    assert.equal(warmingDecisionOverride(settings, 5_000, { action: "stop" }), undefined);
    assert.equal(warmingDecisionOverride(settings, 0, { action: "stop" }), undefined);
    // The extension engine and "off" do not use pi's warmer at all.
    assert.equal(warmingDecisionOverride({ ...settings, mode: "extension" }, 150_000, { action: "stop" }), undefined);
    assert.equal(warmingDecisionOverride({ ...settings, mode: "off" }, 150_000, { action: "stop" }), undefined);
  });
});

describe("warmUrl", () => {
  it("appends the same paths the OpenAI and Anthropic SDKs use", () => {
    const base = "https://ws.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
    assert.equal(warmUrl(base, "openai-responses"), `${base}/responses`);
    assert.equal(warmUrl(base, "openai-completions"), `${base}/chat/completions`);
    assert.equal(
      warmUrl("https://ws.cn-beijing.maas.aliyuncs.com/apps/anthropic", "anthropic-messages"),
      "https://ws.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages",
    );
    assert.equal(warmUrl(`${base}/`, "openai-responses"), `${base}/responses`);
    assert.equal(warmUrl(base, "google-generative-ai"), undefined);
    assert.equal(warmUrl(undefined, "openai-responses"), undefined);
  });
});

describe("buildWarmPayload", () => {
  const prefix = { model: "qwen3.8-max-0902", prompt_cache_key: "session-1", stream: true, stream_options: { include_usage: true } };

  it("caps output and stops streaming on the Responses shape", () => {
    const payload = buildWarmPayload({ ...prefix, input: [{ role: "user", content: "hi" }], tools: [{ name: "bash" }] }, "openai-responses");
    assert.equal(payload?.max_output_tokens, 16);
    assert.equal(payload?.stream, false);
    assert.equal("stream_options" in (payload ?? {}), false);
    assert.equal("max_tokens" in (payload ?? {}), false);
    // The cached prefix must survive untouched.
    assert.deepEqual(payload?.input, [{ role: "user", content: "hi" }]);
    assert.deepEqual(payload?.tools, [{ name: "bash" }]);
    assert.equal(payload?.prompt_cache_key, "session-1");
  });

  it("keeps whichever output cap the Completions payload already uses", () => {
    assert.equal(buildWarmPayload({ ...prefix, max_completion_tokens: 8192 }, "openai-completions")?.max_completion_tokens, 16);
    assert.equal(buildWarmPayload({ ...prefix, max_tokens: 8192 }, "openai-completions")?.max_tokens, 16);
    assert.equal("max_completion_tokens" in (buildWarmPayload({ ...prefix, max_tokens: 8192 }, "openai-completions") ?? {}), false);
  });

  it("drops the thinking budget on the Anthropic shape", () => {
    // Anthropic requires max_tokens > budget_tokens; a 16-token warm with a
    // 1024-token budget would 400 instead of refreshing anything.
    const payload = buildWarmPayload({ ...prefix, max_tokens: 8192, thinking: { type: "enabled", budget_tokens: 1024 } }, "anthropic-messages");
    assert.equal(payload?.max_tokens, 16);
    assert.equal("thinking" in (payload ?? {}), false);
  });

  it("refuses a payload it cannot read", () => {
    assert.equal(buildWarmPayload(undefined, "openai-responses"), undefined);
    assert.equal(buildWarmPayload("nope", "openai-responses"), undefined);
  });

  it("does not mutate the captured payload", () => {
    const original = { ...prefix, max_output_tokens: 8192 };
    buildWarmPayload(original, "openai-responses");
    assert.equal(original.max_output_tokens, 8192);
    assert.equal(original.stream, true);
  });
});

describe("parseCacheUsage", () => {
  it("finds creation tokens where DashScope actually puts them (Responses)", () => {
    // pi-ai reads usage.input_tokens_details.cache_write_tokens, a field this
    // provider never sends — so pi records every cache write as plain input.
    assert.deepEqual(parseCacheUsage("openai-responses", { usage: RESPONSES_EXPLICIT_CREATE }), {
      input: 4569, output: 16, cached: 0, creation: 4563, cacheType: "ephemeral",
    });
    assert.deepEqual(parseCacheUsage("openai-responses", { usage: RESPONSES_EXPLICIT_HIT }), {
      input: 4569, output: 16, cached: 4563, creation: 0, cacheType: "ephemeral",
    });
  });

  it("reads the implicit shape, which reports no creation at all", () => {
    assert.deepEqual(parseCacheUsage("openai-responses", { usage: RESPONSES_IMPLICIT }), {
      input: 4569, output: 16, cached: 4096, creation: undefined, cacheType: undefined,
    });
  });

  it("reads Completions and Anthropic usage", () => {
    assert.deepEqual(parseCacheUsage("openai-completions", { usage: COMPLETIONS_CREATE }), {
      input: 4549, output: 26, cached: 0, creation: 4531, cacheType: "ephemeral",
    });
    assert.deepEqual(parseCacheUsage("anthropic-messages", { usage: ANTHROPIC_USAGE }), {
      input: 12, output: 40, cached: 44_000, creation: 0, cacheType: "ephemeral",
    });
  });

  it("returns nothing for a body without usage", () => {
    assert.deepEqual(parseCacheUsage("openai-responses", {}), {});
    assert.deepEqual(parseCacheUsage("openai-responses", undefined), {});
  });
});

describe("cacheFieldsFromStreamEvent", () => {
  it("takes the Responses completion event", () => {
    assert.deepEqual(
      cacheFieldsFromStreamEvent("openai-responses", { type: "response.completed", response: { usage: RESPONSES_EXPLICIT_HIT } }),
      { input: 4569, output: 16, cached: 4563, creation: 0, cacheType: "ephemeral" },
    );
    assert.equal(cacheFieldsFromStreamEvent("openai-responses", { type: "response.output_text.delta" }), undefined);
    assert.equal(cacheFieldsFromStreamEvent("openai-responses", { type: "response.completed" }), undefined);
  });

  it("takes the Anthropic message_start and the Completions usage chunk", () => {
    assert.deepEqual(
      cacheFieldsFromStreamEvent("anthropic-messages", { type: "message_start", message: { usage: ANTHROPIC_USAGE } })?.cached,
      44_000,
    );
    assert.equal(cacheFieldsFromStreamEvent("anthropic-messages", { type: "content_block_delta" }), undefined);
    assert.deepEqual(
      cacheFieldsFromStreamEvent("openai-completions", { usage: COMPLETIONS_CREATE })?.creation,
      4531,
    );
    assert.equal(cacheFieldsFromStreamEvent("openai-completions", { choices: [] }), undefined);
  });
});

describe("cache telemetry log", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alibaba-cache-"));
  const file = path.join(tmp, "alibaba-cache.jsonl");
  const rec = (over: Partial<CacheLogRecord> = {}): CacheLogRecord => ({
    ts: 1_800_000_000_000, kind: "turn", provider: "alibaba-cloud", model: "qwen3.8-max-0902",
    api: "openai-responses", promptTokens: 150_000, cached: 149_000, creation: 0, ok: true, ...over,
  });

  it("round-trips records and ignores foreign lines", () => {
    appendCacheLog(file, rec());
    appendCacheLog(file, rec({ kind: "warm", cached: 0, creation: 149_000, note: "rewrote expired block" }));
    fs.appendFileSync(file, "not json\n");
    const read = readCacheLog(file);
    assert.equal(read.length, 2);
    assert.equal(read[1].kind, "warm");
    assert.deepEqual(readCacheLog(path.join(tmp, "missing.jsonl")), []);
  });

  it("summarizes turns and warms separately", () => {
    const s = summarizeCacheLog([
      rec(),
      rec({ cached: 0, promptTokens: 120_000 }),
      rec({ kind: "warm", cached: 149_000, creation: 0 }),
      rec({ kind: "warm", cached: 0, creation: 149_000 }),
      rec({ kind: "warm", ok: false, cached: 0, note: "HTTP 429" }),
      // Blind: answered, and neither a hit worth the name nor a creation.
      rec({ kind: "warm", cached: 0, creation: 0, note: "no renewal reported" }),
      rec({ kind: "warm", cached: 1_024, creation: 0, promptTokens: 376_453 }),
    ]);
    assert.deepEqual(
      { turns: s.turns, turnHits: s.turnHits, turnMisses: s.turnMisses, hitRatePct: s.hitRatePct },
      { turns: 2, turnHits: 1, turnMisses: 1, hitRatePct: 50 },
    );
    assert.deepEqual(
      { warms: s.warms, warmHits: s.warmHits, warmRewrites: s.warmRewrites, warmBlind: s.warmBlind, warmFailures: s.warmFailures },
      { warms: 5, warmHits: 1, warmRewrites: 1, warmBlind: 2, warmFailures: 1 },
    );
    assert.equal(s.cachedTokens, 149_000);
    assert.equal(s.missedTokens, 120_000);
    // Only real hits count as cached: a blind probe saved nothing.
    assert.equal(s.warmCachedTokens, 149_000);
    assert.equal(summarizeCacheLog([]).hitRatePct, null);
    assert.equal(summarizeCacheLog([]).warmBlind, 0);
  });

  it("trims the file back to its tail once it grows past the cap", () => {
    const big = path.join(tmp, "big.jsonl");
    // 1300 lines × ~1.3 kB: over the byte cap and over the line budget, so the
    // trim has to drop the oldest records and keep the newest one.
    fs.writeFileSync(big, Array.from({ length: 1300 }, (_, i) => `${i} ${"x".repeat(1300)}`).join("\n") + "\n");
    appendCacheLog(big, rec());
    const lines = fs.readFileSync(big, "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, 1200);
    assert.equal(JSON.parse(lines[lines.length - 1]).kind, "turn");
    assert.equal(fs.statSync(big).size < 1_600_000, true);
  });
});

// ── Engine ──────────────────────────────────────────────────────────────

interface FakeTimer { fn: () => void; at: number }

function harness(opts: {
  settings?: Partial<WarmSettings>;
  status?: number;
  usage?: unknown;
  /** The credential a replay must still match; omit to leave the dep unset. */
  credential?: () => string | null | undefined;
  /** Signature carried by the captured template; omit for an unsigned one. */
  cred?: string | null;
} = {}) {
  const timers: FakeTimer[] = [];
  const requests: { url: string; init: RequestInit }[] = [];
  let clock = 1_800_000_000_000;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alibaba-warm-"));
  const logFile = path.join(dir, "alibaba-cache.jsonl");
  const settings: WarmSettings = { ...DEFAULT_WARM_SETTINGS, ...opts.settings };
  const warmer = createCacheWarmer({
    settings: () => settings,
    logFile: () => logFile,
    now: () => clock,
    ...(opts.credential ? { credential: opts.credential } : {}),
    setTimeout: (fn, ms) => { const t = { fn, at: clock + ms }; timers.push(t); return t; },
    clearTimeout: (h) => { const i = timers.indexOf(h as FakeTimer); if (i >= 0) timers.splice(i, 1); },
    fetch: async (url, init) => {
      requests.push({ url, init });
      const body = JSON.parse(String(init.body));
      const usage = opts.usage ?? {
        input_tokens: body.input?.length ? 150_000 : 0,
        input_tokens_details: { cached_tokens: 149_000 },
        output_tokens: 16,
      };
      return {
        ok: (opts.status ?? 200) < 400,
        status: opts.status ?? 200,
        json: async () => ({ usage }),
      } as unknown as Response;
    },
  });
  const payload = {
    model: "qwen3.8-max-0902",
    instructions: "You are pi. cwd: /repo",
    input: [{ role: "user", content: "hi" }],
    stream: true,
    max_output_tokens: 8192,
  };
  const template = {
    provider: "alibaba-cloud", model: "qwen3.8-max-0902", api: "openai-responses",
    baseUrl: "https://ws.example/compatible-mode/v1",
    headers: { authorization: "Bearer k", "x-dashscope-session-cache": "enable" },
    payload,
    at: clock,
    ctx: contextId(payload, "openai-responses") as string,
    cred: opts.cred,
  };
  /** Run every timer that came due, flushing the async warm between them. */
  const advance = async (ms: number) => {
    clock += ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= clock).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      due.fn();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    }
  };
  return { warmer, timers, requests, logFile, advance, template, settings, at: () => clock, body: (i = 0) => JSON.parse(String(requests[i].init.body)) };
}

describe("cache warmer engine", () => {
  it("replays the captured request on schedule, byte-identical except the cap", async () => {
    const h = harness();
    h.warmer.noteRequest(h.template);
    h.warmer.notePromptTokens(150_000);
    h.warmer.noteInFlight(true);
    assert.equal(h.requests.length, 0); // never warm over a real request
    h.warmer.noteInFlight(false);
    await h.advance(215_000);
    assert.equal(h.requests.length, 0);
    await h.advance(2_000);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].url, "https://ws.example/compatible-mode/v1/responses");
    const body = h.body();
    assert.equal(body.max_output_tokens, 16);
    assert.equal(body.stream, false);
    assert.deepEqual(body.input, [{ role: "user", content: "hi" }]);
    assert.deepEqual(h.requests[0].init.headers, {
      authorization: "Bearer k", "x-dashscope-session-cache": "enable", "content-type": "application/json",
    });
    const st = h.warmer.status();
    assert.deepEqual({ warms: st.warms, hits: st.hits, rewrites: st.rewrites, failures: st.failures },
      { warms: 1, hits: 1, rewrites: 0, failures: 0 });
    // Telemetry records what the provider really reported.
    const logged = readCacheLog(h.logFile);
    assert.equal(logged.length, 1);
    assert.deepEqual({ kind: logged[0].kind, cached: logged[0].cached, ok: logged[0].ok }, { kind: "warm", cached: 149_000, ok: true });
  });

  it("keeps refreshing on its own interval and stops at the horizon", async () => {
    const h = harness({ settings: { horizonMinutes: 10 } });
    h.warmer.noteRequest(h.template);
    h.warmer.notePromptTokens(150_000);
    await h.advance(216_000);
    assert.equal(h.requests.length, 1);
    await h.advance(216_000);
    assert.equal(h.requests.length, 2);
    // The next refresh would land at 648 s, past a 600 s horizon, so it is
    // never armed: the run ends quietly instead of warming for days.
    await h.advance(216_000 * 2);
    assert.equal(h.requests.length, 2);
    assert.match(h.warmer.status().reason ?? "", /horizon/);
    assert.equal(h.warmer.status().running, false);
    assert.equal(h.timers.length, 0);
  });

  it("counts a warm that arrives after expiry as a rewrite, not a hit", async () => {
    const h = harness({
      usage: {
        input_tokens: 150_000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 16,
        x_details: [{ prompt_tokens_details: { cached_tokens: 0, cache_creation_input_tokens: 149_000, cache_type: "ephemeral" } }],
      },
    });
    h.warmer.noteRequest(h.template);
    h.warmer.notePromptTokens(150_000);
    await h.advance(216_000);
    const st = h.warmer.status();
    assert.deepEqual({ hits: st.hits, rewrites: st.rewrites, failures: st.failures }, { hits: 0, rewrites: 1, failures: 0 });
    assert.equal(st.lastResult?.rewrote, true);
    assert.equal(readCacheLog(h.logFile)[0].note, "rewrote expired block");
  });

  it("backs off after a failure and gives up after four", async () => {
    const h = harness({ status: 429 });
    h.warmer.noteRequest(h.template);
    h.warmer.notePromptTokens(150_000);
    await h.advance(216_000);
    assert.equal(h.requests.length, 1);
    assert.equal(h.warmer.status().failures, 1);
    await h.advance(216_000); // due at 2× the interval now
    assert.equal(h.requests.length, 1);
    await h.advance(216_000);
    assert.equal(h.requests.length, 2);
    for (let i = 0; i < 6; i++) await h.advance(216_000 * 4);
    assert.equal(h.warmer.status().failures >= 4, true);
    assert.match(h.warmer.status().reason ?? "", /failed in a row/);
    const stuck = h.requests.length;
    await h.advance(60 * 60_000);
    assert.equal(h.requests.length, stuck);
  });

  it("stays quiet below the prompt floor, without a template, and in modes pi/off", async () => {
    const small = harness();
    small.warmer.noteRequest(small.template);
    small.warmer.notePromptTokens(19_999);
    await small.advance(600_000);
    assert.equal(small.requests.length, 0);
    assert.match(small.warmer.status().reason ?? "", /under 20,000 tokens/);

    const noTemplate = harness();
    noTemplate.warmer.notePromptTokens(150_000);
    await noTemplate.advance(600_000);
    assert.equal(noTemplate.requests.length, 0);

    for (const mode of ["pi", "off"] as const) {
      const h = harness({ settings: { mode } });
      h.warmer.noteRequest(h.template);
      h.warmer.notePromptTokens(150_000);
      await h.advance(60 * 60_000);
      assert.equal(h.requests.length, 0);
      assert.equal(h.timers.length, 0);
    }
  });

  it("drops the template when the transcript is rewritten, and stops on shutdown", async () => {
    const h = harness();
    h.warmer.noteRequest(h.template);
    h.warmer.notePromptTokens(150_000);
    h.warmer.invalidate("compaction rewrites the prefix");
    await h.advance(600_000);
    assert.equal(h.requests.length, 0);
    assert.equal(h.warmer.status().reason, "compaction rewrites the prefix");

    h.warmer.noteRequest({ ...h.template, at: h.at() });
    h.warmer.stop();
    await h.advance(600_000);
    assert.equal(h.requests.length, 0);
  });

  it("warms on demand from /alibaba", async () => {
    const h = harness();
    assert.equal(await h.warmer.warmNow(), undefined);
    h.warmer.noteRequest(h.template);
    h.warmer.notePromptTokens(150_000);
    const res = await h.warmer.warmNow();
    assert.equal(res?.ok, true);
    assert.equal(h.requests.length, 1);
    // A manual warm renews the block, so the schedule restarts from it.
    assert.equal(h.timers.length, 1);
  });

  it("does not write telemetry when it is switched off", async () => {
    const h = harness({ settings: { telemetry: false } });
    h.warmer.noteRequest(h.template);
    h.warmer.notePromptTokens(150_000);
    await h.advance(216_000);
    assert.equal(h.requests.length, 1);
    assert.deepEqual(readCacheLog(h.logFile), []);
  });

  it("stops replaying a context that renews nothing, and starts again on a real request", async () => {
    const h = harness({ usage: DEEPSEEK_BLIND_ZERO });
    h.warmer.noteRequest(h.template);
    h.warmer.notePromptTokens(376_453, h.template.ctx);
    for (let i = 1; i <= MAX_BLIND_WARMS; i++) {
      await h.advance(216_000);
      assert.equal(h.requests.length, i, `probe ${i} should have gone out`);
      assert.equal(h.warmer.status().blind, i);
    }
    const st = h.warmer.status();
    assert.match(st.reason ?? "", /renewed nothing/);
    assert.equal(st.running, false);
    assert.equal(st.hits, 0);
    assert.equal(st.failures, 0, "a blind probe is not a failure: the provider answered 200");
    // 1 h 37 m of probes is what this replaced; nothing more goes out.
    await h.advance(216_000 * 27);
    assert.equal(h.requests.length, MAX_BLIND_WARMS);
    assert.equal(h.timers.length, 0);

    // A real request renews the block itself, so the streak is history.
    h.warmer.noteRequest({ ...h.template, at: h.at() });
    h.warmer.notePromptTokens(376_453, h.template.ctx);
    assert.equal(h.warmer.status().blind, 0);
    await h.advance(216_000);
    assert.equal(h.requests.length, MAX_BLIND_WARMS + 1);

    // Every blind probe says so in the log, with the context it belongs to.
    const logged = readCacheLog(h.logFile);
    assert.equal(logged.length, MAX_BLIND_WARMS + 1);
    assert.equal(logged[0].note, "no renewal reported");
    assert.equal(logged[0].ctx, h.template.ctx);
    assert.equal(logged[0].promptTokens, 376_453);
    assert.equal(summarizeCacheLog(logged).warmBlind, MAX_BLIND_WARMS + 1);
  });

  it("counts a first-block-only hit as blind, which is what deepseek reported", async () => {
    const h = harness({ usage: DEEPSEEK_BLIND_TINY_HIT });
    h.warmer.noteRequest(h.template);
    h.warmer.notePromptTokens(376_453, h.template.ctx);
    await h.advance(216_000);
    const st = h.warmer.status();
    assert.equal(st.blind, 1);
    assert.equal(st.hits, 0, "1 024 of 376 453 tokens is not a hit");
    assert.equal(readCacheLog(h.logFile)[0].note, "no renewal reported");
  });

  it("keeps the warmed context's size when another context reports a smaller one", async () => {
    const h = harness();
    h.warmer.noteRequest(h.template);
    h.warmer.notePromptTokens(150_000, h.template.ctx);
    // A child agent or a sidecar call in the same process: 4 096 tokens says
    // nothing about the 150k block being kept alive, and used to drop the
    // estimate under the floor and stop the run.
    h.warmer.notePromptTokens(4_096, "00000000");
    assert.equal(h.warmer.status().promptTokens, 150_000);
    await h.advance(216_000);
    assert.equal(h.requests.length, 1);

    // From the warmed context itself the number does apply — the already armed
    // timer still fires once, then the floor stops the run.
    h.warmer.notePromptTokens(4_096, h.template.ctx);
    assert.equal(h.warmer.status().promptTokens, 4_096);
    await h.advance(216_000);
    assert.equal(h.requests.length, 2);
    await h.advance(216_000 * 3);
    assert.equal(h.requests.length, 2);
    assert.match(h.warmer.status().reason ?? "", /under 20,000 tokens/);
  });

  it("records the context on a warm it did send", async () => {
    const h = harness();
    h.warmer.noteRequest(h.template);
    h.warmer.notePromptTokens(150_000, h.template.ctx);
    await h.advance(216_000);
    const logged = readCacheLog(h.logFile);
    assert.equal(logged.length, 1);
    assert.equal(logged[0].ctx, h.template.ctx);
    assert.equal(h.warmer.status().template?.ctx, h.template.ctx);
  });
});

// A replay sends the captured headers verbatim — `authorization` included — so
// a template that outlives its credential keeps spending a key the user has
// already replaced. The guard is in the engine, not in the caller: it is the
// last thing standing between an armed timer and a request nobody asked for.
describe("cache warmer credential guard", () => {
  it("never replays a template whose credential the process has replaced", async () => {
    let active: string | null = "sig-a";
    const h = harness({ cred: "sig-a", credential: () => active });
    h.warmer.noteRequest(h.template);
    h.warmer.notePromptTokens(150_000);
    assert.equal(h.warmer.status().running, true);

    active = "sig-b"; // /login swapped the Cloud key mid-session
    await h.advance(216_000);
    assert.equal(h.requests.length, 0, "the replaced key must not go out again");
    const st = h.warmer.status();
    assert.equal(st.running, false);
    assert.match(st.reason ?? "", /credential changed/);
    assert.equal(st.template, undefined);
    assert.equal(st.warms, 0, "a refused replay is not a warm…");
    assert.equal(st.failures, 0, "…and not a failure: nothing was sent");
    assert.deepEqual(readCacheLog(h.logFile), [], "it never reaches telemetry either");
    // Dropped, not merely skipped this once: "Warm now" agrees.
    assert.equal(await h.warmer.warmNow(), undefined);
    assert.equal(h.requests.length, 0);
    assert.equal(h.timers.length, 0);
  });

  it("treats a credential that is gone as a change too", async () => {
    let active: string | null = "sig-a";
    const h = harness({ cred: "sig-a", credential: () => active });
    h.warmer.noteRequest(h.template);
    h.warmer.notePromptTokens(150_000);
    active = null; // logged out while the engine was armed and nothing ran
    await h.advance(216_000);
    assert.equal(h.requests.length, 0);
    assert.match(h.warmer.status().reason ?? "", /credential changed/);
  });

  it("replays while the signature matches, and vetoes nothing it cannot compare", async () => {
    const matching = harness({ cred: "sig-a", credential: () => "sig-a" });
    matching.warmer.noteRequest(matching.template);
    matching.warmer.notePromptTokens(150_000);
    await matching.advance(216_000);
    assert.equal(matching.requests.length, 1);

    // No dep: this caller does not track credentials. No signature: a template
    // captured without one. A veto needs two known values to disagree.
    for (const opts of [{ cred: "sig-a" }, { credential: () => "sig-b" }]) {
      const h = harness(opts);
      h.warmer.noteRequest(h.template);
      h.warmer.notePromptTokens(150_000);
      await h.advance(216_000);
      assert.equal(h.requests.length, 1);
    }
  });

  it("resumes on the next real request, which carries the new credential", async () => {
    let active = "sig-a";
    const h = harness({ cred: "sig-a", credential: () => active });
    h.warmer.noteRequest(h.template);
    h.warmer.notePromptTokens(150_000);
    active = "sig-b";
    await h.advance(216_000);
    assert.equal(h.requests.length, 0);

    h.warmer.noteRequest({ ...h.template, cred: "sig-b", at: h.at() });
    h.warmer.notePromptTokens(150_000);
    assert.equal(h.warmer.status().running, true);
    await h.advance(216_000);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].init.headers?.authorization, "Bearer k");
  });
});
