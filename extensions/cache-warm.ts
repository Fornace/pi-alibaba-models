// Cache warming for Cloud sessions, owned by this extension.
//
// Why not pi's warmer: it is a *money* mechanism — a refresh is sent only when
// `p · missCost − warmCost ≥ $0.05`, it gives up for good when a timer fires
// more than ~5 % of the declared TTL late, and it stops 30 min after the last
// real request (60 min while streaming). Long sessions lose latency in exactly
// those gaps: a 150k–220k prompt takes 10–17 s from cache and 57–151 s cold
// (docs/notes/2026-10-07-long-session-cache-provider-data-and-options.md §3.4),
// and 10 of the 146 warms pi did send arrived after the block had expired.
//
// This engine replays the last provider request verbatim — same bytes, so the
// cached prefix matches — with a 16-token output cap, on a schedule derived
// from the measured 5-minute DashScope TTL rather than from a price list. It
// keeps warming for hours, retries instead of giving up, and records what the
// provider actually reported (`cached_tokens`, `cache_creation_input_tokens`),
// which pi cannot see because DashScope puts creation tokens in
// `usage.x_details[].prompt_tokens_details` only.
//
// What the provider reports is also the only evidence that a replay did
// anything, and for some models it reports nothing: on 2026-10-09 a
// deepseek-v4.1-flash context of 376 453 tokens was replayed 27 times over
// 1 h 37 m — every probe `cached_tokens: 0`, every probe a 22–50 s cold prefill,
// and no real request ever came back to use the block (docs/notes/
// 2026-10-11-cache-warm-blind-probes.md). `MAX_BLIND_WARMS` ends that: a replay
// that reports neither a hit worth the name nor a creation is blind, and three
// blind replays in a row stop the run until the next real request. qwen3.8-max
// and glm-5.3 never produce one (0 of 1 124 successful probes), so the guard is
// measured to be silent exactly where warming works.
//
// pi's own warmer is switched off for Cloud models while this engine runs, by
// not declaring `promptCache` (the only field pi's warmer reads). Mode `pi`
// hands warming back: the declaration returns and `warmingDecisionOverride`
// replaces pi's dollar gate with the same latency rule.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Measured DashScope explicit-cache lifetime: 5 minutes, reset on every hit. */
export const DASHSCOPE_CACHE_TTL_SECONDS = 300;
/** Output cap of a warm replay. pi-ai floors Responses output at 16 tokens. */
export const WARM_MAX_OUTPUT_TOKENS = 16;
/** A warm that has not answered by now is abandoned; the next one is on time. */
const WARM_TIMEOUT_MS = 180_000;
/** Consecutive failures after which warming stops until the next real request. */
const MAX_WARM_FAILURES = 4;
/** Consecutive blind replays after which warming stops: they renew nothing. */
export const MAX_BLIND_WARMS = 3;
/**
 * Below this share of the prompt a reported "hit" is only the first block or
 * two, with everything after it re-prefilled — blind in every way that matters.
 * The band is empty in four days of telemetry: the head-only deepseek-v4.1-flash
 * probes reported 0–1.09 % of the prompt, while every one of the 1 112 real hits
 * on qwen3.8-max-0902 and glm-5.3 was ≥ 99.98 % (2026-10-11).
 */
export const BLIND_HIT_FRACTION = 0.05;
/** Re-check delay while a provider request is in flight. */
const INFLIGHT_RETRY_MS = 2_000;

export type WarmMode = "off" | "pi" | "extension";

export interface WarmSettings {
  mode: WarmMode;
  /** Seconds between refreshes. Must stay clearly under the 5-minute TTL. */
  refreshSeconds: number;
  /** Keep warming this long after the last real request. */
  horizonMinutes: number;
  /** Below this prompt size a cold start is fast enough that warming is noise. */
  minPromptTokens: number;
  /** Append per-request cache telemetry to alibaba-cache.jsonl. */
  telemetry: boolean;
}

export const DEFAULT_WARM_SETTINGS: WarmSettings = {
  mode: "extension",
  refreshSeconds: 216,
  horizonMinutes: 240,
  minPromptTokens: 20_000,
  telemetry: true,
};

// A missing, non-numeric or out-of-range value falls back to the default; only
// a number inside the range is used. `0` is a legal value where the range says
// so (minPromptTokens), which is why this is not `Number(v) || dflt`.
const setting = (v: unknown, dflt: number, lo: number, hi: number): number => {
  if (v === undefined || v === null || v === "") return dflt;
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) return dflt;
  return Math.round(n);
};

/**
 * Config → settings. Unknown or out-of-range values fall back to the default
 * instead of throwing: a typo in alibaba-config.json must not disable warming
 * silently or break boot. `refreshSeconds` is limited to [60, 270] so a refresh
 * always lands inside the measured TTL with at least 30 s of margin.
 */
export function resolveWarmSettings(raw: {
  mode?: unknown;
  refreshSeconds?: unknown;
  horizonMinutes?: unknown;
  minPromptTokens?: unknown;
  telemetry?: unknown;
}): WarmSettings {
  const d = DEFAULT_WARM_SETTINGS;
  const mode: WarmMode = raw.mode === "off" || raw.mode === "pi" || raw.mode === "extension" ? raw.mode : d.mode;
  return {
    mode,
    refreshSeconds: setting(raw.refreshSeconds, d.refreshSeconds, 60, DASHSCOPE_CACHE_TTL_SECONDS - 30),
    horizonMinutes: setting(raw.horizonMinutes, d.horizonMinutes, 1, 24 * 60),
    minPromptTokens: setting(raw.minPromptTokens, d.minPromptTokens, 0, 5_000_000),
    telemetry: raw.telemetry === undefined ? d.telemetry : raw.telemetry !== false,
  };
}

/**
 * The `promptCache.short` value that makes pi refresh every `refreshSeconds`.
 * pi schedules at `min(0.9·ttl, ttl − 10s)`, which for any ttl > 100 s is
 * `0.9·ttl`, so the declaration is the interval divided by 0.9.
 */
export function declaredCacheTtlSeconds(refreshSeconds: number): number {
  return Math.max(20, Math.ceil(refreshSeconds / 0.9));
}

// ── Scheduling (pure) ───────────────────────────────────────────────────

/**
 * A replay that proves nothing: the provider reported neither a hit worth the
 * name nor a creation, so nothing says the block is alive for the next turn.
 */
export function isBlindWarm(
  cached: number | undefined,
  creation: number | undefined,
  promptTokens: number,
): boolean {
  if ((creation ?? 0) > 0) return false;
  const hit = cached ?? 0;
  if (hit <= 0) return true;
  return promptTokens > 0 && hit / promptTokens < BLIND_HIT_FRACTION;
}

export interface WarmState {
  /** When the last real provider request was dispatched (the block's birthday). */
  lastRequestAt: number;
  /** When this engine last dispatched a warm, if any. */
  lastWarmAt?: number;
  /** Prompt size of the last completed response; 0 until the first one lands. */
  promptTokens: number;
  /** A provider request is in flight — real or ours. */
  inFlight: boolean;
  /** Consecutive warm failures, for backoff. */
  failures: number;
  /** Consecutive replays that reported no renewal. */
  blind: number;
}

export type WarmPlan =
  | { action: "warm" }
  | { action: "wait"; delayMs: number }
  | { action: "stop"; reason: string };

/**
 * What to do now. Refreshes are measured from the last *renewal* (real request
 * or warm), so a slow warm shifts the schedule instead of stacking up. Failures
 * stretch the interval linearly up to 4× and end the run at MAX_WARM_FAILURES:
 * a warm that cannot get through is usually a rate limit, and hammering it
 * would delay the real request that follows.
 */
export function planWarm(state: WarmState, settings: WarmSettings, now: number): WarmPlan {
  if (state.inFlight) return { action: "wait", delayMs: INFLIGHT_RETRY_MS };
  if (state.failures >= MAX_WARM_FAILURES) return { action: "stop", reason: `${MAX_WARM_FAILURES} warm requests failed in a row` };
  // Not a failure — the provider answered 200 — but nothing came of it, and a
  // cold prefill of a 376k prompt every 216 s is quota the next real turn needs.
  if (state.blind >= MAX_BLIND_WARMS) {
    return { action: "stop", reason: `${MAX_BLIND_WARMS} warm replays renewed nothing` };
  }
  if (state.promptTokens <= 0) return { action: "stop", reason: "no prompt-size estimate yet" };
  if (state.promptTokens < settings.minPromptTokens) {
    return { action: "stop", reason: `prompt under ${settings.minPromptTokens.toLocaleString("en-US")} tokens` };
  }
  const horizonMs = settings.horizonMinutes * 60_000;
  const intervalMs = settings.refreshSeconds * 1_000 * (1 + Math.min(state.failures, 3));
  const lastRenewal = Math.max(state.lastRequestAt, state.lastWarmAt ?? 0);
  const due = lastRenewal + intervalMs;
  if (due - state.lastRequestAt > horizonMs) return { action: "stop", reason: `${settings.horizonMinutes}m horizon reached` };
  if (now - state.lastRequestAt > horizonMs) return { action: "stop", reason: `${settings.horizonMinutes}m horizon reached` };
  return now < due ? { action: "wait", delayMs: due - now } : { action: "warm" };
}

/**
 * Mode `pi`: replace pi's expected-savings gate with the latency rule. The
 * hook can only answer for a refresh pi already scheduled, so this never
 * extends pi's 30/60-minute caps — that is what mode `extension` is for.
 */
export function warmingDecisionOverride(
  settings: WarmSettings,
  promptTokens: number,
  event: { action: string },
): { action: "warm" | "stop" } | undefined {
  if (settings.mode !== "pi") return undefined;
  if (event.action === "warm") return undefined; // pi already agrees
  if (promptTokens >= settings.minPromptTokens && promptTokens > 0) return { action: "warm" };
  return undefined;
}

// ── Wire helpers (pure) ─────────────────────────────────────────────────

const trimEnd = (s: string): string => s.replace(/\/+$/, "");

/**
 * Endpoint of a warm replay. pi-ai posts through the OpenAI/Anthropic SDKs,
 * which append these paths to `model.baseUrl`; the same three suffixes are the
 * only provider-specific knowledge here.
 */
export function warmUrl(baseUrl: string | undefined, api: string): string | undefined {
  if (!baseUrl) return undefined;
  const base = trimEnd(baseUrl);
  if (api === "openai-responses") return `${base}/responses`;
  if (api === "openai-completions") return `${base}/chat/completions`;
  if (api === "anthropic-messages") return `${base}/v1/messages`;
  return undefined;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * The captured payload, turned into a cache-refresh request: everything that
 * forms the cached prefix stays byte-identical, only the generation cap and
 * streaming change. `thinking` is dropped on the Anthropic shape because its
 * budget must stay below `max_tokens`; a warm is a refresh, not an answer.
 */
export function buildWarmPayload(payload: unknown, api: string): Record<string, unknown> | undefined {
  if (!isRecord(payload)) return undefined;
  const out: Record<string, unknown> = { ...payload, stream: false };
  delete out.stream_options;
  if (api === "openai-responses") {
    out.max_output_tokens = WARM_MAX_OUTPUT_TOKENS;
    delete out.max_tokens;
  } else if (api === "anthropic-messages") {
    out.max_tokens = WARM_MAX_OUTPUT_TOKENS;
    delete out.thinking;
  } else {
    // Completions: pi-ai uses `max_completion_tokens` on newer models and
    // `max_tokens` elsewhere; setting a field the model rejects would 400.
    if ("max_completion_tokens" in out) out.max_completion_tokens = WARM_MAX_OUTPUT_TOKENS;
    else out.max_tokens = WARM_MAX_OUTPUT_TOKENS;
  }
  return out;
}

export interface CacheUsage {
  input?: number;
  output?: number;
  /** Tokens served from cache. */
  cached?: number;
  /** Tokens billed as a cache write (explicit mode only; DashScope reports it exactly). */
  creation?: number;
  cacheType?: string;
}

const firstDetail = (u: Record<string, unknown>): Record<string, unknown> | undefined => {
  const details = u.x_details;
  if (Array.isArray(details) && isRecord(details[0])) return details[0] as Record<string, unknown>;
  return undefined;
};

/**
 * Cache counters from a completed (non-streaming) response body. The three
 * Cloud shapes disagree on names, and the Responses shape hides creation
 * tokens one level deeper than pi-ai looks — which is why pi reports every
 * Cloud cache write as ordinary input.
 */
export function parseCacheUsage(api: string, body: unknown): CacheUsage {
  if (!isRecord(body)) return {};
  const usage = isRecord(body.usage) ? body.usage : undefined;
  if (!usage) return {};
  if (api === "anthropic-messages") {
    return {
      input: num(usage.input_tokens),
      output: num(usage.output_tokens),
      cached: num(usage.cache_read_input_tokens),
      creation: num(usage.cache_creation_input_tokens),
      cacheType: num(usage.cache_read_input_tokens) ? "ephemeral" : undefined,
    };
  }
  if (api === "openai-completions") {
    const details = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : undefined;
    return {
      input: num(usage.prompt_tokens),
      output: num(usage.completion_tokens),
      cached: num(details?.cached_tokens) ?? num(usage.cached_tokens),
      creation: num(details?.cache_creation_input_tokens),
      cacheType: str(details?.cache_type),
    };
  }
  // openai-responses
  const top = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : undefined;
  const detail = firstDetail(usage);
  const nested = detail && isRecord(detail.prompt_tokens_details) ? detail.prompt_tokens_details : undefined;
  return {
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cached: num(top?.cached_tokens) ?? num(nested?.cached_tokens),
    creation: num(nested?.cache_creation_input_tokens),
    cacheType: str(nested?.cache_type),
  };
}

/**
 * Cache counters from a raw provider stream event, for real turns: pi normalizes
 * usage before extensions see it and drops the creation fields, so the raw
 * event is the only place they exist.
 */
export function cacheFieldsFromStreamEvent(api: string, data: unknown): CacheUsage | undefined {
  if (!isRecord(data)) return undefined;
  if (api === "openai-responses") {
    if (data.type !== "response.completed" || !isRecord(data.response)) return undefined;
    const u = parseCacheUsage(api, data.response);
    return u.input === undefined && u.cached === undefined ? undefined : u;
  }
  if (api === "anthropic-messages") {
    if (data.type !== "message_start" || !isRecord(data.message)) return undefined;
    const u = parseCacheUsage(api, data.message);
    return u.input === undefined && u.cached === undefined ? undefined : u;
  }
  if (!isRecord(data.usage)) return undefined;
  const u = parseCacheUsage(api, { usage: data.usage });
  return u.input === undefined && u.cached === undefined ? undefined : u;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/**
 * Identity of the cached prefix: the head of the request, which is what the
 * provider's cache keys on. Two turns of one conversation share it; a child
 * agent, a sidecar call or a second session does not. Telemetry only — so it
 * stays cheap on a 500k-token payload by slicing every field it looks at
 * instead of hashing the whole thing.
 */
export function contextId(payload: unknown, api: string): string | undefined {
  if (!isRecord(payload)) return undefined;
  const head: string[] = [];
  const push = (v: unknown) => head.push(JSON.stringify(v ?? null).slice(0, 2_000));
  // The system prompt is the start of the cached prefix on all three shapes,
  // and `tools` are part of it for cache purposes (a tool-list change is a miss).
  push(api === "openai-responses" ? payload.instructions : payload.system);
  const msgs = api === "openai-responses" ? payload.input : payload.messages;
  if (Array.isArray(msgs)) for (const m of msgs.slice(0, 2)) push(m);
  if (Array.isArray(payload.tools)) push(payload.tools.map((t) => (isRecord(t) ? t.name : t)));
  if (head.every((h) => h === "null")) return undefined;
  return crypto.createHash("sha1").update(head.join("\u0000")).digest("hex").slice(0, 8);
}

// ── Telemetry log ───────────────────────────────────────────────────────

export interface CacheLogRecord {
  ts: number;
  kind: "turn" | "warm";
  provider: string;
  model: string;
  api: string;
  promptTokens: number;
  cached: number;
  creation: number;
  cacheType?: string;
  /** Prefix head this record belongs to (see `contextId`), when it could be derived. */
  ctx?: string;
  ms?: number;
  ok: boolean;
  note?: string;
}

const LOG_MAX_BYTES = 1_500_000;
const LOG_KEEP_LINES = 1_200;

/**
 * Append one record, trimming the file back to its tail when it grows past
 * ~1.5 MB. One stat per append is cheap next to a provider request, and the
 * trim keeps a fleet of long-lived sessions from growing the file forever.
 */
export function appendCacheLog(file: string, record: CacheLogRecord): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
    const size = fs.statSync(file).size;
    if (size <= LOG_MAX_BYTES) return;
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    fs.writeFileSync(file, `${lines.slice(-LOG_KEEP_LINES).join("\n")}\n`);
  } catch {
    // Telemetry must never break a turn.
  }
}

export function readCacheLog(file: string, limit = LOG_KEEP_LINES): CacheLogRecord[] {
  try {
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-limit);
    const out: CacheLogRecord[] = [];
    for (const line of lines) {
      try {
        const rec = JSON.parse(line) as CacheLogRecord;
        if (typeof rec?.ts === "number") out.push(rec);
      } catch {}
    }
    return out;
  } catch {
    return [];
  }
}

export interface CacheSummary {
  turns: number;
  turnHits: number;
  turnMisses: number;
  hitRatePct: number | null;
  cachedTokens: number;
  missedTokens: number;
  warms: number;
  warmHits: number;
  warmRewrites: number;
  /** Replays that reported no renewal: paid for, and nothing to show for it. */
  warmBlind: number;
  warmFailures: number;
  warmCachedTokens: number;
  first?: number;
  last?: number;
}

/** Roll-up for /alibaba → Status: what caching did, and what warming cost. */
export function summarizeCacheLog(records: CacheLogRecord[]): CacheSummary {
  const s: CacheSummary = {
    turns: 0, turnHits: 0, turnMisses: 0, hitRatePct: null,
    cachedTokens: 0, missedTokens: 0,
    warms: 0, warmHits: 0, warmRewrites: 0, warmBlind: 0, warmFailures: 0, warmCachedTokens: 0,
  };
  for (const r of records) {
    if (r.ts !== undefined) {
      s.first = s.first === undefined ? r.ts : Math.min(s.first, r.ts);
      s.last = s.last === undefined ? r.ts : Math.max(s.last, r.ts);
    }
    if (r.kind === "warm") {
      s.warms++;
      // A rewrite is only known when the provider reports creation tokens;
      // counting every hit-less probe as one hid the blind deepseek replays
      // behind a word that claims they did something.
      if (!r.ok) s.warmFailures++;
      else if (isBlindWarm(r.cached, r.creation, r.promptTokens)) s.warmBlind++;
      else if (r.cached > 0) { s.warmHits++; s.warmCachedTokens += r.cached; }
      else s.warmRewrites++;
      continue;
    }
    s.turns++;
    if (r.cached > 0) { s.turnHits++; s.cachedTokens += r.cached; }
    else { s.turnMisses++; s.missedTokens += Math.max(0, r.promptTokens); }
  }
  s.hitRatePct = s.turns ? Math.round((s.turnHits / s.turns) * 100) : null;
  return s;
}

// ── Engine ──────────────────────────────────────────────────────────────

/** The last real provider request, captured verbatim for replay. */
export interface WarmTemplate {
  provider: string;
  model: string;
  api: string;
  baseUrl?: string;
  headers: Record<string, string>;
  payload: unknown;
  at: number;
  /** Prefix head this request belongs to (see `contextId`), for telemetry. */
  ctx?: string;
  /**
   * Signature of the Cloud credential this request went out with (see
   * credential-watch.ts). A replay sends `headers` verbatim, `authorization`
   * included, so a template captured before a mid-session /login would keep
   * spending the key the user just replaced — the engine refuses it instead.
   */
  cred?: string | null;
}

export interface WarmResult {
  ok: boolean;
  status?: number;
  usage?: CacheUsage;
  error?: string;
  ms: number;
  /** True when the block had already expired and this request re-created it. */
  rewrote?: boolean;
}

export interface WarmStatus {
  running: boolean;
  reason?: string;
  nextWarmAt?: number;
  lastWarmAt?: number;
  lastResult?: WarmResult;
  template?: { model: string; api: string; at: number; ctx?: string };
  promptTokens: number;
  warms: number;
  hits: number;
  rewrites: number;
  /** Replays that reported no renewal, since the last real request. */
  blind: number;
  failures: number;
}

export interface CacheWarmerDeps {
  settings(): WarmSettings;
  logFile(): string;
  /**
   * The credential a replay must still match, signed the same way as
   * `WarmTemplate.cred`. No dep at all means "this caller does not track
   * credentials" and never vetoes; a dep that answers `null` means the
   * credential is *gone*, which vetoes a signed template like any other change.
   */
  credential?(): string | null | undefined;
  /** Debug sink; `ctx.log` in the extension. */
  log?(line: string): void;
  fetch?(url: string, init: RequestInit): Promise<Response>;
  now?(): number;
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(handle: unknown): void;
}

export interface CacheWarmer {
  noteRequest(t: WarmTemplate): void;
  /**
   * Prompt size of a completed response. `ctx` is the prefix head it belongs to:
   * a size from a *different* context — a child agent or a sidecar call in the
   * same process — says nothing about the block being warmed, and accepting it
   * can push the estimate under `minPromptTokens` and stop the run for the
   * context that matters.
   */
  notePromptTokens(n: number, ctx?: string): void;
  noteInFlight(v: boolean): void;
  /** Transcript changed shape (compaction, branch switch, new session). */
  invalidate(reason: string): void;
  stop(): void;
  status(): WarmStatus;
  warmNow(): Promise<WarmResult | undefined>;
}

/**
 * One warmer per pi process. Timers are unref'd and every failure path ends in
 * a stopped run, so a warm can never hold the process open or break a turn.
 */
export function createCacheWarmer(deps: CacheWarmerDeps): CacheWarmer {
  const now = () => (deps.now ? deps.now() : Date.now());
  const setTimer = deps.setTimeout ?? ((fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    (t as { unref?: () => void }).unref?.();
    return t;
  });
  const clearTimer = deps.clearTimeout ?? ((h: unknown) => clearTimeout(h as NodeJS.Timeout));
  const doFetch = deps.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));

  let template: WarmTemplate | undefined;
  let timer: unknown;
  let nextWarmAt: number | undefined;
  let stopped = "waiting for the first request";
  let inFlight = false;
  let promptTokens = 0;
  let failures = 0;
  let blind = 0;
  let lastWarmAt: number | undefined;
  let lastResult: WarmResult | undefined;
  let warms = 0;
  let hits = 0;
  let rewrites = 0;
  let warming = false;

  const state = (lastRequestAt: number): WarmState => ({
    lastRequestAt, lastWarmAt, promptTokens, inFlight, failures, blind,
  });

  const clear = () => {
    if (timer !== undefined) { clearTimer(timer); timer = undefined; }
    nextWarmAt = undefined;
  };

  const arm = () => {
    clear();
    if (!template || deps.settings().mode !== "extension") return;
    const plan = planWarm(state(template.at), deps.settings(), now());
    if (plan.action === "stop") { stopped = plan.reason; return; }
    const delayMs = plan.action === "wait" ? plan.delayMs : 0;
    nextWarmAt = now() + delayMs;
    timer = setTimer(() => void run(), delayMs);
  };

  async function run(): Promise<void> {
    timer = undefined;
    if (!template || warming) return;
    const t = template;
    const settings = deps.settings();
    if (settings.mode !== "extension") return;
    // The captured headers carry the credential pi resolved for that request.
    // If the process has since moved to another one — or dropped it — replaying
    // would spend a key the user replaced, against an endpoint that may not
    // accept it either. Drop the template instead of sending it.
    const active = deps.credential ? deps.credential() : undefined;
    if (t.cred && active !== undefined && t.cred !== active) {
      template = undefined;
      stopped = "the Cloud credential changed since the capture";
      return;
    }
    const url = warmUrl(t.baseUrl, t.api);
    const payload = buildWarmPayload(t.payload, t.api);
    if (!url || !payload) { stopped = "request cannot be replayed"; return; }
    warming = true;
    const started = now();
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), WARM_TIMEOUT_MS);
    timeout.unref?.();
    let result: WarmResult;
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: { ...t.headers, "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      const ms = now() - started;
      const body = await res.json().catch(() => undefined);
      const usage = parseCacheUsage(t.api, body);
      result = {
        ok: res.ok,
        status: res.status,
        usage,
        ms,
        error: res.ok ? undefined : `HTTP ${res.status}`,
        rewrote: res.ok && (usage.cached ?? 0) === 0 && (usage.creation ?? 0) > 0,
      };
    } catch (e: any) {
      result = { ok: false, ms: now() - started, error: e?.name === "AbortError" ? "timeout" : String(e?.message ?? e) };
    } finally {
      clearTimeout(timeout);
      warming = false;
    }
    warms++;
    lastWarmAt = started;
    lastResult = result;
    const blindProbe = result.ok
      && isBlindWarm(result.usage?.cached, result.usage?.creation, result.usage?.input ?? promptTokens);
    if (!result.ok) {
      failures++;
    } else if (blindProbe) {
      // Answered, and nothing to show for it: no hit worth the name, no creation.
      failures = 0;
      blind++;
    } else {
      failures = 0;
      blind = 0;
      if ((result.usage?.cached ?? 0) > 0) hits++;
      else if (result.rewrote) rewrites++;
    }
    deps.log?.(`[alibaba] cache warm ${t.model}: ${result.ok
      ? `${(result.usage?.cached ?? 0).toLocaleString("en-US")} cached, ${(result.usage?.creation ?? 0).toLocaleString("en-US")} created in ${Math.round(result.ms)}ms${blindProbe ? " (no renewal)" : ""}`
      : `failed (${result.error})`}`);
    if (settings.telemetry) {
      appendCacheLog(deps.logFile(), {
        ts: started, kind: "warm", provider: t.provider, model: t.model, api: t.api, ctx: t.ctx,
        promptTokens: result.usage?.input ?? promptTokens,
        cached: result.usage?.cached ?? 0, creation: result.usage?.creation ?? 0,
        cacheType: result.usage?.cacheType, ms: Math.round(result.ms), ok: result.ok,
        note: result.ok
          ? blindProbe ? "no renewal reported" : result.rewrote ? "rewrote expired block" : undefined
          : result.error,
      });
    }
    // The warm renewed the block (or re-created it), so the next one is a full
    // interval away even when this one ran late.
    if (template === t) arm();
  }

  return {
    noteRequest(t) {
      template = t;
      failures = 0;
      blind = 0;
      stopped = "";
      arm();
    },
    notePromptTokens(n, ctx) {
      if (template?.ctx && ctx && ctx !== template.ctx) return;
      promptTokens = Number.isFinite(n) && n > 0 ? n : promptTokens;
      if (template && !timer && !warming) arm();
    },
    noteInFlight(v) {
      inFlight = v;
      if (v) clear();
      else if (template && !timer && !warming) arm();
    },
    invalidate(reason) {
      clear();
      template = undefined;
      lastWarmAt = undefined;
      stopped = reason;
    },
    stop() {
      clear();
      stopped = "stopped";
    },
    status() {
      return {
        running: !!timer || warming,
        reason: stopped || undefined,
        nextWarmAt: timer === undefined ? undefined : nextWarmAt,
        lastWarmAt,
        lastResult,
        template: template ? { model: template.model, api: template.api, at: template.at, ctx: template.ctx } : undefined,
        promptTokens,
        warms, hits, rewrites, blind, failures,
      };
    },
    async warmNow() {
      if (!template) return undefined;
      clear();
      await run();
      return lastResult;
    },
  };
}
