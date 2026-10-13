import { getAgentDir, type ExtensionAPI, type ProviderModelConfig as PiModelConfig, type ExtensionCommandContext, VERSION } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { assertSingleInstall, findPackageRoot } from "./duplicate-guard.ts";
import {
  buildImageModels,
  DEFAULT_IMAGE_MODEL,
  filterCuratedImageModels,
  generateDashScopeImages,
  IMAGE_API,
  parseImageCatalog,
  type ImageCatalogRow,
} from "./image.ts";
import { registerImageTool, runImageCommand, type ImageToolDeps } from "./image-tool.ts";
import {
  ALIBABA_NAMESPACE,
  ALIBABA_TOOLS_ANNOTATIONS,
  ALIBABA_TOOLS_OUTPUT_SCHEMA,
  type RegisterToolDef,
  type ToolResult,
  type ToolUpdate,
} from "./tool-presentation.ts";
import { classifyStreamError, rewriteFromStreamError, type StreamErrorClass } from "./stream-errors.ts";
import {
  convertCost,
  DEFAULT_CNY_PER_USD,
  DEFAULT_TIER_TOKENS,
  declareCacheCost,
  formatCacheEconomics,
  parseCatalogPrices,
  type CatalogPrices,
  type CatalogPriceRange,
} from "./prices.ts";
import {
  appendCacheLog,
  cacheFieldsFromStreamEvent,
  contextId,
  createCacheWarmer,
  DASHSCOPE_CACHE_TTL_SECONDS,
  declaredCacheTtlSeconds,
  DEFAULT_WARM_SETTINGS,
  readCacheLog,
  resolveWarmSettings,
  summarizeCacheLog,
  warmingDecisionOverride,
  type CacheWarmer,
  type CacheUsage,
  type WarmMode,
  type WarmSettings,
} from "./cache-warm.ts";
import { injectCacheControl } from "./cache-control.ts";
import {
  buildEquivalenceIndex,
  resolveContextWindow,
  resolveOutputCap,
  type CatalogLimits,
} from "./model-limits.ts";
import {
  ALIBABA_TOOLS_PARAMETERS,
  buildSidecarRequest,
  dashScopeErrorMessage,
  formatSidecarProgress,
  formatSidecarResult,
  formatSidecarRetry,
  pickSidecarModel,
  rewriteDashScopeBackendOverflowMessage,
  rewriteDashScopeRateLimitErrorMessage,
  runSidecarWithRetry,
  type SidecarAction,
  type SidecarStrategy,
} from "./sidecar.ts";

// pi 1.0.0 turned the legacy `ProviderModelConfig` into a discriminated union
// (chat | image | classifier). Chat-only fields — `compat`, `promptCache`,
// `reasoning`, `contextWindow`, `maxTokens`, `thinkingLevelMap` — are reachable
// only through the chat member, so the catalog types work against it; `type`
// stays unset, which pi reads as "chat". Image entries use the union's image
// member (`ImageModelConfig` in image.ts). The host floor is pi 1.0.0 (ADR-0001),
// so `Extract` is safe — the pre-1.0.0 exclusion this replaced is gone. Why an
// alias at all (the host exports the union, never its members) is measured in
// docs/notes/2026-10-11-host-model-config-export-surface.md.
type ChatModelConfig = Extract<PiModelConfig, { type?: "chat" }>;

// ── Paths ─────────────────────────────────────────────────────────────
// Resolve through pi's own getAgentDir() so a relocated config directory
// (PI_CODING_AGENT_DIR, e.g. Nix/Guix store paths) is honored. Hardcoding
// ~/.pi/agent here made the extension miss /login credentials and scrub the
// wrong settings.json under an override.
const HOME_DIR = getAgentDir();

// This copy's own package directory, so the duplicate guard can tell "the
// other copy" apart from "me". extensionPath is not exposed to factories, but
// extension files always sit in <packageRoot>/extensions/, so the manifest one
// directory up identifies us. Resolved once — the module is a singleton.
const resolveOwnPackageDir = (): string | null => {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const root = findPackageRoot(here);
    if (!root) return null;
    try { return fs.realpathSync(root); } catch { return root; }
  } catch {
    return null;
  }
};
const CONFIG_PATH = path.join(HOME_DIR, "alibaba-config.json");
// This copy's own version, read from the manifest so a message cannot go stale:
// the host-floor error below hardcoded it and still said 2.1.1 when the package
// had shipped 2.1.2.
const SELF_VERSION = ((): string => {
  try {
    const root = resolveOwnPackageDir();
    if (!root) return "pi-alibaba-models";
    const v = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))?.version;
    return typeof v === "string" && v ? `pi-alibaba-models ${v}` : "pi-alibaba-models";
  } catch {
    return "pi-alibaba-models";
  }
})();

const AUTH_PATH = path.join(HOME_DIR, "auth.json");
// Private, versioned catalog snapshot (the "plan C" hybrid): it fills provider
// registration at boot with zero network and keeps the extension independent
// of pi's models-store semantics. pi's store stays as a bonus channel.
const CATALOG_CACHE_PATH = path.join(HOME_DIR, "alibaba-models.cache.json");
// Prompt-cache telemetry: one JSON line per turn and per warm, written by the
// warming engine and read back by /alibaba → Status and Cache statistics.
const CACHE_LOG_PATH = path.join(HOME_DIR, "alibaba-cache.jsonl");
// Model catalogs live in pi's own models store: `refreshModels` returns them,
// pi persists the snapshot and hands it back as `context.stored` for
// offline/cache-only initialization. The extension's own cache files are gone
// — these names survive only so upgrades and "Reset all" can delete leftovers.
const LEGACY_CACHE_PATHS = [
  path.join(HOME_DIR, "alibaba-plan-models.cache.json"),
  path.join(HOME_DIR, "alibaba-cloud-models.cache.json"),
  path.join(HOME_DIR, "alibaba-cloud-models.cache.v2.json"),
];
const removeLegacyCaches = () => {
  for (const p of LEGACY_CACHE_PATHS) { try { fs.unlinkSync(p); } catch {} }
};

// ── Thinking levels (measured against the live endpoint) ─────────────
//
// pi reads `thinkingLevelMap` as a tristate (verified against pi 0.87's
// clampThinkingLevel/getSupportedThinkingLevels): a string is the effort sent
// to the provider, `null` hides the level, and a request for a hidden level is
// routed to the nearest supported one (upward first). `xhigh`/`max` are only
// offered when they carry an explicit key.
//
// Everything below was probed against the workspace endpoint on 2026-09-22:
//   • the Anthropic path splits `maxTokens` into a thinking budget plus the
//     answer, so each model's own catalog ceiling is used (never an
//     id-based guess — the endpoint rejects anything larger).
//   • the OpenAI paths send `reasoning_effort` (some models also require
//     `enable_thinking`), and each family accepts a different subset.

// Anthropic path. DashScope rejects `thinking_budget` for Kimi alone
// (`Parameter thinking_budget is not supported`) — `--thinking off` still sends
// the field, so kimi must not be flagged as reasoning at all (see
// Fornace/pi-alibaba-models#9).
//
// `off` must be a *string*, not `null`: pi serializes `--thinking off` as
// `thinking: {type: "disabled"}` only when `thinkingLevelMap.off` is non-null
// (anthropic-messages path); with `null` the level is unsupported and pi
// clamps "off" up to a real thinking level. The `off` string itself is never
// sent — pi derives the thinking budget from the selected level's name.

type Level = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type Levels = Record<string, string | null>;
const LEVELS: Level[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

// A level map listing only the literals a family really accepts; anything
// else is `null`, so pi hides it and routes a request for it to the nearest
// accepted level. Explicit strings express a documented coercion instead.
const levels = (accepted: Partial<Record<Level, string>>): Levels =>
  Object.fromEntries(LEVELS.map((l) => [l, accepted[l] ?? null])) as Levels;

const ANTHROPIC_ALL_LEVELS = levels({
  off: "off", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max",
});

const DEFAULT_PLAN_OPENAI = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";
const DEFAULT_PLAN_ANTHROPIC = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic";
const DEFAULT_CLOUD_DOMAIN = "dashscope-intl.aliyuncs.com";
// Since 1.5.0 Responses is the default Cloud wire format (session-cache
// economics, agent-native features, no Anthropic budget squeeze). An unset
// cloudApiFormat is pinned to this at registration so an install keeps one
// stable, explicit choice instead of silently following future default flips.
const DEFAULT_CLOUD_FORMAT: CloudApiFormat = "openai-responses";
const DEFAULT_CLOUD_US_DOMAIN = "dashscope-us.aliyuncs.com";
const DEFAULT_CLOUD_CN_DOMAIN = "dashscope.aliyuncs.com";
const DEFAULT_CLOUD_HK_DOMAIN = "cn-hongkong.dashscope.aliyuncs.com";

// Workspace-specific domains (recommended for Beijing/Singapore; required for
// Japan/Frankfurt/US). {wsid} = the Model Studio business-space ID.
const workspaceDomain = (wsid: string, region: string) => `${wsid}.${region}.maas.aliyuncs.com`;
const WSID_BEIJING = "cn-beijing";
const WSID_SINGAPORE = "ap-southeast-1";
const WSID_TOKYO = "ap-northeast-1";
const WSID_FRANKFURT = "eu-central-1";
const WSID_US = "us-east-1";

type CloudApiFormat = "anthropic-messages" | "openai-completions" | "openai-responses";

// ── Config / auth helpers ─────────────────────────────────────────────
interface AlibabaConfig {
  planOpenAI?: string;
  planAnthropic?: string;
  cloudDomain?: string;
  cloudApiFormat?: CloudApiFormat;
  // Session-cache header for Cloud Responses requests (x-dashscope-session-
  // cache). Default on: writes are billed at 125% of input and re-reads at
  // ~10%, so multi-turn agent sessions win big while one-shot prompts pay a
  // small premium. Set false for one-shot-heavy usage.
  cloudSessionCache?: boolean;
  // Override the context-window shown on a model's card in the picker.
  // Keyed by exact model id (e.g. "qwen3.7-plus"); the special key "*" applies
  // to every model that has no explicit entry. Values are token counts.
  // Useful when the inferred size is wrong for a brand-new model.
  contextWindowOverrides?: Record<string, number>;
  // When true (default), the Cloud catalog is filtered to the models the
  // account is authorized to call (GET /api/v1/models/permissions) whenever
  // that endpoint is reachable. Set to false to always show the full catalog.
  cloudAuthorizedOnly?: boolean;
  // Opt-in Pi tool `alibaba_tools`: a sidecar POST to DashScope built-in
  // tools (web_search / extractor / interpreter). Legacy boolean replaced by
  // `alibabaToolsExposure`; read once at boot to migrate (false → "off").
  cloudSidecarTools?: boolean;
  // Optional Cloud model id for the sidecar (Qwen only). Empty = pick from catalog.
  cloudSidecarModel?: string;
  // How `alibaba_tools` is exposed to the model. Default "codemode" (callable
  // from codemode scripts, not declared every turn); "off" means not registered.
  alibabaToolsExposure?: AlibabaToolExposure;
  // How `alibaba_image` is exposed. Default "codemode"; "off" disables it.
  alibabaImageExposure?: AlibabaToolExposure;
  // Default DashScope image model for `alibaba_image` and the `/alibaba image`
  // subcommand. Empty = pick the recommended family present in the catalog.
  imageModel?: string;
  // Auto-upgrade a shared regional Cloud domain (dashscope.aliyuncs.com,
  // dashscope-intl…, dashscope-us…) to Alibaba's recommended workspace domain
  // {WorkspaceId}.{region}.maas.aliyuncs.com once the WorkspaceId has been
  // discovered AND the candidate domain passes a live probe. Default true;
  // explicitly picking a shared domain in /alibaba → Cloud — Change Domain
  // sets it to false (opt-out) so the upgrade never fights a manual choice.
  cloudAutoWorkspaceDomain?: boolean;
  // WorkspaceId discovered via GET /api/v1/models/limits (cached; also the
  // placeholder/fallback of the manual workspace-domain prompt).
  cloudWorkspaceId?: string;
  // Timestamp of the last failed auto-probe; retried at most once per 24h.
  cloudWorkspaceProbeFailedAt?: number;
  // Fingerprint (sha256, 16 hex chars) of the Cloud key the endpoint config was
  // last derived from. A mismatch with the active key triggers the
  // default→corporate re-derivation (see the Cloud key binding section).
  cloudKeyFingerprint?: string;
  // Status-only metadata about the last successful catalog fetch (pi's models
  // store keeps the catalogs themselves).
  planFetchedAt?: number;
  cloudFetchedAt?: number;
  cloudAuthorizedFilteredLast?: boolean;
  // ── Prompt cache ────────────────────────────────────────────────────
  // Cache warming for Cloud sessions; see extensions/cache-warm.ts for why the
  // default is an engine of our own rather than pi's. Absent = defaults
  // (`extension`, 216 s refresh, 4 h horizon, 20k-token floor, telemetry on).
  cacheWarm?: {
    mode?: "off" | "pi" | "extension";
    refreshSeconds?: number;
    horizonMinutes?: number;
    minPromptTokens?: number;
    telemetry?: boolean;
  };
  // Inject `cache_control: {type: "ephemeral"}` on the Chat Completions shape
  // for models whose catalog rows include explicit-cache prices. Default true.
  cloudCacheControl?: boolean;
  // Unit of the declared `cost.*` numbers. The catalog bills CNY per million
  // while pi labels them dollars: "cny" (default) keeps the console's numbers,
  // "usd" converts at `cnyPerUsd`.
  costCurrency?: "cny" | "usd";
  cnyPerUsd?: number;
  // Prompt size used to pick a price tier for the 43 tiered catalog models
  // (default 128k), and whether a model with separate thinking-mode prices is
  // billed as thinking (default true — pi runs reasoning models with a level).
  priceTierTokens?: number;
  priceThinkingOutput?: boolean;
  // The Responses endpoint silently truncates input above ~80% of the context
  // window; declaring the usable size makes pi compact before that happens.
  // Default true.
  responsesInputGuard?: boolean;
}

// How one of the two Alibaba tools is exposed to the model. `codemode` is the
// default: callable from codemode scripts and listed there, but not declared
// on every request. `off` means the tool is not registered at all.
export type AlibabaToolExposure = "codemode" | "direct" | "deferred" | "off";

const TOOL_EXPOSURES: AlibabaToolExposure[] = ["codemode", "direct", "deferred", "off"];

// The single human-facing label per exposure, shared by every menu that sets
// one (no second list to keep in step with TOOL_EXPOSURES).
export const TOOL_EXPOSURE_LABELS: Record<AlibabaToolExposure, string> = {
  codemode: "codemode — callable from scripts, not declared every turn (default)",
  direct: "direct — declared to the model on every turn",
  deferred: "deferred — reachable through tool search",
  off: "off — not registered, costs nothing",
};

// pi 1.0.0 is the host floor (ADR-0001): the model-config union, tool
// `exposure`, and `provider_stream_event` this release relies on do not exist
// before it. Pi's packaging guidance keeps `peerDependencies` at `*`, so the
// floor is enforced here instead of only documented.
export function hostVersionSupported(version: string | undefined): boolean {
  if (!version) return true; // unknown version: do not block
  const major = version.match(/^(\d+)\./)?.[1];
  return major === undefined ? true : Number(major) >= 1;
}

export function isToolExposure(v: unknown): v is AlibabaToolExposure {
  return typeof v === "string" && (TOOL_EXPOSURES as string[]).includes(v);
}

// The two tools' effective exposure: an unknown/missing value is the default
// `codemode` (registered, callable from codemode scripts, not declared every
// turn). `off` is the only value that skips registration.
export function resolveToolsExposure(cfg: AlibabaConfig): AlibabaToolExposure {
  return isToolExposure(cfg.alibabaToolsExposure) ? cfg.alibabaToolsExposure : "codemode";
}
export function resolveImageExposure(cfg: AlibabaConfig): AlibabaToolExposure {
  return isToolExposure(cfg.alibabaImageExposure) ? cfg.alibabaImageExposure : "codemode";
}

// The 1.5.x `cloudSidecarTools` boolean is replaced by the exposure vocabulary:
// an explicit `false` (the old opt-out) becomes `off`, and the legacy key is
// dropped. Returns true when it changed the config, so the caller can persist.
export function migrateToolExposure(cfg: AlibabaConfig): boolean {
  let dirty = false;
  if (cfg.alibabaToolsExposure === undefined && cfg.cloudSidecarTools === false) {
    cfg.alibabaToolsExposure = "off";
    dirty = true;
  }
  if (cfg.cloudSidecarTools !== undefined) {
    delete cfg.cloudSidecarTools;
    dirty = true;
  }
  return dirty;
}

const readJSON = <T>(p: string, fallback: T): T => {
  try { return JSON.parse(fs.readFileSync(p, "utf8")) as T; } catch { return fallback; }
};
const writeJSON = (p: string, data: unknown) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // Atomic replace: 30 pi instances share these files and a torn JSON would
  // break everyone. Write a private tmp file, then rename over the target.
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, p);
};
const loadConfig = (): AlibabaConfig => readJSON<AlibabaConfig>(CONFIG_PATH, {});
const saveConfig = (c: AlibabaConfig) => writeJSON(CONFIG_PATH, c);
// auth.json entries: api_key ({type,key}) or oauth ({type,access,refresh,expires}).
interface AuthEntry {
  type?: string;
  key?: string;
  access?: string;
  refresh?: string;
  expires?: number;
}
const readAuth = (): Record<string, AuthEntry> => readJSON<Record<string, AuthEntry>>(AUTH_PATH, {});
const writeAuth = (a: Record<string, AuthEntry>) => writeJSON(AUTH_PATH, a);

// pi used to expose ctx.modelRegistry.authStorage (in-memory + disk). Newer
// public types dropped it; keep using it when present so /login's
// "configured" label stays in sync, otherwise write auth.json directly.
interface AuthStorageLike {
  remove(id: string): void;
  get(id: string): AuthEntry | undefined;
  set(id: string, entry: AuthEntry): void;
}
function authStore(ctx: ExtensionCommandContext): AuthStorageLike {
  const live = (ctx.modelRegistry as { authStorage?: AuthStorageLike }).authStorage;
  if (live) return live;
  return {
    remove(id) { const a = readAuth(); delete a[id]; writeAuth(a); },
    get(id) { return readAuth()[id]; },
    set(id, entry) { const a = readAuth(); a[id] = entry; writeAuth(a); },
  };
}

// ── Plan model definitions ────────────────────────────────────────────
// Anthropic-compatible by default; deepseek forced to openai-completions.
interface PlanModelDef {
  id: string; name: string; reasoning: boolean; contextWindow: number;
  input: ("text" | "image")[]; compat?: { thinkingFormat: "qwen" }; openaiOnly?: boolean;
  // A real `max_output_tokens` if a Plan source ever reports one — none does
  // today (bare ids from /compatible-mode/v1/models), so resolveMaxTokens()
  // falls back to the conservative pair for these models.
  catalogMaxTokens?: number;
}

// ── Plan model fetch + parse ──────────────────────────────────────────

// ── Capability heuristics (shared by Plan + Cloud) ───────────────────
// The /models API only returns ids/names, not capabilities — so context
// window, reasoning, and vision are inferred from the id. Both the Plan
// and Cloud code paths route through these helpers so they never drift
// apart. Context windows are corrected here as new models ship.
export const isVisionModel = (id: string): boolean =>
  /vl|vision/i.test(id) || /^qwen3\.\d+-plus\b/i.test(id) || /^qwen3\.8\b/i.test(id) || /kimi/i.test(id);

// Whether a model accepts thinking controls at all. Named families answer
// through their capability row (the single source of truth); exotic ids fall
// back to the naming heuristic. The catalog's `Reasoning` tag is deliberately
// ignored — the /api/v1/models tag is unreliable in both directions (it marks
// `qwen-turbo` as reasoning even though the id accepts no thinking controls,
// and lists plain `qwen3-30b-a3b` without the tag although it answers with
// reasoning), so callers must never OR it back in. Roleplay `-character`
// variants of any family take no thinking controls. The Anthropic path is
// lenient — every family except Kimi accepts `thinking_budget` — so a miss
// here only costs the thinking picker.
const REASONING_HEURISTIC =
  /qwq|max|thinking|deepseek|minimax|glm|stepfun|unisound|^qwen3-\d|^qwen-(plus|flash)(-|$)|3\.[5-9]/i;

export const isReasoningModel = (id: string): boolean =>
  !/^kimi/i.test(id) &&
  !/-character/i.test(id) &&
  (capsFor(id).reasoning ?? REASONING_HEURISTIC.test(id));

// Infer context window (tokens) from model id. Sources:
// https://www.alibabacloud.com/help/en/model-studio/models
// https://www.alibabacloud.com/help/en/model-studio/glm
const inferContextWindow = (id: string, overrides?: Record<string, number>): number => {
  const o = overrides?.[id] ?? overrides?.["*"];
  if (typeof o === "number" && o > 0) return o;

  // Third-party models
  if (/^glm-?5\.2\b/i.test(id)) return 1048576;
  if (/^glm/i.test(id)) return 202752;
  if (/deepseek-?v4/i.test(id)) return 1048576;
  if (/^deepseek/i.test(id)) return 131072;
  if (/kimi/i.test(id)) return 262144;
  if (/minimax-?m2\.5/i.test(id)) return 196608;
  if (/minimax-?m2\.1/i.test(id)) return 204800;
  if (/minimax/i.test(id)) return 196608;

  // Qwen 3.7+: all 1M. Qwen 3.5/3.6: plus/flash = 1M, max/open-weight = 256K.
  if (/^qwen3\.([7-9]|\d{2,})\b/i.test(id)) return 1048576;
  if (/^qwen3\.[56]\b/i.test(id)) return /(plus|flash)/i.test(id) ? 1048576 : 262144;

  return 131072;
};

// Infer the maxTokens card value from the model id.
//
// pi's Anthropic path splits maxTokens into a thinking budget plus the answer
// (maxTokens − thinkingBudget). The safe value is the catalog's own
// `max_output_tokens`, which is per-model and already known to the endpoint
// (qwen-plus = 32768, qwen3-coder-plus = 65536, qwen3-30b-a3b = 8192,
// qwen3.8-max = 131072). Sending a larger number is rejected with
// `Range of max_tokens should be [1, N]`, so the catalog value is never
// exceeded. Models with no catalog row fall back to the conservative pair.
export const ANTHROPIC_MAX_TOKENS = 131072;
export const inferAnthropicMaxTokens = (id: string, catalogMax?: number): number => {
  if (typeof catalogMax === "number" && Number.isFinite(catalogMax) && catalogMax > 0) {
    return Math.min(catalogMax, ANTHROPIC_MAX_TOKENS);
  }
  // No catalog row: stay under every ceiling we know of. The open-weight
  // qwen3-<size>b line is measured at 8192 (qwen3-30b-a3b rejects more).
  if (/^qwen3-\d+b(-|$)/i.test(id)) return 8192;
  return isReasoningModel(id) ? 32768 : 8192;
};

// Catalog / OpenAI-path ceilings. Used for Chat Completions and Responses —
// those APIs do not share max_tokens between thinking and the answer the way
// Anthropic-compat does. Do not use these on the Anthropic path.
export const inferOpenAIMaxTokens = (id: string): number => {
  if (/^kimi-k?3/i.test(id)) return 1048576;
  if (/^deepseek-?v4/i.test(id)) return 384000;
  if (/^qwen3\.\d+-max\b/i.test(id)) return 131072;
  if (/^glm-?5\.2\b/i.test(id)) return 131072;
  if (/^glm-?5\.1\b/i.test(id)) return 128000;
  if (/^glm-?5\b/i.test(id)) return 16384;
  if (/^qwen3\./i.test(id)) return 65536;
  if (/^kimi-k2\.([6-9]|\d{2,})/i.test(id)) return 262144;
  if (/^kimi/i.test(id)) return 98304;
  if (/^minimax/i.test(id)) return 32768;
  return 16384;
};

// The one place a card's `maxTokens` is decided — shared by the Plan and
// Cloud builders so they cannot drift apart (they used to be twins and did).
// `catalogMax` is a *real* `max_output_tokens` from the catalog, or 0/
// undefined when the catalog has no row for the model: a guessed ceiling is
// never passed in as one, because DashScope rejects overshoots outright with
// `Range of max_tokens should be [1, N]`. Plan defs carry no catalog rows
// today, so they take the conservative fallback below.
export function resolveMaxTokens(id: string, api: string, catalogMax?: number): number {
  const catalog = typeof catalogMax === "number" && Number.isFinite(catalogMax) && catalogMax > 0
    ? catalogMax
    : undefined;
  return api === "anthropic-messages"
    ? inferAnthropicMaxTokens(id, catalog)
    : (catalog ?? inferOpenAIMaxTokens(id));
}

// Also shared by both builders: compatible-mode rejects the `developer` role
// (`developer is not one of ['system', ...]`) and has no `store` field, so
// both are forced off there and left untouched on the Anthropic path.
function mergeCompat(
  base: object | undefined,
  tc: ThinkingConfig | undefined,
  openai: boolean,
): ChatModelConfig["compat"] {
  return openai
    ? {
        ...(base ?? {}),
        ...(tc?.compat ?? {}),
        supportsDeveloperRole: false,
        supportsStore: false,
      } as ChatModelConfig["compat"]
    : ((tc?.compat ?? base) as ChatModelConfig["compat"]);
}

// Every card capability is derived from the id here (plus real catalog or
// context-window rows), so a snapshot re-served from pi's store is re-derived
// too — extension updates and the user's context-window overrides apply
// without waiting for the next network fetch. Pure: overrides come from the
// caller, never from disk.
function deriveCard(
  id: string,
  m: { input?: ("text" | "image")[]; contextWindow?: number },
  overrides?: Record<string, number>,
) {
  const override = overrides?.[id] ?? overrides?.["*"];
  const vision = isVisionModel(id) || m.input?.includes("image");
  return {
    reasoning: isReasoningModel(id),
    input: (vision ? ["text", "image"] : ["text"]) as ("text" | "image")[],
    contextWindow: typeof override === "number" && override > 0
      ? override
      : (m.contextWindow && m.contextWindow > 0 ? m.contextWindow : inferContextWindow(id, overrides)),
  };
}

// ── Per-family capability table ──────────────────────────────────────
// Chat Completions (`reasoning_effort`, plus `enable_thinking` on the `qwen`
// thinking format) and Responses (`reasoning.effort`) accept a different
// subset per family. Measured 2026-09-22 with a *per-model*
// `max_completion_tokens` — probing with a budget above a model's own ceiling
// returns `Range of max_tokens…` and looks like a rejected effort. Accepted
// literals per family ("none" = thinking can be switched off):
//
//   qwen3.8                    none minimal low medium high xhigh max
//   qwen3.7/3.6/3.5            none minimal low medium high xhigh
//   qwen3-max / -coder / next  none minimal low medium high xhigh max
//   qwen-plus/flash/turbo      none minimal low medium high xhigh max
//   qwen3.8-2.4t / 3.7-preview            minimal low medium high xhigh max
//   glm-5.3                               low             high      max
//   glm-5.2 / glm-4.x          none minimal low medium high xhigh max
//   glm-5.1 / glm-5            none minimal low medium high xhigh
//   deepseek-v4-pro/flash                 low medium high xhigh max
//   deepseek-v4.1-*           none minimal low medium high xhigh max
//   kimi-k3                    none minimal low medium high xhigh max
//   kimi-k2.5/2.6/2.7          none minimal low medium high xhigh
//   MiniMax-M2.5                          low medium high xhigh
//   MiniMax-M2.1               none minimal low medium high xhigh max
//
// "Accepted" is not "distinct": the docs document the coercions explicitly
// for some families (deepseek-v4-pro/flash: low/medium → high, xhigh → max;
// deepseek-v4.1: minimal → low, medium/xhigh → high; glm-5.3: medium → high,
// xhigh → max — help.aliyun.com/…/deepseek-api, …/glm). Where they do, the
// map lists only the distinct literals and hides the coerced ones, so pi's
// own clamp routes a request to exactly the documented effort.
//
// `off` is a separate mechanism per path. Completions: pi sends
// `enable_thinking: false` (the map's `off` value is never sent), and
// `off: null` hides the level for families that reject the field — MiniMax,
// which switches thinking through `thinking.type: "adaptive" | "disabled"`,
// a parameter pi's OpenAI paths never emit. Responses: pi sends
// `reasoning: {effort: <off value>}`, so `off` is the literal `"none"`
// wherever thinking can be disabled at all.
const L_ALL = levels({ off: "none", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" });
const L_NO_MAX = levels({ off: "none", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh" });
const L_ALWAYS_ON = levels({ minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" });
const L_DEEPSEEK_V4 = levels({ high: "high", max: "max" });
const L_DEEPSEEK_V41 = levels({ off: "none", low: "low", high: "high", max: "max" });
const L_GLM53 = levels({ low: "low", high: "high", max: "max" });
const L_MINIMAX25 = levels({ low: "low", medium: "medium", high: "high", xhigh: "xhigh" });
const L_MEDIUM_CEILING = levels({ off: "none", minimal: "minimal", low: "low", medium: "medium" });
const L_NONE_ONLY = levels({ off: "none" });

// Responses accepts the same effort subset as Completions per family (the
// docs point back to the Chat Completions table), with `off` expressible as
// the literal effort "none" wherever thinking can be switched off at all.
// Only families measured *narrower* on Responses carry an explicit override.
const responsesFrom = (completions: Levels): Levels => ({
  ...completions,
  off: completions.off ? "none" : null,
});

interface FamilyCaps {
  /** Present on named families; exotic ids fall back to REASONING_HEURISTIC. */
  reasoning?: boolean;
  completions: Levels;
  /** false → the family rejects `reasoning_effort` outright (GLM-4.5). */
  effort?: boolean;
  /** Narrower than the derived Responses map (measured); else derived. */
  responses?: Levels;
  /** /responses can serve this family at all (measured 2026-09-22). */
  responsesCapable?: boolean;
  /** DashScope prompt caching documented for this family. */
  cache?: boolean;
}

// One row per family — the single place a new family or snapshot touches.
// Order matters: the first match wins, most specific id first.
const FAMILIES: Array<[RegExp, FamilyCaps]> = [
  [/^qwen3\.8-2\.4t/i, { reasoning: true, completions: L_ALWAYS_ON, responsesCapable: true, cache: true }],
  [/^qwen3\.7-max-(preview|\d{4}-\d{2}-\d{2})/i, { reasoning: true, completions: L_ALWAYS_ON, responsesCapable: true, cache: true }],
  [/^qwen3\.8/i, { reasoning: true, completions: L_ALL, responsesCapable: true, cache: true }],
  [/^qwen3\.7-(max|plus)/i, { reasoning: true, completions: L_NO_MAX, responsesCapable: true, cache: true }],
  [/^qwen3\.[5-7]/i, { reasoning: true, completions: L_NO_MAX, responses: L_MEDIUM_CEILING, responsesCapable: true, cache: true }],
  [/^qwen3-max|^qwen3-(coder|next)/i, { reasoning: true, completions: L_ALL, responsesCapable: true, cache: true }],
  // Open-weight qwen3-<size>b: no prompt caching documented (qwen3-30b-a3b).
  [/^qwen3-\d/i, { reasoning: true, completions: L_ALL, responsesCapable: true }],
  [/^qwen-(plus|flash)(-|$)/i, { reasoning: true, completions: L_ALL, responses: L_NONE_ONLY, responsesCapable: true, cache: true }],
  [/^qwen-turbo(-|$)/i, { reasoning: false, completions: L_ALL, responses: L_NONE_ONLY, responsesCapable: true, cache: true }],
  [/^glm-?5\.3/i, { reasoning: true, completions: L_GLM53, responsesCapable: true, cache: true }],
  [/^glm-?5\.2/i, { reasoning: true, completions: L_ALL, responsesCapable: true, cache: true }],
  [/^glm-?4\.6/i, { reasoning: true, completions: L_ALL, responsesCapable: true, cache: true }],
  [/^glm-?4\.5/i, { reasoning: true, completions: L_ALL, effort: false, responses: L_ALWAYS_ON, cache: true }],
  [/^glm-?5\.1|^glm-?5\b/i, { reasoning: true, completions: L_NO_MAX, cache: true }],
  [/^glm/i, { reasoning: true, completions: L_ALL, cache: true }],
  [/^deepseek-?v4\.1/i, { reasoning: true, completions: L_DEEPSEEK_V41, responsesCapable: true, cache: true }],
  [/^deepseek-?v4/i, { reasoning: true, completions: L_DEEPSEEK_V4, responsesCapable: true, cache: true }],
  [/^deepseek-?v3\.1/i, { reasoning: true, completions: L_ALL, responsesCapable: true, cache: true }],
  [/^deepseek/i, { reasoning: true, completions: L_ALL, cache: true }],
  [/^minimax-?m2\.5/i, { reasoning: true, completions: L_MINIMAX25, cache: true }],
  [/^minimax-?m2\.1/i, { reasoning: true, completions: L_ALWAYS_ON, responsesCapable: true, cache: true }],
  [/^minimax/i, { reasoning: true, completions: L_ALL, cache: true }],
  [/^kimi-k3/i, { reasoning: false, completions: L_ALL, responsesCapable: true, cache: true }],
  [/^kimi/i, { reasoning: false, completions: L_NO_MAX, cache: true }],
];

const DEFAULT_CAPS: FamilyCaps = { completions: L_ALL };
function capsFor(id: string): FamilyCaps {
  for (const [match, caps] of FAMILIES) if (match.test(id)) return caps;
  return DEFAULT_CAPS;
}

// DashScope prompt caching (help.aliyun.com/zh/model-studio/context-cache):
// implicit caching is on for these families, and the explicit
// `cache_control: {type: "ephemeral"}` window is 5 minutes, renewed on a hit —
// no longer tier is published (measured: docs/notes/2026-10-07-dashscope-cache-
// ttl-and-warming.md). `long` stays unset — there is no published 1h-class
// lifetime. The open-weight qwen3-<size>b line has no caching at all and
// unknown families stay ineligible.
//
// `promptCache` is the *only* field pi's cache warmer reads, so it is also the
// switch between warming engines: mode `pi` declares the TTL whose 0.9·ttl
// schedule reproduces the configured refresh interval, while `extension` (the
// default) and `off` declare nothing and pi's warmer stays out of the way —
// two engines refreshing the same block would only burn quota.
const promptCacheFor = (id: string, warm: WarmSettings): ChatModelConfig["promptCache"] => {
  if (!capsFor(id).cache || warm.mode !== "pi") return undefined;
  return { short: declaredCacheTtlSeconds(warm.refreshSeconds) };
};

// Plan keeps pi's own warmer: this extension's engine captures Cloud requests
// only (its replay depends on DashScope's measured TTL and on the Cloud
// credential), so the Plan card still declares the 5-minute lifetime.
const planPromptCacheFor = (id: string): ChatModelConfig["promptCache"] =>
  capsFor(id).cache ? { short: DASHSCOPE_CACHE_TTL_SECONDS } : undefined;

const OPENAI_BASE_COMPAT = {
  thinkingFormat: "qwen" as const,
  supportsDeveloperRole: false,
  supportsStore: false,
};

export interface ThinkingConfig {
  thinkingLevelMap: Record<string, string | null>;
  compat: {
    thinkingFormat: "qwen";
    supportsReasoningEffort?: boolean;
    supportsDeveloperRole?: boolean;
    supportsStore?: boolean;
  };
}

export function thinkingConfigFor(id: string, api: string): ThinkingConfig | undefined {
  if (!isReasoningModel(id)) return undefined;
  const caps = capsFor(id);
  if (api === "openai-completions") {
    return {
      thinkingLevelMap: { ...caps.completions },
      compat: { ...OPENAI_BASE_COMPAT, ...(caps.effort === false ? {} : { supportsReasoningEffort: true }) },
    };
  }
  if (api === "openai-responses") {
    return {
      thinkingLevelMap: { ...(caps.responses ?? responsesFrom(caps.completions)) },
      compat: { ...OPENAI_BASE_COMPAT },
    };
  }
  // Anthropic-compatible: pi derives the thinking budget from the level name,
  // so every level stays selectable and `--thinking off` serializes as
  // `thinking: {type: "disabled"}` (see ANTHROPIC_ALL_LEVELS).
  return { thinkingLevelMap: { ...ANTHROPIC_ALL_LEVELS }, compat: { thinkingFormat: "qwen" } };
}

// Cloud models the Responses endpoint cannot serve (measured 2026-09-22).
// When the user picks the Responses Cloud format, models outside this set stay
// on Chat Completions instead of being exposed and then 400ing on send.
// Families are matched by id so brand-new snapshots inherit the behaviour.
export function supportsCloudResponses(id: string): boolean {
  return capsFor(id).responsesCapable === true;
}

export function resolveCloudApi(id: string, fmt: CloudApiFormat): CloudApiFormat {
  if (fmt === "anthropic-messages" && /deepseek/i.test(id)) return "openai-completions";
  if (fmt === "openai-responses" && !supportsCloudResponses(id)) return "openai-completions";
  return fmt;
}

// Heuristic: turn a bare model id (from /v1/models API) into a full PlanModelDef.
function inferPlanDef(id: string, overrides?: Record<string, number>): PlanModelDef {
  const openaiOnly = /deepseek/i.test(id);
  const isVision = isVisionModel(id);
  const isReasoning = isReasoningModel(id);
  return {
    id,
    name: prettyName(id),
    reasoning: isReasoning,
    input: isVision ? ["text", "image"] : ["text"],
    contextWindow: inferContextWindow(id, overrides),
    compat: isReasoning ? { thinkingFormat: "qwen" } : undefined,
    openaiOnly,
  };
}

// Primary source: the Plan endpoint's own /compatible-mode/v1/models.
async function fetchPlanModelsFromAPI(credentials?: { access?: string; refresh?: string }): Promise<PlanModelDef[]> {
  const key = credentials?.access;
  if (!key) return [];
  const ep = resolvePlanEndpoints(credentials);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`${ep.openai}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { data?: { id: string }[] };
    if (!json.data?.length) throw new Error("No models in response");
    // Filter out image/audio/etc — only keep chat-capable models.
    const exclude = /(image|audio|video|tts|asr|embed|vector|rerank|wan|omni|livetranslate|realtime)/i;
    const overrides = loadConfig().contextWindowOverrides;
    return json.data
      .filter((m) => !exclude.test(m.id))
      .map((m) => inferPlanDef(m.id, overrides));
  } finally { clearTimeout(t); }
}

function prettyName(id: string): string {
  // qwen3.6-plus → "Qwen 3.6 Plus", glm-5 → "GLM-5", MiniMax-M2.5 → "MiniMax M2.5"
  if (/^qwen/i.test(id)) {
    return id.replace(/^qwen/i, "Qwen ").replace(/-/g, " ").replace(/\b([a-z])/g, (s) => s.toUpperCase());
  }
  if (/^glm/i.test(id)) return id.toUpperCase();
  if (/^kimi/i.test(id)) return id.replace(/^kimi/i, "Kimi").replace(/-/g, " ");
  if (/^minimax/i.test(id)) return id.replace(/-/g, " ");
  if (/^deepseek/i.test(id)) return id.replace(/^deepseek/i, "DeepSeek").replace(/-/g, " ");
  return id;
}

async function fetchPlanModels(_force = false, credentials?: { access?: string; refresh?: string }): Promise<PlanModelDef[]> {
  if (!credentials?.access) return [];
  const apiModels = await fetchPlanModelsFromAPI(credentials);
  if (!apiModels.length) throw new Error("Plan model fetch returned no chat models");
  return apiModels;
}

// ── Plan endpoint resolution ──────────────────────────────────────────
function resolvePlanEndpoints(credentials?: { access?: string; refresh?: string }): { openai: string; anthropic: string } {
  if (credentials?.refresh) {
    try {
      const parsed = JSON.parse(credentials.refresh);
      if (parsed.openai && parsed.anthropic) return { openai: parsed.openai, anthropic: parsed.anthropic };
    } catch {}
  }
  const cfg = loadConfig();
  return {
    openai: cfg.planOpenAI || DEFAULT_PLAN_OPENAI,
    anthropic: cfg.planAnthropic || DEFAULT_PLAN_ANTHROPIC,
  };
}

export function buildPlanModels(
  defs: PlanModelDef[],
  openaiUrl: string,
  anthropicUrl: string,
  overrides?: Record<string, number>,
): ChatModelConfig[] {
  return defs.map((m) => {
    const useOpenAI = !!m.openaiOnly || /deepseek/i.test(m.id);
    const api = (useOpenAI ? "openai-completions" : "anthropic-messages") as "anthropic-messages" | "openai-completions";
    const tc = thinkingConfigFor(m.id, api);
    return {
      id: m.id, name: m.name,
      ...deriveCard(m.id, m, overrides),
      maxTokens: resolveMaxTokens(m.id, api, m.catalogMaxTokens),
      promptCache: planPromptCacheFor(m.id),
      compat: mergeCompat(m.compat, tc, useOpenAI),
      thinkingLevelMap: tc?.thinkingLevelMap,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      baseUrl: useOpenAI ? openaiUrl : anthropicUrl,
      api,
    };
  });
}

// ── Cloud builders ────────────────────────────────────────────────────

interface ApiV1Model {
  model: string;
  name?: string;
  capabilities?: string[];
  inference_metadata?: { request_modality?: string[]; response_modality?: string[] };
  model_info?: {
    context_window?: number | null;
    max_input_tokens?: number | null;
    max_output_tokens?: number | null;
    max_reasoning_tokens?: number | null;
    reasoning_max_input_tokens?: number | null;
    reasoning_max_output_tokens?: number | null;
  };
  equivalent_snapshot?: string | null;
  prices?: CatalogPriceRange[];
}

// What the native catalog told us about one Cloud model, kept raw: prices and
// size limits. Both are policy inputs, not declarations — the declared `cost`
// depends on the session-cache header, the Completions markers and the currency
// setting, and the declared `contextWindow` on the wire shape, all of which can
// change without a refetch.
export interface CatalogEntry {
  prices?: CatalogPrices;
  limits?: CatalogLimits;
  /** The catalog's own `equivalent_snapshot`: the dated twin of an alias. */
  equivalent?: string;
}
const cloudCatalog = new Map<string, CatalogEntry>();
// Alias ↔ dated snapshot, both directions, so a measurement of one covers the
// other. Rebuilt whenever the catalog map is filled.
let cloudEquivalent = new Map<string, string>();

function rebuildEquivalenceIndex() {
  cloudEquivalent = buildEquivalenceIndex(
    [...cloudCatalog.entries()].map(([id, entry]) => [id, entry.equivalent] as [string, string | undefined]),
  );
}

/** Price rows of one catalog model, or undefined when the catalog had none. */
export const cloudPricesFor = (id: string): CatalogPrices | undefined => cloudCatalog.get(id)?.prices;

/** Size limits (`model_info`) of one catalog model, when the catalog carried them. */
export const cloudLimitsFor = (id: string): CatalogLimits | undefined => cloudCatalog.get(id)?.limits;

const positiveOrNull = (v: number | null | undefined): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;

function catalogEntryOf(m: ApiV1Model): CatalogEntry {
  const info = m.model_info ?? {};
  return {
    equivalent: typeof m.equivalent_snapshot === "string" && m.equivalent_snapshot ? m.equivalent_snapshot : undefined,
    limits: {
      contextWindow: positiveOrNull(info.context_window),
      maxInput: positiveOrNull(info.max_input_tokens),
      reasoningMaxInput: positiveOrNull(info.reasoning_max_input_tokens),
      maxOutput: positiveOrNull(info.max_output_tokens),
      reasoningMaxOutput: positiveOrNull(info.reasoning_max_output_tokens),
    },
  };
}

export function applyAuthorizedFilter<T extends { id: string }>(
  models: T[],
  authorized: Set<string> | null,
): { models: T[]; authorizedOnly: boolean } {
  if (!authorized) return { models, authorizedOnly: false };
  const filtered = models.filter((m) => authorized.has(m.id));
  if (!filtered.length) return { models, authorizedOnly: false };
  return { models: filtered, authorizedOnly: true };
}

async function fetchCloudModelsV1(domain: string, apiKey: string): Promise<ChatModelConfig[] | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const models: ChatModelConfig[] = [];
    const exclude = /(image|audio|video|tts|asr|embed|vector|rerank|wan|omni|livetranslate|realtime|3d|face)/i;
    const cfg = loadConfig();
    for (let page = 1; page <= 5; page++) {
      const params = new URLSearchParams({ capabilities: "TG", page_no: String(page), page_size: "100" });
      const res = await fetch(`https://${domain}/api/v1/models?${params}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { output?: { total?: number; models?: ApiV1Model[] } };
      const output = json.output;
      if (!output?.models?.length) break;
      const overrides = cfg.contextWindowOverrides;
      for (const m of output.models) {
        if (!m.model || exclude.test(m.model)) continue;
        const caps = m.capabilities ?? [];
        const reqMod = m.inference_metadata?.request_modality ?? [];
        const ctx = m.model_info?.context_window;
        const maxOut = m.model_info?.max_output_tokens;
        const prices = parseCatalogPrices(m.prices, {
          tierTokens: cfg.priceTierTokens,
          thinkingOutput: cfg.priceThinkingOutput !== false,
        });
        const entry = catalogEntryOf(m);
        if (prices.input > 0 || prices.output > 0) entry.prices = prices;
        cloudCatalog.set(m.model, entry);
        models.push({
          id: m.model,
          name: m.name || m.model,
          // The catalog's `Reasoning` tag is deliberately ignored (see
          // isReasoningModel) — OR-ing it in reintroduces its false positives
          // (`qwen-turbo`) and its misses (`qwen3-30b-a3b`).
          reasoning: isReasoningModel(m.model),
          input: isVisionModel(m.model) || reqMod.includes("Image") || caps.includes("VU")
            ? (["text", "image"] as ("text" | "image")[])
            : (["text"] as ("text" | "image")[]),
          // Raw CNY here; buildCloudModels applies the cache and currency policy
          // at registration time, so a setting change needs no refetch.
          cost: { input: prices.input, output: prices.output, cacheRead: 0, cacheWrite: 0 },
          contextWindow: typeof ctx === "number" && ctx > 0 ? ctx : inferContextWindow(m.model, overrides),
          // 0 = "the catalog has no max_output_tokens row". A guessed ceiling
          // must never masquerade as a catalog value here — resolveMaxTokens
          // treats one as authoritative and DashScope rejects overshoots.
          maxTokens: typeof maxOut === "number" && maxOut > 0 ? maxOut : 0,
        });
      }
      if (models.length >= (output.total ?? 0) || output.models.length < 100) break;
    }
    rebuildEquivalenceIndex();
    return models.length ? models : null;
  } catch {
    return null;
  } finally { clearTimeout(t); }
}

async function fetchCloudModelsCompat(domain: string, apiKey: string): Promise<ChatModelConfig[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(`https://${domain}/compatible-mode/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { data?: { id: string; name?: string }[] };
    if (!json.data?.length) throw new Error("No models");
    const exclude = /(image|audio|video|tts|asr|embed|vector|rerank|wan|omni|livetranslate|realtime)/i;
    const overrides = loadConfig().contextWindowOverrides;
    return json.data
      .filter((m) => !exclude.test(m.id))
      .map((m) => {
        const isVision = isVisionModel(m.id);
        const isReasoning = isReasoningModel(m.id);
        return {
          id: m.id,
          name: m.name || m.id,
          reasoning: isReasoning,
          input: isVision ? (["text", "image"] as ("text" | "image")[]) : (["text"] as ("text" | "image")[]),
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: inferContextWindow(m.id, overrides),
          // compatible-mode /v1/models carries no catalog rows at all.
          maxTokens: 0,
        };
      });
  } finally { clearTimeout(t); }
}

async function fetchCloudAuthorizedModels(domain: string, apiKey: string): Promise<Set<string> | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const authorized = new Set<string>();
    for (let page = 1; page <= 5; page++) {
      const params = new URLSearchParams({
        authorization_scope: "AUTHORIZED",
        action: "INFERENCE",
        page_no: String(page),
        page_size: "200",
      });
      const res = await fetch(`https://${domain}/api/v1/models/permissions?${params}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      const json = (await res.json()) as {
        output?: {
          total?: number;
          permissions?: Array<{ model?: string; permissions?: { inference?: boolean } }>;
        };
      };
      const output = json.output;
      if (!output?.permissions?.length) break;
      for (const p of output.permissions) {
        if (p.model && p.permissions?.inference) authorized.add(p.model);
      }
      if (output.permissions.length < 200) break;
    }
    return authorized.size ? authorized : null;
  } catch {
    return null;
  } finally { clearTimeout(t); }
}

async function fetchCloudModels(domain: string, apiKey: string, _force = false): Promise<{ models: ChatModelConfig[]; authorizedOnly: boolean }> {
  const v1 = await fetchCloudModelsV1(domain, apiKey);
  if (v1) {
    let models = v1;
    let authorizedOnly = false;
    if (loadConfig().cloudAuthorizedOnly !== false) {
      const authorized = await fetchCloudAuthorizedModels(domain, apiKey);
      const filtered = applyAuthorizedFilter(models, authorized);
      models = filtered.models;
      authorizedOnly = filtered.authorizedOnly;
    }
    return { models, authorizedOnly };
  }
  return { models: await fetchCloudModelsCompat(domain, apiKey), authorizedOnly: false };
}

// A separate fetch from the chat catalogue: the chat fetch deliberately
// excludes image ids by pattern and the Sidecar's model picker must keep
// receiving chat ids only. `capabilities=IG` is the same endpoint and auth the
// chat catalogue uses; the curated filter runs where the cards are built.
async function fetchCloudImageModels(domain: string, apiKey: string): Promise<ImageCatalogRow[] | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const rows: ImageCatalogRow[] = [];
    for (let page = 1; page <= 5; page++) {
      const params = new URLSearchParams({ capabilities: "IG", page_no: String(page), page_size: "100" });
      const res = await fetch(`https://${domain}/api/v1/models?${params}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { output?: { total?: number } };
      const pageRows = parseImageCatalog(json);
      if (!pageRows.length) break;
      rows.push(...pageRows);
      if (rows.length >= (json.output?.total ?? 0) || pageRows.length < 100) break;
    }
    return rows.length ? rows : null;
  } catch {
    return null;
  } finally { clearTimeout(t); }
}

interface ApiV1QuotaLimit {
  request_limit?: number | null;
  request_limit_period?: number | null;
  usage_limit?: number | null;
  usage_limit_field?: string | null;
  usage_limit_period?: number | null;
  async_user_queue_limit?: number | null;
  async_user_concurrency_limit?: number | null;
}

export interface CloudQuotaInfo {
  model: string;
  modelLimit: ApiV1QuotaLimit;
  hasWorkspaceLimit: boolean;
}

async function fetchCloudQuotas(domain: string, apiKey: string): Promise<Map<string, CloudQuotaInfo> | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const map = new Map<string, CloudQuotaInfo>();
    let total = Infinity;
    for (let page = 1; page <= 5 && map.size < total; page++) {
      const params = new URLSearchParams({ page_no: String(page), page_size: "100" });
      const res = await fetch(`https://${domain}/api/v1/models/limits?${params}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      const json = (await res.json()) as {
        output?: {
          total?: number;
          quotas?: Array<{ model: string; model_limit?: ApiV1QuotaLimit | null; workspace_limit?: ApiV1QuotaLimit | null }>;
        };
      };
      const output = json.output;
      if (!output?.quotas?.length) break;
      total = output.total ?? total;
      for (const q of output.quotas) {
        if (!q.model || !q.model_limit) continue;
        map.set(q.model, { model: q.model, modelLimit: q.model_limit, hasWorkspaceLimit: !!q.workspace_limit });
      }
      if (output.quotas.length < 100) break;
    }
    return map.size ? map : null;
  } catch {
    return null;
  } finally { clearTimeout(t); }
}

export function formatQuota(q: CloudQuotaInfo): string {
  const l = q.modelLimit;
  let s = `${l.request_limit ?? 0} ${l.request_limit_period === 1 ? "req/s" : `req/${l.request_limit_period ?? 60}s`}`;
  if (l.usage_limit != null && l.usage_limit_field && l.usage_limit_period != null) {
    s += `; ${l.usage_limit.toLocaleString("en-US")} ${l.usage_limit_field}/per-${l.usage_limit_period}s`;
  } else {
    s += "; usage: none";
  }
  if (l.async_user_queue_limit != null || l.async_user_concurrency_limit != null) {
    s += `; async queue ${l.async_user_queue_limit ?? "—"} / concurrency ${l.async_user_concurrency_limit ?? "—"}`;
  }
  if (q.hasWorkspaceLimit) s += "; workspace-limit set";
  return s;
}

function cloudDefaultTransport(domain: string, fmt: CloudApiFormat): { api: CloudApiFormat; baseUrl: string } {
  const api = fmt === "anthropic-messages" ? "anthropic-messages" : fmt;
  return {
    api,
    baseUrl: api === "anthropic-messages"
      ? `https://${domain}/apps/anthropic`
      : `https://${domain}/compatible-mode/v1`,
  };
}

// How many registered Cloud models would NOT ride the selected wire format.
// Surfaced in /alibaba → Status: with Responses as the default, silent
// per-model fallbacks to Chat Completions are otherwise invisible. Pure.
export function countFallbackModels(models: { id: string }[], fmt: CloudApiFormat): number {
  return models.filter((m) => resolveCloudApi(m.id, fmt) !== fmt).length;
}

/** Everything `buildCloudModels` needs that is not the catalog itself. */
export interface CloudModelBuildOptions {
  domain: string;
  fmt: string;
  overrides?: Record<string, number>;
  /** Session-cache header on Responses requests. Default true. */
  sessionCache?: boolean;
  /** `cache_control` markers on Completions requests. Default true. */
  cacheControl?: boolean;
  /** Warming settings; only `mode`/`refreshSeconds` reach the model card. */
  warm?: WarmSettings;
  /** Unit of the declared `cost.*`. Default "cny" (what the console bills). */
  currency?: "cny" | "usd";
  cnyPerUsd?: number;
  /** Raw catalog rows (prices + size limits); defaults to the last fetch. */
  catalog?: ReadonlyMap<string, CatalogEntry>;
  /** Alias ↔ snapshot links matching `catalog`; defaults to the fetched index. */
  equivalents?: ReadonlyMap<string, string>;
  /**
   * Declare the shape's effective input cap instead of the catalog window.
   * Default true; turning it off re-declares the full window and accepts the
   * Responses endpoint's silent middle-truncation.
   */
  responsesInputGuard?: boolean;
}

/**
 * Which cache the wire will use for one model on one shape: the session-cache
 * header on Responses, pi-ai's own `cache_control` injection on the Anthropic
 * shape, our markers on Completions. Declaring the wrong pair would misprice
 * every turn — reads at 8.3 % vs 12.5 %, writes at 125 % vs 100 %.
 */
export function explicitCacheActive(api: string, sessionCache: boolean, cacheControl: boolean): boolean {
  if (api === "anthropic-messages") return true;
  if (api === "openai-responses") return sessionCache;
  return cacheControl;
}

/**
 * Whether a model has a prompt cache to keep alive. The catalog's price rows
 * are the machine-readable answer — a model with no `input_token_cache*` row has
 * nothing to warm (the open-weight `qwen3-<size>b` line) — and the family table
 * is the fallback for a boot served from the compatible-mode listing, which
 * carries no rows at all.
 *
 * Measured per family on 2026-10-07 (`docs/notes/…-cache-families.md`):
 * explicit caching on qwen3.x, glm-5.1, kimi-k2.5/k2.6/k2.7-code and
 * deepseek-v3.2; implicit on glm-4.6/5.2/5.3, kimi-k3, deepseek-v4.x and
 * MiniMax-M2.1 — the last only above ~4k tokens, which the default 20k prompt
 * floor already clears.
 */
export function modelCachesPrompt(
  id: string,
  catalog: ReadonlyMap<string, CatalogEntry> = cloudCatalog,
): boolean {
  const p = catalog.get(id)?.prices;
  if (p) return p.explicitCache || p.implicitRead > 0;
  return capsFor(id).cache === true;
}

export function buildCloudModels(
  models: ChatModelConfig[],
  opts: CloudModelBuildOptions,
): ChatModelConfig[] {
  const format = (opts.fmt as CloudApiFormat) || DEFAULT_CLOUD_FORMAT;
  const domain = opts.domain;
  const sessionCache = opts.sessionCache !== false;
  const cacheControl = opts.cacheControl !== false;
  const warm = opts.warm ?? DEFAULT_WARM_SETTINGS;
  const catalog = opts.catalog ?? cloudCatalog;
  const currency = opts.currency === "usd" ? "usd" : "cny";
  const guard = opts.responsesInputGuard !== false;
  return models.map((m) => {
    const api = resolveCloudApi(m.id, format);
    const tc = thinkingConfigFor(m.id, api);
    const openai = api !== "anthropic-messages";
    const card = deriveCard(m.id, m, opts.overrides);
    const entry = catalog.get(m.id);
    const raw = entry?.prices;
    // Which cache the wire will actually use, per shape: the header on
    // Responses, pi-ai's own `cache_control` injection on the Anthropic shape,
    // our markers on Completions. Declaring the wrong pair would misprice every
    // turn — reads at 8.3% vs 12.5%, writes at 125% vs 100%.
    const explicit = !!raw?.explicitCache && explicitCacheActive(api, sessionCache, cacheControl);
    // Without catalog rows (compatible-mode fallback, login seed) the fetch-time
    // numbers stand; recomputing them from nothing would zero a stored cost.
    const cost = raw
      ? convertCost(
          { input: raw.input, output: raw.output, ...declareCacheCost(raw, explicit) },
          currency,
          opts.cnyPerUsd ?? DEFAULT_CNY_PER_USD,
        )
      : m.cost;
    // What the endpoint actually accepts on this shape, which is not the
    // catalog's context window: Completions/Anthropic 400 above a per-model cap,
    // Responses silently truncates above a different one (see model-limits.ts).
    const win = resolveContextWindow(m.id, api, entry?.limits, card.contextWindow, {
      override: opts.overrides?.[m.id] ?? opts.overrides?.["*"],
      responsesGuard: guard,
      equivalent: opts.catalog === undefined ? cloudEquivalent.get(m.id) : opts.equivalents?.get(m.id),
    });
    // `reasoning_max_output_tokens` is a hard ceiling while thinking is on
    // (qwen3-max rejects the 65 536 its own catalog row advertises with `Range
    // of max_tokens should be [1, 32768]`), and a card cannot express "unless
    // the level is off" — so the lower of the two is declared.
    const outputCap = resolveOutputCap(entry?.limits, m.maxTokens);
    return {
      ...m,
      ...card,
      contextWindow: win.window,
      cost,
      maxTokens: resolveMaxTokens(m.id, api, outputCap ?? 0),
      promptCache: promptCacheFor(m.id, warm),
      thinkingLevelMap: tc?.thinkingLevelMap,
      compat: mergeCompat(m.compat, tc, openai),
      // DashScope's session cache makes multi-turn prefix hits predictable on
      // Responses (5-min window renewed on hit, reads billed at 8.3% instead of
      // the implicit cache's indeterminate TTL and 12.5–25% reads) and is opt-in
      // per request. Models re-routed to Completions get markers instead (see
      // cache-control.ts), and cloudSessionCache=false strips the header
      // entirely (one-shot-heavy usage: writes cost 125% of input and may never
      // be re-read).
      headers: api === "openai-responses" && sessionCache ? { "x-dashscope-session-cache": "enable" } : undefined,
      baseUrl: openai ? `https://${domain}/compatible-mode/v1` : `https://${domain}/apps/anthropic`,
      api,
    };
  });
}

// ── Cloud credential resolution ──────────────────────────────────────
// The Cloud provider can authenticate either from a key saved via /login
// (auth.json) OR from the DASHSCOPE_API_KEY env var (its apiKey is
// "$DASHSCOPE_API_KEY"). Either one lets us fetch the real catalog — so we
// always prefer the live list and only fall back to the login seed below
// when there is no credential at all.
const readCloudKey = (): string | null => {
  try {
    const c = readAuth()["alibaba-cloud"];
    const k = c?.key || c?.access;
    if (k) return k;
  } catch {}
  return process.env.DASHSCOPE_API_KEY || null;
};

// ── Workspace-domain auto-upgrade ────────────────────────────────────
// Alibaba recommends migrating from the shared regional domains to workspace
// domains {WorkspaceId}.{region}.maas.aliyuncs.com (better performance and
// stability; the rate-limit and permissions endpoints are documented there).
// The docs call the WorkspaceId console-only, but the key's workspace is
// empirically discoverable: GET /api/v1/models/limits returns `workspace_id`
// on every quota row — even on the shared domains where the endpoint itself
// is undocumented. Discovery is best-effort and never trusted blindly: the
// candidate domain must pass a live probe before the config is switched.

const SHARED_DOMAIN_REGIONS: Record<string, string> = {
  [DEFAULT_CLOUD_CN_DOMAIN]: WSID_BEIJING,
  [DEFAULT_CLOUD_DOMAIN]: WSID_SINGAPORE,
  [DEFAULT_CLOUD_US_DOMAIN]: WSID_US,
};

// Regions that have workspace domains {wsid}.{region}.maas.aliyuncs.com.
const WORKSPACE_REGIONS: string[] = [WSID_BEIJING, WSID_SINGAPORE, WSID_TOKYO, WSID_FRANKFURT, WSID_US];

// Reverse of SHARED_DOMAIN_REGIONS — where to rediscover the workspace from
// when a configured workspace domain stops accepting the current key (the key
// may have been swapped between runs for one from another region/site). Tokyo
// and Frankfurt have no shared domain — they are workspace-only regions.
export const REGION_SHARED_DOMAINS: Record<string, string> = {
  [WSID_BEIJING]: DEFAULT_CLOUD_CN_DOMAIN,
  [WSID_SINGAPORE]: DEFAULT_CLOUD_DOMAIN,
  [WSID_US]: DEFAULT_CLOUD_US_DOMAIN,
};

// Parse an already-configured workspace domain — used to tell “nothing to do,
// you are on one” apart from “this domain never auto-upgrades” (HK/custom).
export function parseWorkspaceCloudDomain(domain: string): { wsid: string; region: string } | null {
  const m = domain.trim().toLowerCase().match(/^([a-z0-9][a-z0-9-]{2,63})\.([a-z0-9-]+)\.maas\.aliyuncs\.com$/);
  if (!m) return null;
  const wsid = sanitizeWorkspaceId(m[1]);
  if (!wsid || !WORKSPACE_REGIONS.includes(m[2])) return null;
  return { wsid, region: m[2] };
}

// Region a shared domain belongs to, or null for anything else. Hong Kong,
// custom hosts, and workspace domains themselves are never auto-upgraded
// (Tokyo/Frankfurt have no shared domain — they are workspace-only).
export const regionForSharedCloudDomain = (domain: string): string | null =>
  SHARED_DOMAIN_REGIONS[domain.trim().toLowerCase()] ?? null;

// The WorkspaceId is interpolated into a hostname, so accept only
// conservative characters (real ids look like `llm-n9h5iz3a78nfmn7k`).
export function sanitizeWorkspaceId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const id = raw.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{2,63}$/.test(id) ? id : null;
}

export function parseWorkspaceIdFromLimits(json: unknown): string | null {
  const quotas = (json as { output?: { quotas?: unknown } } | null)?.output?.quotas;
  if (!Array.isArray(quotas)) return null;
  for (const q of quotas) {
    const id = sanitizeWorkspaceId((q as { workspace_id?: unknown } | null)?.workspace_id);
    if (id) return id;
  }
  return null;
}

export const WORKSPACE_PROBE_RETRY_MS = 24 * 60 * 60 * 1000;

// Pure boot decision: try the auto-upgrade now? Fires only while the user has
// not opted out, the effective domain is a shared regional one, and the last
// failed probe (if any) is older than the 24h backoff. Zero network here —
// the orchestrator below stays free on every launch once upgraded.
export function shouldAutoUpgradeWorkspace(
  cfg: { cloudAutoWorkspaceDomain?: boolean; cloudWorkspaceProbeFailedAt?: number },
  domain: string,
  now = Date.now(),
): boolean {
  if (cfg.cloudAutoWorkspaceDomain === false) return false;
  if (!regionForSharedCloudDomain(domain)) return false;
  const failedAt = cfg.cloudWorkspaceProbeFailedAt;
  if (typeof failedAt === "number" && Number.isFinite(failedAt) && now - failedAt < WORKSPACE_PROBE_RETRY_MS) return false;
  return true;
}

// Ask a domain which workspace this key belongs to (quota rows carry it).
export async function detectCloudWorkspaceId(domain: string, apiKey: string): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const params = new URLSearchParams({ page_no: "1", page_size: "10" });
    const res = await fetch(`https://${domain}/api/v1/models/limits?${params}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return parseWorkspaceIdFromLimits(await res.json());
  } catch {
    return null;
  } finally { clearTimeout(t); }
}

// Cheap GET proving the candidate workspace domain resolves and serves the key.
export async function probeWorkspaceDomain(domain: string, apiKey: string): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(`https://${domain}/api/v1/models?page_no=1&page_size=1`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ctrl.signal,
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { success?: boolean; output?: unknown };
    return json.success !== false && json.output != null;
  } catch {
    return false;
  } finally { clearTimeout(t); }
}

export type WorkspaceUpgradeResult =
  | { status: "upgraded"; domain: string; wsid: string }
  | { status: "already"; domain: string; reason: string }
  | { status: "demoted"; domain: string; reason: string }
  | { status: "unchanged"; reason: string }
  | { status: "failed"; reason: string };

// Detect → probe → switch, persisting the outcome to alibaba-config.json.
// `force` (from the /alibaba menu) ignores the opt-out flag and the backoff.
export async function upgradeCloudDomainToWorkspace(apiKey: string, force = false): Promise<WorkspaceUpgradeResult> {
  const cfg = loadConfig();
  const domain = cfg.cloudDomain || DEFAULT_CLOUD_DOMAIN;
  const region = regionForSharedCloudDomain(domain);
  if (!region) {
    const ws = parseWorkspaceCloudDomain(domain);
    if (ws) {
      if (!force) return { status: "already", domain, reason: `already on the workspace domain ${domain}` };
      // Forced from the menu: verify the CURRENT key against the domain — it
      // may have been swapped between runs. Same-region workspace swaps are a
      // non-event (DashScope authenticates the key, not the wsid↔key pair);
      // a key from another site (CN ↔ intl ↔ US) gets 401, so rediscover the
      // workspace via the shared domains, current region first.
      if (await probeWorkspaceDomain(domain, apiKey)) {
        return { status: "already", domain, reason: `already on the workspace domain ${domain} (current key verified)` };
      }
      const primary = REGION_SHARED_DOMAINS[ws.region];
      const order = primary
        ? [primary, ...Object.values(REGION_SHARED_DOMAINS).filter((d) => d !== primary)]
        : Object.values(REGION_SHARED_DOMAINS);
      const probed: string[] = [];
      for (const shared of order) {
        const wsid = await detectCloudWorkspaceId(shared, apiKey);
        if (wsid) {
          const target = workspaceDomain(wsid, SHARED_DOMAIN_REGIONS[shared]);
          if (target === domain) {
            return { status: "failed", reason: `${domain} rejected the current key despite mapping to the same WorkspaceId ${wsid} — is the domain reachable?` };
          }
          if (await probeWorkspaceDomain(target, apiKey)) {
            cfg.cloudWorkspaceId = wsid;
            cfg.cloudDomain = target;
            delete cfg.cloudWorkspaceProbeFailedAt;
            saveConfig(cfg);
            return { status: "upgraded", domain: target, wsid };
          }
          probed.push(target);
        }
        // Last resort: this shared domain serves the current key even though
        // it revealed no usable workspace (e.g. models/limits is not offered
        // on that site). Demote only on positive probe evidence, and opt out
        // of the auto-upgrade so it cannot flip back into the same failure.
        if (await probeWorkspaceDomain(shared, apiKey)) {
          cfg.cloudDomain = shared;
          cfg.cloudAutoWorkspaceDomain = false;
          delete cfg.cloudWorkspaceId;
          delete cfg.cloudWorkspaceProbeFailedAt;
          saveConfig(cfg);
          return {
            status: "demoted",
            domain: shared,
            reason: `${domain} rejected the current key and no workspace was discoverable for it`,
          };
        }
      }
      return {
        status: "failed",
        reason: `${domain} rejected the current key (or is unreachable) and no shared domain accepted it either` +
          (probed.length ? ` (probed: ${probed.join(", ")})` : ""),
      };
    }
    return {
      status: "unchanged",
      reason: `${domain} is not a shared regional domain (auto-upgrade applies to ${Object.keys(SHARED_DOMAIN_REGIONS).join(", ")})`,
    };
  }
  if (!force && !shouldAutoUpgradeWorkspace(cfg, domain)) {
    return {
      status: "unchanged",
      reason: cfg.cloudAutoWorkspaceDomain === false ? "auto-upgrade is disabled" : "last probe failed <24h ago (backoff)",
    };
  }
  // Live discovery first; the cached id is only a fallback (e.g. limits
  // unreachable but the workspace domain itself would answer).
  const wsid = (await detectCloudWorkspaceId(domain, apiKey)) ?? sanitizeWorkspaceId(cfg.cloudWorkspaceId);
  if (!wsid) {
    cfg.cloudWorkspaceProbeFailedAt = Date.now();
    saveConfig(cfg);
    return { status: "failed", reason: "no workspace_id in the /api/v1/models/limits response" };
  }
  const target = workspaceDomain(wsid, region);
  if (!(await probeWorkspaceDomain(target, apiKey))) {
    cfg.cloudWorkspaceProbeFailedAt = Date.now();
    saveConfig(cfg);
    return { status: "failed", reason: `${target} did not answer the probe` };
  }
  cfg.cloudWorkspaceId = wsid;
  cfg.cloudDomain = target;
  delete cfg.cloudWorkspaceProbeFailedAt;
  saveConfig(cfg);
  return { status: "upgraded", domain: target, wsid };
}

// ── Cloud key binding (key swap → endpoint re-derivation) ────────────
// A corporate (workspace) endpoint belongs to the key it was derived from:
// keep it after a key swap and every request 403s on the mismatch. pi writes
// api-key credentials in its own /login dialog (no extension hook fires on the
// write), so the swap is caught the first moment the extension observes an
// unseen key — boot, session_start, or a catalog refresh — and the endpoint is
// then re-derived from scratch in a fixed order:
//   1. verify the key against the DEFAULT (shared regional) endpoints first —
//      the current region's own default first (e.g. the Beijing default
//      dashscope.aliyuncs.com behind a cn-beijing workspace domain), then the
//      other sites' defaults (CN ↔ intl ↔ US keys do not cross-authenticate);
//   2. only then try to upgrade the verified default to the corporate
//      (workspace) endpoint of the NEW key's own WorkspaceId.
// The previous key's endpoint is never inherited. Positive probe evidence only
// (the same rule as the boot auto-upgrade): a total outage changes nothing and
// the binding retries on the next run.

// Fingerprint of a key — records WHICH key the endpoint config was derived
// from without ever storing the key itself (auth.json stays the only key store).
export function cloudKeyFingerprint(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

// Pure: does the active key still match the one the Cloud endpoint config was
// last derived from? A missing fingerprint (pre-upgrade install, or a key
// written before this guard existed) also counts as "derive once".
export function cloudKeyNeedsRebinding(
  cfg: { cloudKeyFingerprint?: string },
  key: string | null | undefined,
): boolean {
  if (!key) return false;
  return cfg.cloudKeyFingerprint !== cloudKeyFingerprint(key);
}

// Ordered default (shared regional) endpoints to verify a fresh key against:
// the configured domain's own region default first (e.g. the Beijing default
// behind a cn-beijing workspace domain), then the other sites' defaults. Domains
// with no shared default of their own (Tokyo/Frankfurt workspaces, HK, custom)
// start from the international default.
export function defaultCloudDomainsFor(domain: string): string[] {
  const current = domain.trim().toLowerCase();
  const region = parseWorkspaceCloudDomain(current)?.region ?? regionForSharedCloudDomain(current);
  const primary = (region ? REGION_SHARED_DOMAINS[region] : null) ?? DEFAULT_CLOUD_DOMAIN;
  return [primary, ...Object.values(REGION_SHARED_DOMAINS).filter((d) => d !== primary)];
}

export type CloudKeyRebindResult =
  | { status: "rebound"; domain: string; upgrade: WorkspaceUpgradeResult }
  | { status: "unchanged"; reason: string }
  | { status: "failed"; reason: string };

// Detect → verify the default → upgrade to corporate, persisting after every
// positive result. Runs at most once per observed key (see the guard below).
export async function rebindCloudEndpointToKey(apiKey: string): Promise<CloudKeyRebindResult> {
  const cfg = loadConfig();
  const current = cfg.cloudDomain || DEFAULT_CLOUD_DOMAIN;
  // Hong Kong and custom hosts are explicit, key-independent user config —
  // never re-derived (the boot auto-upgrade leaves them alone for the same
  // reason). Just bind the key so the swap is not re-processed forever.
  if (!regionForSharedCloudDomain(current) && !parseWorkspaceCloudDomain(current)) {
    cfg.cloudKeyFingerprint = cloudKeyFingerprint(apiKey);
    saveConfig(cfg);
    return { status: "unchanged", reason: `${current} is not a shared or workspace domain — kept as configured` };
  }
  // Remember a workspace's home region: Tokyo/Frankfurt workspaces have no
  // shared domain to derive one from, and a same-workspace key swap must not
  // drift the endpoint to another region's suffix.
  const prevWs = parseWorkspaceCloudDomain(current);

  // Step 1: the key is proven against the default endpoints first — the old
  // corporate domain is stale by definition once the key changes, so it is
  // never even consulted here.
  let base: string | null = null;
  for (const shared of defaultCloudDomainsFor(current)) {
    if (await probeWorkspaceDomain(shared, apiKey)) { base = shared; break; }
  }
  if (!base) {
    return { status: "failed", reason: `no default endpoint accepted the new key — ${current} left untouched` };
  }
  cfg.cloudDomain = base;
  // The cached WorkspaceId belongs to the PREVIOUS key: drop it so it cannot
  // come back as a fallback and park the new key under the old workspace.
  delete cfg.cloudWorkspaceId;
  delete cfg.cloudWorkspaceProbeFailedAt;
  cfg.cloudKeyFingerprint = cloudKeyFingerprint(apiKey);
  saveConfig(cfg);

  // Step 2: try to upgrade the verified default to the corporate endpoint.
  if (cfg.cloudAutoWorkspaceDomain === false) {
    return {
      status: "rebound",
      domain: base,
      upgrade: { status: "unchanged", reason: `auto-upgrade is disabled — staying on the verified default ${base}` },
    };
  }
  const wsid = await detectCloudWorkspaceId(base, apiKey);
  const region = regionForSharedCloudDomain(base);
  if (!wsid || !region) {
    cfg.cloudWorkspaceProbeFailedAt = Date.now();
    saveConfig(cfg);
    return {
      status: "rebound",
      domain: base,
      upgrade: { status: "failed", reason: "no workspace_id discoverable for the new key — staying on the verified default" },
    };
  }
  // No fallback to the previous key's WorkspaceId here: the detection above is
  // the only source, so a corporate endpoint always matches the active key.
  const target = workspaceDomain(wsid, prevWs && prevWs.wsid === wsid ? prevWs.region : region);
  if (!(await probeWorkspaceDomain(target, apiKey))) {
    cfg.cloudWorkspaceProbeFailedAt = Date.now();
    saveConfig(cfg);
    return {
      status: "rebound",
      domain: base,
      upgrade: { status: "failed", reason: `${target} did not answer the probe — staying on the verified default` },
    };
  }
  cfg.cloudWorkspaceId = wsid;
  cfg.cloudDomain = target;
  delete cfg.cloudWorkspaceProbeFailedAt;
  saveConfig(cfg);
  return { status: "rebound", domain: target, upgrade: { status: "upgraded", domain: target, wsid } };
}

// Per-process guard: one derivation per observed key (boot, session_start and
// the catalog refresh all ask), retried on the next run after a failure instead
// of hammered. Re-login Cloud / Reset all clear it.
let rebindAttemptedFingerprint: string | null = null;
export function resetCloudKeyBindingGuard() { rebindAttemptedFingerprint = null; }

async function ensureCloudEndpointBound(apiKey: string): Promise<void> {
  try {
    const fp = cloudKeyFingerprint(apiKey);
    if (rebindAttemptedFingerprint === fp) return;
    rebindAttemptedFingerprint = fp;
    if (!cloudKeyNeedsRebinding(loadConfig(), apiKey)) return;
    const res = await rebindCloudEndpointToKey(apiKey);
    if (res.status === "rebound") {
      const how = res.upgrade.status === "upgraded"
        ? `corporate endpoint ${res.domain} (WorkspaceId ${res.upgrade.wsid})`
        : `${res.domain} (${res.upgrade.reason})`;
      console.warn(`[alibaba] Cloud API key changed — endpoint re-derived via the default endpoint: ${how}.`);
    } else if (res.status === "failed") {
      console.warn(`[alibaba] Cloud endpoint not re-derived for the new API key: ${res.reason}.`);
    }
  } catch (e: any) {
    console.warn(`[alibaba] Cloud endpoint re-derivation failed (${e?.message || e}).`);
  }
}

// ── Cloud login seed ─────────────────────────────────────────────────
// pi hides any provider that has zero registered models, so with no
// credential at all the Cloud provider would vanish from /login → "Use an
// API key" (issue #1). To stay visible we register ONE placeholder model
// when — and only when — the live catalog is empty AND no key exists. In
// that state no model is usable anyway (there's no key), so this is purely a
// "click here to log in" entry, not a model-catalog fallback: as soon as a
// key is present (via /login or $DASHSCOPE_API_KEY) the live catalog is
// fetched and replaces it. We use a real, region-agnostic id (`qwen-plus`,
// present on every DashScope account) so it also works for an env-var user
// before the first refresh, and never lingers as an orphan after login.
const CLOUD_LOGIN_SEED: ChatModelConfig[] = [{
  id: "qwen-plus",
  name: "Qwen Plus",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 131072,
  maxTokens: 8192,
}];

// ── Offline-resilient catalog loaders ────────────────────────────────
// ── Catalog loading + refresh (pi-owned storage) ───────────────────────
// pi persists whatever `refreshModels` returns in its models store and hands
// the snapshot back as `context.stored` during offline/cache-only
// initialization; its own freshness checks decide when a network refresh is
// due (`force` bypasses them). There is no cache file and no TTL policy here:
// we fetch and derive, pi stores and re-serves.

type RefreshCtx = {
  allowNetwork: boolean;
  force?: boolean;
  signal?: AbortSignal;
  // pi 1.0.0 persists one store entry per provider with models of *every*
  // operation (`readonly AnyModel[]`), so the snapshot can carry image or
  // classifier rows. Typed structurally: pi's store types are not re-exported
  // to extensions, and only `id`/`type` are read here. `ownedRows()` filters.
  stored?: { models?: readonly { id?: string; type?: string }[] };
  // `any`: pi's ModelsPublication is not re-exported as a public type, and the
  // publication object is built here anyway (persist + checkedAt).
  publish?(publication: any): Promise<boolean>;
};

// Ownership filter for pi's stored snapshot. A Cloud entry owns every row of
// every operation this provider registers — chat and image — and only
// classifier rows (which have no implementation here) are dropped. An entry
// without `type` is chat (pi's own rule, and what every pre-1.0.0 snapshot
// looks like). The image rows are kept so an offline start still registers
// image models.
export const ownedRows = <T extends { type?: string }>(models: readonly T[] | undefined): T[] =>
  (models ?? []).filter((m) => m.type === undefined || m.type === "chat" || m.type === "image");

// Chat-only view of pi's stored snapshot. The Sidecar's model picker, the
// fallback-model count, and chat card derivation must never see an image id,
// so this is the narrow view they use. (Exported: tests pin both views.)
export const chatRows = <T extends { type?: string }>(models: readonly T[] | undefined): T[] =>
  (models ?? []).filter((m) => m.type === undefined || m.type === "chat");

// Image rows of pi's stored snapshot, so `cloudRefreshModels` can re-serve
// them in the cache-only phase.
export const imageRows = <T extends { type?: string }>(models: readonly T[] | undefined): T[] =>
  (models ?? []).filter((m) => m.type === "image");

// Coordination for many pi instances sharing one agent dir: alibaba-config.json
// is the shared, last-writer-wins record of "someone just fetched". While it is
// fresh, the other instances skip their own fetch and are served pi's stored
// snapshot through `refreshModels` instead. `force` (Refresh model lists)
// always fetches. No lockfile — the GET is idempotent, so simultaneous cold
// starts may race once per window and that is fine.
const CATALOG_FRESH_MS = 10 * 60 * 1000;
export const catalogFresh = (fetchedAt?: number, now = Date.now()): boolean =>
  typeof fetchedAt === "number" && Number.isFinite(fetchedAt) && now - fetchedAt < CATALOG_FRESH_MS;

// Cross-instance fetch lock: models-store.json is one shared file and pi has
// no inter-process locking, so parallel fetchers would race on publishing it.
// One fetcher at a time (`wx` makes creation atomic); the others skip and are
// served pi's stored snapshot. A lock older than 60s belongs to a crashed
// fetcher and is stolen. The GET is idempotent, so the rare double-fetch on a
// boundary race is harmless.
const CATALOG_LOCK_PATH = path.join(HOME_DIR, "alibaba-catalog.lock");
const CATALOG_LOCK_STALE_MS = 60_000;

async function acquireCatalogLock(waitMs = 0): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.writeFileSync(CATALOG_LOCK_PATH, String(process.pid), { flag: "wx", mode: 0o600 });
      return true;
    } catch {
      try {
        if (Date.now() - fs.statSync(CATALOG_LOCK_PATH).mtimeMs > CATALOG_LOCK_STALE_MS) {
          fs.unlinkSync(CATALOG_LOCK_PATH);
          continue;
        }
      } catch {}
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}
const releaseCatalogLock = () => { try { fs.unlinkSync(CATALOG_LOCK_PATH); } catch {} };

// The private snapshot is written ONLY after a real fetch (atomic writeJSON)
// and read as a plain boot seed — never as proof of freshness: the shared
// timestamp in alibaba-config.json remains the only freshness/coordination
// signal, and the lockfile the only writer serializer.
interface CatalogCache {
  v: 2;
  plan?: { fetchedAt: number; models: PlanModelDef[] };
  // `catalog` carries the raw per-model rows (prices and size limits), so a
  // boot with no network can still declare cache, currency and window policy.
  // Optional: an older snapshot without it is valid, it just keeps whatever the
  // stored cards already declared until the next fetch.
  cloud?: { fetchedAt: number; models: ChatModelConfig[]; catalog?: Record<string, CatalogEntry> };
  // Curated image rows (the native IG listing, already filtered). Optional:
  // an older v2 snapshot without them is still valid, just image-less offline.
  cloudImages?: { fetchedAt: number; models: ImageCatalogRow[] };
}

// Pure parser and version guard in one: anything but v2 is ignored, so an old
// or foreign format can never pose as catalog data.
export function parseCatalogCache(raw: unknown): CatalogCache | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as CatalogCache;
  return c.v === 2 ? c : null;
}
const readCatalogCache = (): CatalogCache | null =>
  parseCatalogCache(readJSON<unknown>(CATALOG_CACHE_PATH, null));
function updateCatalogCache(patch: Partial<CatalogCache>) {
  const current = readCatalogCache() ?? { v: 2 };
  writeJSON(CATALOG_CACHE_PATH, { ...current, ...patch, v: 2 });
}

// Boot seed: registration gets the snapshot immediately (zero network, so
// `pi --list-models` and enabledModels validation see real ids), while the
// timestamp still governs freshness and the lock still governs fetches.
// Fill-only: a seed never overwrites a catalog we already hold.
function seedFromSnapshot() {
  const cache = readCatalogCache();
  if (!planDefs.length && cache?.plan?.models?.length) planDefs = cache.plan.models;
  if ((!cloudDefs.length || cloudDefs === CLOUD_LOGIN_SEED) && cache?.cloud?.models?.length) {
    cloudDefs = cache.cloud.models;
    for (const [id, entry] of Object.entries(cache.cloud.catalog ?? {})) {
      if (entry && typeof entry === "object" && !cloudCatalog.has(id)) cloudCatalog.set(id, entry);
    }
    rebuildEquivalenceIndex();
  }
  // Presence of the `cloudImages` section counts as "already fetched", even when
  // the curated filter emptied it — otherwise an account with no image models
  // would force-refetch the IG listing on every boot.
  if (cache?.cloudImages && !cloudImagesLoaded) {
    cloudImageDefs = cache.cloudImages.models ?? [];
    cloudImagesLoaded = true;
  }
}

type CatalogResult<T> = { defs: T[]; fetched: boolean }; 

// Best-effort fetch under the cross-instance lock: a failure keeps whatever we
// already hold and warns. `fetched` tells the caller whether this run really
// pulled a catalog (and may publish it to pi's store).
async function loadPlanCatalog(force: boolean): Promise<CatalogResult<PlanModelDef>> {
  const cfg = loadConfig();
  if (!force && catalogFresh(cfg.planFetchedAt)) return { defs: planDefs, fetched: false };
  if (!(await acquireCatalogLock(force ? 10_000 : 0))) return { defs: planDefs, fetched: false };
  try {
    const defs = await fetchPlanModels(force, readAuth()["alibaba-plan"]);
    planDefs = defs;
    cfg.planFetchedAt = Date.now();
    saveConfig(cfg);
    updateCatalogCache({ plan: { fetchedAt: cfg.planFetchedAt, models: defs } });
    return { defs, fetched: true };
  } catch (e: any) {
    console.warn(`[alibaba] Plan catalog fetch failed (${e?.message || e}); keeping ${planDefs.length} previously loaded models.`);
    return { defs: planDefs, fetched: false };
  } finally {
    releaseCatalogLock();
  }
}

async function loadCloudCatalog(domain: string, apiKey: string, force: boolean): Promise<CatalogResult<ChatModelConfig>> {
  const cfg = loadConfig();
  if (!force && catalogFresh(cfg.cloudFetchedAt)) return { defs: cloudDefs, fetched: false };
  if (!(await acquireCatalogLock(force ? 10_000 : 0))) return { defs: cloudDefs, fetched: false };
  try {
    const { models, authorizedOnly } = await fetchCloudModels(domain, apiKey, force);
    const defs = models.length ? models : CLOUD_LOGIN_SEED;
    cloudDefs = defs;
    // The image catalogue is a separate fetch (the chat one excludes image ids
    // by pattern). A failed image fetch keeps whatever we already hold and
    // never fails the chat catalogue with it.
    let imageFetched = false;
    try {
      const rawImages = await fetchCloudImageModels(domain, apiKey);
      if (rawImages) {
        cloudImageDefs = filterCuratedImageModels(rawImages);
        imageFetched = true;
      }
    } catch (e: any) {
      console.warn(`[alibaba] Cloud image catalog fetch failed (${e?.message || e}); keeping ${cloudImageDefs.length} previously loaded image models.`);
    } finally {
      // One attempt per catalog fetch, success or not: a domain that never
      // serves the IG listing must not make every boot force-refetch.
      cloudImagesLoaded = true;
    }
    cfg.cloudFetchedAt = Date.now();
    cfg.cloudAuthorizedFilteredLast = authorizedOnly;
    saveConfig(cfg);
    const patch: Partial<CatalogCache> = {};
    if (models.length) {
      const catalog: Record<string, CatalogEntry> = {};
      for (const m of models) {
        const entry = cloudCatalog.get(m.id);
        if (entry) catalog[m.id] = entry;
      }
      patch.cloud = { fetchedAt: cfg.cloudFetchedAt, models, catalog };
    }
    if (imageFetched) patch.cloudImages = { fetchedAt: cfg.cloudFetchedAt, models: cloudImageDefs };
    if (Object.keys(patch).length) updateCatalogCache(patch);
    return { defs, fetched: models.length > 0 };
  } catch (e: any) {
    console.warn(`[alibaba] Cloud catalog fetch failed (${e?.message || e}); keeping ${cloudDefs.length} previously loaded models.`);
    return { defs: cloudDefs, fetched: false };
  } finally {
    releaseCatalogLock();
  }
}

// Register-time model list: chat cards first, then the image cards. Supplying
// `models` replaces the provider's models across every operation, so the two
// builders merge here and the provider registers one mixed list.
function buildCloudModelList(
  chat: ChatModelConfig[],
  images: ImageCatalogRow[],
  opts: CloudModelBuildOptions,
): PiModelConfig[] {
  return [
    ...buildCloudModels(chat, opts),
    ...buildImageModels(images, opts.domain),
  ];
}

// The one place config becomes build options, so registration, refresh and the
// login-seed path cannot drift apart.
function cloudBuildOptions(cfg: AlibabaConfig, domain: string, fmt: string): CloudModelBuildOptions {
  return {
    domain,
    fmt,
    overrides: cfg.contextWindowOverrides,
    sessionCache: cfg.cloudSessionCache !== false,
    cacheControl: cfg.cloudCacheControl !== false,
    warm: resolveWarmSettings(cfg.cacheWarm ?? {}),
    currency: cfg.costCurrency === "usd" ? "usd" : "cny",
    cnyPerUsd: cfg.cnyPerUsd,
    responsesInputGuard: cfg.responsesInputGuard !== false,
  };
}

// What pi calls. The offline phase re-serves the stored snapshot through the
// builders (capabilities are re-derived from ids — see deriveCard); the
// network phase fetches and lets pi persist the result. With no credential at
// all we return no models, so "Reset all" cannot leave ghosts in pi's store.
const planRefreshModels = async (context: RefreshCtx): Promise<ChatModelConfig[]> => {
  const creds = readAuth()["alibaba-plan"];
  if (!creds?.access) return [];
  const ep = resolvePlanEndpoints(creds);
  const overrides = loadConfig().contextWindowOverrides;
  if (!context.allowNetwork) {
    // Cache-only phase: re-derive pi's stored snapshot — never a store write.
    if (!planDefs.length) planDefs = (chatRows(context.stored?.models) as unknown as PlanModelDef[]);
    return buildPlanModels(planDefs, ep.openai, ep.anthropic, overrides);
  }
  const result = await loadPlanCatalog(!!context.force);
  const built = buildPlanModels(result.defs, ep.openai, ep.anthropic, overrides);
  // One models-store.json write per real fetch (pi's legacy ProviderConfig
  // does not persist refreshModels returns by itself) — plus a catch-up write
  // when the bonus channel is empty while we do hold a catalog (the boot
  // force-refresh fills the private bundle first).
  if (result.defs.length && (result.fetched || !context.stored?.models?.length)) {
    await context.publish?.({ persist: { models: built, checkedAt: Date.now() } });
  }
  return built;
};

const cloudRefreshModels = async (context: RefreshCtx): Promise<PiModelConfig[]> => {
  const key = readCloudKey();
  // A key written since the last run re-derives the endpoint before any fetch;
  // the models returned below carry the rebuilt baseUrl, so pi heals in one pass.
  if (key && context.allowNetwork) await ensureCloudEndpointBound(key);
  const cfg = loadConfig();
  const domain = cfg.cloudDomain || DEFAULT_CLOUD_DOMAIN;
  const fmt = cfg.cloudApiFormat || DEFAULT_CLOUD_FORMAT;
  // The login seed must never shadow pi's stored snapshot in the cache-only
  // phase; with no credential nothing is served at all ("Reset all" safety).
  // The ownership filter keeps chat *and* image rows and drops only classifier
  // rows; the chat-only view then feeds the chat builder and the Sidecar picker.
  const owned = ownedRows(context.stored?.models);
  const held = cloudDefs.length && cloudDefs !== CLOUD_LOGIN_SEED
    ? cloudDefs
    : (chatRows(owned) as unknown as ChatModelConfig[]);
  const heldImages = cloudImageDefs.length
    ? cloudImageDefs
    : (imageRows(owned) as unknown as ImageCatalogRow[]);
  const buildOptions = cloudBuildOptions(cfg, domain, fmt);
  if (!key) return buildCloudModels(CLOUD_LOGIN_SEED, buildOptions);
  if (!context.allowNetwork) {
    if (!cloudDefs.length || cloudDefs === CLOUD_LOGIN_SEED) cloudDefs = held;
    if (!cloudImageDefs.length) cloudImageDefs = heldImages;
    return buildCloudModelList(held.length ? held : CLOUD_LOGIN_SEED, heldImages, buildOptions);
  }
  const result = await loadCloudCatalog(domain, key, !!context.force);
  const built = buildCloudModelList(result.defs.length ? result.defs : CLOUD_LOGIN_SEED, cloudImageDefs, buildOptions);
  // One store write per real fetch (see planRefreshModels), with the same
  // catch-up when the bonus channel is empty.
  if (result.defs.length && result.defs !== CLOUD_LOGIN_SEED && (result.fetched || !context.stored?.models?.length)) {
    await context.publish?.({ persist: { models: built, checkedAt: Date.now() } });
  }
  return built;
};

// ── Module-level mutable model lists ─────────────────────────────────
// Filled by the loaders above (registration baseline + refreshModels), and
// read by modifyModels, /alibaba's Status/Rate-limits/Override menus. Chat
// and image definitions stay separate: `cloudDefs` is the only input to the
// Sidecar picker, the fallback count, and chat card derivation.
let planDefs: PlanModelDef[] = [];
let cloudDefs: ChatModelConfig[] = [];
let cloudImageDefs: ImageCatalogRow[] = [];
// True once the image catalogue was either fetched or read from a snapshot that
// carried a `cloudImages` section (empty counts — see seedFromSnapshot).
let cloudImagesLoaded = false;

// ── Migration ─────────────────────────────────────────────────────────
const isPlanKey = (k: string) => k.startsWith("sk-sp-") || k.startsWith("sk-tok-");

function extractKey(entry: AuthEntry | undefined): string | undefined {
  if (!entry) return undefined;
  return entry.key || entry.access || undefined;
}

function migrateLegacyAuth() {
  try {
    const auth = readAuth();
    let dirty = false;

    // 1) Legacy single-key "alibaba" → split by prefix.
    const old = auth["alibaba"];
    if (old) {
      const key = extractKey(old);
      for (const k of ["alibaba-studio", "alibaba-token", "dashscope"]) {
        if (k in auth) { delete auth[k]; dirty = true; }
      }
      if (!key) {
        delete auth["alibaba"]; dirty = true;
      } else {
        const target = isPlanKey(key) ? "alibaba-plan" : "alibaba-cloud";
        // Plan stays in oauth shape (it's still oauth-registered);
        // Cloud must be api_key shape (now api-key-only registered).
        auth[target] = target === "alibaba-plan"
          ? { type: "oauth", access: key, refresh: "", expires: Date.now() + 365 * 86400_000 }
          : { type: "api_key", key };
        delete auth["alibaba"];
        dirty = true;
      }
    }

    // 2) Cloud was previously registered with `oauth` block — credentials were
    //    saved as {type:"oauth", access:"sk-..."}. Now that cloud is api-key-only,
    //    pi can't read those credentials. Migrate them in place.
    const cloud = auth["alibaba-cloud"];
    if (cloud && cloud.type !== "api_key") {
      const key = extractKey(cloud);
      if (key) {
        // Defensive: if the cloud slot somehow contains a Plan token, route it.
        if (isPlanKey(key)) {
          auth["alibaba-plan"] = auth["alibaba-plan"] ?? {
            type: "oauth", access: key, refresh: "", expires: Date.now() + 365 * 86400_000,
          };
          delete auth["alibaba-cloud"];
        } else {
          auth["alibaba-cloud"] = { type: "api_key", key };
        }
        dirty = true;
      } else {
        delete auth["alibaba-cloud"];
        dirty = true;
      }
    }

    // 3) Defensive: a misrouted Plan token sitting in alibaba-cloud (api_key shape).
    //    Plan tokens won't authenticate against the cloud endpoint. Move it.
    const cloud2 = auth["alibaba-cloud"];
    if (cloud2?.type === "api_key" && typeof cloud2.key === "string" && isPlanKey(cloud2.key)) {
      if (!auth["alibaba-plan"]) {
        auth["alibaba-plan"] = {
          type: "oauth", access: cloud2.key, refresh: "", expires: Date.now() + 365 * 86400_000,
        };
      }
      delete auth["alibaba-cloud"];
      dirty = true;
    }

    if (dirty) writeAuth(auth);
  } catch {}
}

// ── Main ──────────────────────────────────────────────────────────────
// Async factory: pi awaits this before provider registrations are flushed.
// Fetch live model catalogs before registerProvider() so enabledModels
// validation sees the real catalog immediately. No fallbacks.
// ── Provider registration (shared by boot and session_start) ────────────────
function registerPlanProvider(pi: ExtensionAPI) {
  const ep = resolvePlanEndpoints(readAuth()["alibaba-plan"]);
  // ── Plan provider ───────────────────────────────────────────────────
  pi.registerProvider("alibaba-plan", {
    name: "Alibaba Model Studio Plan",
    baseUrl: ep.anthropic,
    api: "anthropic-messages",
    authHeader: true,
    models: buildPlanModels(planDefs, ep.openai, ep.anthropic, loadConfig().contextWindowOverrides),
    refreshModels: planRefreshModels,
    oauth: {
      name: "Alibaba Model Studio Coding Plan",
      async login(callbacks) {
        const key = await callbacks.onPrompt({
          message: "Coding Plan token (sk-sp-… or sk-tok-…). Run /alibaba afterwards if you need a non-Singapore region:",
        });
        if (!isPlanKey(key)) {
          throw new Error(
            "This doesn't look like a Coding Plan token (expected sk-sp-… or sk-tok-…). " +
            "If it's a Cloud API key, run /login → 'Alibaba Cloud (API Key)' instead.",
          );
        }
        const cfg = loadConfig();
        const openaiUrl = cfg.planOpenAI || DEFAULT_PLAN_OPENAI;
        const anthropicUrl = cfg.planAnthropic || DEFAULT_PLAN_ANTHROPIC;
        cfg.planOpenAI = openaiUrl;
        cfg.planAnthropic = anthropicUrl;
        saveConfig(cfg);
        return {
          access: key,
          refresh: JSON.stringify({ openai: openaiUrl, anthropic: anthropicUrl }),
          expires: Date.now() + 365 * 86400_000,
        };
      },
      async refreshToken(c) { return c; },
      getApiKey(c) { return c.access; },
      modifyModels(models, credentials) {
        const ep = resolvePlanEndpoints(credentials);
        // Always reads the latest planDefs (startup fetch → session_start refresh)
        const updated = buildPlanModels(planDefs, ep.openai, ep.anthropic);
        return models.map((m) => {
          if (m.provider !== "alibaba-plan") return m;
          const found = updated.find((u) => u.id === m.id);
          if (!found || !found.api) return m;
          return { ...m, baseUrl: found.baseUrl ?? m.baseUrl, api: found.api };
        });
      },
    },
  });
}


function registerCloudProvider(pi: ExtensionAPI) {
  const cfg = loadConfig();
  const domain = cfg.cloudDomain || DEFAULT_CLOUD_DOMAIN;
  // 1.5.0: Responses is the new default, and the resolved default is pinned
  // here at registration. An unset format used to mean anthropic-messages;
  // silently flipping wire protocols under existing installs is exactly what
  // tickets are made of. Anyone who explicitly picked a format keeps it.
  if (!cfg.cloudApiFormat) {
    cfg.cloudApiFormat = DEFAULT_CLOUD_FORMAT;
    saveConfig(cfg);
  }
  const fmt: CloudApiFormat = cfg.cloudApiFormat;
  const transport = cloudDefaultTransport(domain, fmt);
  // ── Cloud provider ─────────────────────────────────────────────────
    pi.registerProvider("alibaba-cloud", {
    name: "Alibaba Cloud (API Key)",
    baseUrl: transport.baseUrl,
    apiKey: "$DASHSCOPE_API_KEY",
    api: transport.api,
    authHeader: true,
    // One mixed list: supplying `models` replaces this provider's models across
    // chat, image, and classifier operations, so the image cards must ride here
    // or they would erase the chat models (custom-provider.md).
    models: buildCloudModelList(cloudDefs, cloudImageDefs, cloudBuildOptions(cfg, domain, fmt)),
    // Keyed by the `api` the image cards declare; pi forwards the resolved
    // Cloud key and the tool's `metadata` here unchanged.
    images: { [IMAGE_API]: { generateImages: generateDashScopeImages } },
    refreshModels: cloudRefreshModels,
  });
}

// Both tools share one namespace and one exposure vocabulary. A tool is only
// registered while its exposure is not `off`; `codemode` (the default) keeps
// the declaration out of every request while leaving it callable from scripts.
function registerAlibabaTools(pi: ExtensionAPI, cfg: AlibabaConfig, imageDeps: ImageToolDeps) {
  const toolsExposure = resolveToolsExposure(cfg);
  const imageExposure = resolveImageExposure(cfg);

  if (toolsExposure !== "off") {
    pi.registerTool({
      name: "alibaba_tools",
      label: "Alibaba tools",
      description:
        "Separate billed Qwen sidecar for current web information, page extraction, " +
        "sandbox computation, or image search. Not for local files or shell commands.",
      promptSnippet:
        "alibaba_tools: billed Qwen sidecar; search=current facts, research=pages/multi-source, " +
        "code=sandbox, image=pictures.",
      promptGuidelines: [
        "Use only when current external information or a DashScope sandbox is needed; skip local/repository work and equivalent results already available from another tool.",
        "Use search for quick lookups. Use research directly for page extraction or multi-source synthesis, or when search is insufficient; research is slower and costlier.",
      ],
      parameters: ALIBABA_TOOLS_PARAMETERS,
      executionMode: "parallel",
      exposure: toolsExposure,
      namespace: ALIBABA_NAMESPACE,
      annotations: ALIBABA_TOOLS_ANNOTATIONS,
      outputSchema: ALIBABA_TOOLS_OUTPUT_SCHEMA,
      async execute(
        _toolCallId: string,
        rawParams: { action?: string; task?: string; strategy?: SidecarStrategy },
        signal: AbortSignal | undefined,
        onUpdate: ToolUpdate,
      ): Promise<ToolResult> {
        const params = rawParams as { action?: string; task?: string; strategy?: SidecarStrategy };
        const action = String(params.action || "search") as SidecarAction;
        const task = typeof params.task === "string" ? params.task.trim() : "";
        const strategy = params.strategy;
        if (!task) throw new Error("alibaba_tools requires a non-empty task.");
        if (!["research", "search", "code", "image"].includes(action)) {
          throw new Error(`Unknown action "${action}". Use search, research, code, or image.`);
        }
        const key = readCloudKey();
        if (!key) {
          throw new Error("No Cloud API key. Run /login → Alibaba Cloud (API Key) or set $DASHSCOPE_API_KEY.");
        }
        await ensureCloudEndpointBound(key);
        const live = loadConfig();
        const domain = live.cloudDomain || DEFAULT_CLOUD_DOMAIN;
        const picked = pickSidecarModel({
          preferred: live.cloudSidecarModel,
          catalogIds: cloudDefs.map((m) => m.id),
          action,
        });
        if ("error" in picked) throw new Error(picked.error);
        const req = buildSidecarRequest({
          model: picked.id,
          transport: picked.transport,
          action,
          task,
          strategy,
        });
        onUpdate?.({
          content: [{ type: "text", text: formatSidecarProgress(action, 0, { text: "", sources: [], calls: [] }) }],
          details: { action, model: picked.id, transport: picked.transport, partial: true },
        });
        const res = await runSidecarWithRetry(domain, key, req, signal, (parsed, elapsedMs) => {
          onUpdate?.({
            content: [{ type: "text", text: formatSidecarProgress(action, elapsedMs, parsed) }],
            details: { action, model: picked.id, transport: picked.transport, partial: true, calls: parsed.calls },
          });
        }, {
          onRetry: ({ attempt, maxAttempts, delayMs, reason }) => {
            onUpdate?.({
              content: [{ type: "text", text: formatSidecarRetry(action, attempt, maxAttempts, delayMs, reason) }],
              details: { action, model: picked.id, transport: picked.transport, partial: true, retry: attempt, maxAttempts },
            });
          },
        });
        if (!res.ok) throw new Error(dashScopeErrorMessage(res.status, res.json));
        return {
          content: [{ type: "text", text: formatSidecarResult(res.parsed) }],
          structuredContent: {
            action,
            result: res.parsed.text,
            sources: res.parsed.sources.map((s) => {
              const out: Record<string, string> = {};
              if (s.url) out.url = s.url;
              if (s.title) out.title = s.title;
              if (s.snippet) out.snippet = s.snippet;
              return out;
            }),
            calls: res.parsed.calls,
            retries: res.retries,
          },
          details: {
            action,
            model: picked.id,
            transport: picked.transport,
            calls: res.parsed.calls,
            sourceCount: res.parsed.sources.length,
            retries: res.retries,
          },
        };
      },
    } as RegisterToolDef);
  }

  if (imageExposure !== "off") registerImageTool(pi, imageExposure, imageDeps);
}

// ── /alibaba → Cloud — Cache Warming ─────────────────────────────────────
// The knobs of extensions/cache-warm.ts, in one page. Warming is a latency
// mechanism here, so the labels say what each value buys in seconds of margin
// against the measured 5-minute TTL rather than what it costs.
const WARM_MODE_LABELS: Record<WarmMode, string> = {
  extension: "extension — this plugin's engine (default): no dollar gate, keeps warming for hours",
  pi: "pi — pi's own warmer: expected-savings gate, stops 30 min idle / 60 min streaming",
  off: "off — no warming: every pause longer than 5 min pays a cold prefix",
};

const REFRESH_PRESETS = [
  { value: 150, label: "150 s — 150 s of margin, 24 refreshes/h" },
  { value: 216, label: "216 s — 84 s of margin, 17 refreshes/h (default)" },
  { value: 270, label: "270 s — 30 s of margin, 13 refreshes/h (pi-like)" },
];
const HORIZON_PRESETS = [
  { value: 60, label: "1 hour" },
  { value: 240, label: "4 hours (default)" },
  { value: 480, label: "8 hours" },
  { value: 1440, label: "24 hours" },
];
const MIN_PROMPT_PRESETS = [
  { value: 0, label: "0 — warm every prompt" },
  { value: 20_000, label: "20 000 tokens (default)" },
  { value: 100_000, label: "100 000 tokens — only the prompts whose cold start hurts" },
];
const CUSTOM = "Custom…";

// Menu items carry a "• " marker on the current value, so a selection is
// matched on its label text, never on a prefix.
const unbullet = (s: string): string => s.replace(/^[\s•]+/, "");

/**
 * One preset pick: returns the chosen value, `null` for "Custom…", and
 * undefined when the user dismissed the list.
 */
async function pickPreset<T>(
  ctx: ExtensionCommandContext,
  title: string,
  items: { value: T; label: string }[],
  current: T,
): Promise<T | null | undefined> {
  const labels = [...items.map((i) => `${i.value === current ? "• " : "  "}${i.label}`), CUSTOM];
  const sel = await ctx.ui.select(title, labels);
  if (!sel) return undefined;
  const text = unbullet(sel);
  if (text === CUSTOM) return null;
  return items.find((i) => i.label === text)?.value;
}

// Status lines: what the cache is set up to do, and what it actually did.
function cacheStatusLines(cfg: AlibabaConfig, warmer: CacheWarmer, logPath: string): string[] {
  const s = resolveWarmSettings(cfg.cacheWarm ?? {});
  const st = warmer.status();
  const engine = s.mode === "off"
    ? "off"
    : s.mode === "pi"
      ? `pi (~${s.refreshSeconds}s refresh, pi's 30 min idle / 60 min streaming caps)`
      : `extension (${s.refreshSeconds}s refresh, ${s.horizonMinutes}m horizon, ≥${s.minPromptTokens.toLocaleString("en-US")} tokens)`;
  const live = s.mode === "extension"
    ? st.running
      ? ` — next warm in ${Math.max(0, Math.round(((st.nextWarmAt ?? Date.now()) - Date.now()) / 1000))}s`
      : ` — idle (${st.reason ?? "no request captured yet"})`
    : "";
  const counters = st.warms
    ? `; ${st.warms} warms: ${st.hits} hits, ${st.rewrites} late, ${st.blind} blind, ${st.failures} failed`
    : "";
  const currency = cfg.costCurrency === "usd" ? "usd" : "cny";
  const unit = currency === "usd"
    ? `USD/M (÷${cfg.cnyPerUsd || DEFAULT_CNY_PER_USD})`
    : "CNY/M (pi labels it $)";
  const lines = [
    `       Warming:   ${engine}${live}${counters}`,
    `       Prices:    ${unit}, tier probe ${(cfg.priceTierTokens ?? DEFAULT_TIER_TOKENS).toLocaleString("en-US")} tokens, ` +
      `thinking output ${cfg.priceThinkingOutput === false ? "off" : "on"}`,
  ];
  const sum = summarizeCacheLog(readCacheLog(logPath));
  if (sum.turns || sum.warms) {
    lines.push(
      `       Cache log: ${sum.turns} turn${sum.turns === 1 ? "" : "s"}, ${sum.hitRatePct ?? 0}% hit — ` +
      `${sum.cachedTokens.toLocaleString("en-US")} cached vs ${sum.missedTokens.toLocaleString("en-US")} cold tokens`,
    );
  }
  return lines;
}

// Two lines for the model in use. A switch to a family without explicit-cache
// rows silently changes what a cached turn costs, and the declared window is now
// a measured per-model cap rather than the catalog's context window — both are
// worth seeing next to the model name.
function modelLines(
  model: { provider?: string; id?: string; api?: string; contextWindow?: number } | undefined,
  cfg: AlibabaConfig,
): string[] {
  if (model?.provider !== "alibaba-cloud" || !model.id) return [];
  const lines: string[] = [];
  const prices = cloudPricesFor(model.id);
  if (prices) {
    const explicit = explicitCacheActive(
      model.api ?? "",
      cfg.cloudSessionCache !== false,
      cfg.cloudCacheControl !== false,
    );
    const tier = prices.tiered ? `, tier ${prices.tier}` : "";
    lines.push(
      `       Model:     ${model.id} — ${formatCacheEconomics(prices, explicit, cfg.costCurrency === "usd" ? "usd" : "cny")}${tier}`,
    );
  }
  const win = resolveContextWindow(model.id, model.api ?? "", cloudLimitsFor(model.id), model.contextWindow ?? 0, {
    responsesGuard: cfg.responsesInputGuard !== false,
  });
  const catalogWindow = cloudLimitsFor(model.id)?.contextWindow;
  const how = win.source === "measured"
    ? "measured 2026-10-07"
    : win.source === "derived"
      ? "derived, not measured for this model"
      : win.source === "override"
        ? "your override"
        : "catalog window";
  lines.push(
    `       Window:    ${(win.window || 0).toLocaleString("en-US")} on ${model.api ?? "?"} — ${how}` +
      (catalogWindow && catalogWindow !== win.window ? ` (catalog says ${catalogWindow.toLocaleString("en-US")})` : ""),
  );
  return lines;
}

async function cacheWarmMenu(ctx: ExtensionCommandContext, warmer: CacheWarmer, logPath: string): Promise<void> {
  let dirty = false;
  const patch = (p: Partial<NonNullable<AlibabaConfig["cacheWarm"]>>) => {
    const cfg = loadConfig();
    cfg.cacheWarm = { ...resolveWarmSettings(cfg.cacheWarm ?? {}), ...p };
    saveConfig(cfg);
    dirty = true;
  };
  const preset = async <T,>(
    title: string,
    items: { value: T; label: string }[],
    current: T,
    customTitle: string,
  ): Promise<T | undefined> => {
    const picked = await pickPreset(ctx, title, items, current);
    if (picked !== null) return picked ?? undefined;
    const custom = await askNumber(customTitle, String(current));
    return custom === undefined ? undefined : (Math.round(custom) as T);
  };
  const askNumber = async (title: string, placeholder: string): Promise<number | undefined> => {
    const raw = await ctx.ui.input(title, placeholder);
    if (raw === undefined || !raw.trim()) return undefined;
    const n = Number(raw.trim());
    if (!Number.isFinite(n) || n < 0) { ctx.ui.notify(`Not a number: ${raw}`, "error"); return undefined; }
    return n;
  };

  for (;;) {
    const cfg = loadConfig();
    const s = resolveWarmSettings(cfg.cacheWarm ?? {});
    const st = warmer.status();
    const state = st.running
      ? `arming${st.nextWarmAt ? `, next in ${Math.max(0, Math.round((st.nextWarmAt - Date.now()) / 1000))}s` : ""}`
      : `idle (${st.reason ?? "no request captured yet"})`;
    const choice = await ctx.ui.select(
      `Cache warming — ${s.mode}, refresh ${s.refreshSeconds}s, horizon ${s.horizonMinutes}m, ≥${s.minPromptTokens.toLocaleString("en-US")} tokens\n` +
      `Engine: ${state}; ${st.warms} warms (${st.hits} hits, ${st.rewrites} rewrites, ${st.blind} blind, ${st.failures} failed)`,
      [
        "Engine…",
        "Refresh interval…",
        "Horizon (how long to keep warming)…",
        "Minimum prompt size…",
        "Telemetry log (alibaba-cache.jsonl)",
        "Warm now",
        "Cache statistics",
        "Done",
      ],
    );
    if (!choice || choice === "Done") break;

    if (choice === "Engine…") {
      const items = ["extension", "pi", "off"].map((m) => ({ value: m as WarmMode, label: WARM_MODE_LABELS[m as WarmMode] }));
      const mode = await pickPreset(ctx, "Who keeps the Cloud prompt cache alive?", items, s.mode);
      if (mode) patch({ mode });
      continue;
    }
    if (choice === "Refresh interval…") {
      const v = await preset(
        "Seconds between refreshes (the block lives 300 s):",
        REFRESH_PRESETS, s.refreshSeconds, "Custom refresh seconds (60–270):",
      );
      if (v !== undefined) patch({ refreshSeconds: v });
      continue;
    }
    if (choice.startsWith("Horizon")) {
      const v = await preset(
        "Keep warming this long after the last request:",
        HORIZON_PRESETS, s.horizonMinutes, "Custom horizon in minutes (1–1440):",
      );
      if (v !== undefined) patch({ horizonMinutes: v });
      continue;
    }
    if (choice.startsWith("Minimum prompt")) {
      const v = await preset(
        "Skip prompts smaller than:",
        MIN_PROMPT_PRESETS, s.minPromptTokens, "Custom minimum prompt tokens:",
      );
      if (v !== undefined) patch({ minPromptTokens: v });
      continue;
    }
    if (choice.startsWith("Telemetry")) {
      patch({ telemetry: !s.telemetry });
      ctx.ui.notify(`Cache telemetry ${s.telemetry ? "off" : `on → ${logPath}`}`, "info");
      continue;
    }
    if (choice === "Warm now") {
      const res = await warmer.warmNow();
      if (!res) { ctx.ui.notify("Nothing to warm yet: no Cloud request has been sent in this session.", "warning"); continue; }
      ctx.ui.notify(
        res.ok
          ? `Warm ${res.rewrote ? "re-created an expired block" : "hit"}: ` +
            `${(res.usage?.cached ?? 0).toLocaleString("en-US")} cached, ` +
            `${(res.usage?.creation ?? 0).toLocaleString("en-US")} created, ${Math.round(res.ms)}ms`
          : `Warm failed: ${res.error ?? `HTTP ${res.status}`}`,
        res.ok ? "info" : "error",
      );
      continue;
    }
    if (choice === "Cache statistics") {
      const sum = summarizeCacheLog(readCacheLog(logPath));
      if (!sum.turns && !sum.warms) { ctx.ui.notify(`No records in ${logPath} yet.`, "info"); continue; }
      const span = sum.first && sum.last ? `${new Date(sum.first).toISOString().slice(5, 16)} → ${new Date(sum.last).toISOString().slice(5, 16)}` : "";
      ctx.ui.notify(
        [
          `Cache telemetry ${span}`,
          `Turns:  ${sum.turns} — ${sum.turnHits} hit / ${sum.turnMisses} cold` +
            (sum.hitRatePct === null ? "" : ` (${sum.hitRatePct}%)`),
          `Tokens: ${sum.cachedTokens.toLocaleString("en-US")} cached, ${sum.missedTokens.toLocaleString("en-US")} re-read at full price`,
          `Warms:  ${sum.warms} — ${sum.warmHits} hits, ${sum.warmRewrites} arrived after expiry, ` +
            `${sum.warmBlind} blind, ${sum.warmFailures} failed`,
          sum.warmRewrites ? "Rewrites mean the refresh interval is too long for this prompt size." : "",
          sum.warmBlind
            ? "Blind replays reported neither a hit nor a creation — the block was not renewed. " +
              "Three in a row end the run; a model that keeps doing it is not warmable this way."
            : "",
        ].filter(Boolean).join("\n"),
        "info",
      );
      continue;
    }
  }
  if (dirty) {
    ctx.ui.notify("Cache warming settings saved.", "info");
    await ctx.reload();
  }
}

export default async function (pi: ExtensionAPI) {
  // Refuse to run next to another configured copy of this plugin. pi resolves
  // the resulting `alibaba-cloud` registration collision last-wins, so the
  // shadowed copy's wire format and maxTokens silently lose — the failure that
  // truncated long answers at 1024 output tokens (see duplicate-guard.ts).
  // Runs first: nothing may be registered for a session that must not start.
  assertSingleInstall({
    agentDir: HOME_DIR,
    cwd: process.cwd(),
    selfDir: resolveOwnPackageDir(),
    argv: process.argv.slice(2),
  });

  // Enforce the host floor that ADR-0001 documents (pi's packaging guidance keeps
  // peerDependencies at `*`, so the version is checked here). On a pre-1.0.0 host
  // the model-config union and `exposure` do not exist; fail loudly instead of
  // registering a half-working provider.
  if (!hostVersionSupported(VERSION)) {
    throw new Error(
      `${SELF_VERSION} requires pi 1.0.0 or newer (found ${VERSION}). ` +
      `Stay on pi-alibaba-models 1.5.3 for older hosts.`,
    );
  }

  migrateLegacyAuth();
  const config = loadConfig();
  if (migrateToolExposure(config)) saveConfig(config);

  // Raw provider stream events are captured per provider/model and classified
  // by structure, so a rate limit or backend failure phrased a new way is still
  // retried. Notification-only: the rewrite below reads the classification when
  // the wording-based matchers cannot recognize the turn, and the text matchers
  // stay as the fallback for turns where no raw event was seen.
  const streamErrorByModel = new Map<string, StreamErrorClass>();
  // Raw cache counters of the response being streamed, per provider/model.
  // pi normalizes usage before `message_end` and drops the creation counters
  // (DashScope reports them only in `usage.x_details[].prompt_tokens_details`),
  // so the raw event is the only place they exist.
  const cacheFieldsByModel = new Map<string, CacheUsage>();
  // Prefix head of the request in flight, per model, so a turn record can say
  // which context it belongs to: one process can serve several (a child agent,
  // a sidecar call), and without the id a miss cannot be attributed to any of
  // them — which is what made the 2026-10-11 warm investigation guesswork.
  const warmCtxByModel = new Map<string, string>();
  pi.on("provider_stream_event", (event) => {
    if (event.provider !== "alibaba-plan" && event.provider !== "alibaba-cloud") return;
    const cls = classifyStreamError(event.data);
    if (cls) streamErrorByModel.set(`${event.provider}/${event.model}`, cls);
    if (event.provider !== "alibaba-cloud") return;
    const fields = cacheFieldsFromStreamEvent(event.api, event.data);
    if (fields) cacheFieldsByModel.set(`${event.provider}/${event.model}`, fields);
  });

  // ── Prompt cache: warming, markers, telemetry (Cloud) ────────────────
  const warmSettings = (): WarmSettings => resolveWarmSettings(loadConfig().cacheWarm ?? {});
  const warmer: CacheWarmer = createCacheWarmer({
    settings: warmSettings,
    logFile: () => CACHE_LOG_PATH,
    log: process.env.PI_ALIBABA_CACHE_DEBUG === "1" ? (line) => console.error(line) : undefined,
  });
  // Headers of the request being dispatched. `before_provider_headers` fires
  // first (pi-ai resolves auth, then builds the payload), and the object pi
  // hands over is mutated in place, so it is copied.
  let pendingHeaders: Record<string, string> | undefined;

  pi.on("before_provider_headers", (event, ctx) => {
    if (ctx.model?.provider !== "alibaba-cloud") { pendingHeaders = undefined; return; }
    const copy: Record<string, string> = {};
    for (const [k, v] of Object.entries(event.headers ?? {})) {
      if (typeof v === "string") copy[k] = v;
    }
    pendingHeaders = copy;
  });

  pi.on("before_provider_request", (event, ctx) => {
    const model = ctx.model;
    if (model?.provider !== "alibaba-cloud") return;
    const headers = pendingHeaders;
    pendingHeaders = undefined;
    // Chat Completions has no session-cache header: models whose catalog rows
    // include explicit-cache prices get markers instead, which turns their
    // probabilistic implicit hits into deterministic explicit ones.
    let outgoing = event.payload;
    if (
      model.api === "openai-completions" &&
      loadConfig().cloudCacheControl !== false &&
      cloudPricesFor(model.id)?.explicitCache
    ) {
      const marked = injectCacheControl(event.payload);
      if (marked) outgoing = marked.payload;
    }
    // Captured verbatim so a warm replays a byte-identical prefix. Compaction
    // and branch summaries never arrive here: pi wires `onPayload`, which is
    // what emits this event, only through the agent loop, and builds summary
    // options without it (re-verified in pi 1.1.0 and in 1.2.0, where
    // compaction still passes the bare stream function). They *do* reach
    // `before_provider_headers`, so `pendingHeaders` can briefly hold a
    // summary's headers — harmless, because nothing is captured without a
    // payload event and the next real request overwrites them first. pi's own
    // warmer skips summaries the same way, by routing id.
    if (headers) {
      const warmCtx = contextId(outgoing, model.api);
      if (!modelCachesPrompt(model.id)) {
        // Warming a model with no cache rows would buy nothing and spend quota.
        warmer.invalidate(`${model.id} has no prompt caching`);
      } else {
        if (warmCtx) warmCtxByModel.set(`${model.provider}/${model.id}`, warmCtx);
        warmer.noteRequest({
          provider: model.provider,
          model: model.id,
          api: model.api,
          baseUrl: model.baseUrl,
          headers,
          payload: outgoing,
          at: Date.now(),
          ctx: warmCtx,
        });
        warmer.noteInFlight(true);
      }
    }
    return outgoing === event.payload ? undefined : outgoing;
  });

  pi.on("message_end", (event, ctx) => {
    const m = event.message;
    if (m.role !== "assistant" || m.provider !== "alibaba-cloud") return;
    warmer.noteInFlight(false);
    const key = `${m.provider}/${m.model}`;
    const raw = cacheFieldsByModel.get(key);
    cacheFieldsByModel.delete(key);
    const warmCtx = warmCtxByModel.get(key);
    warmCtxByModel.delete(key);
    // A handler that throws would surface on the turn it was only measuring,
    // so every field is read defensively.
    const usage = m.usage ?? { input: 0, cacheRead: 0, cacheWrite: 0 };
    const promptTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
    warmer.notePromptTokens(promptTokens, warmCtx);
    if (!warmSettings().telemetry) return;
    appendCacheLog(CACHE_LOG_PATH, {
      ts: m.timestamp || Date.now(),
      kind: "turn",
      provider: m.provider,
      model: m.model,
      api: ctx.model?.api ?? "",
      ctx: warmCtx,
      promptTokens,
      cached: raw?.cached ?? usage.cacheRead ?? 0,
      creation: raw?.creation ?? usage.cacheWrite ?? 0,
      cacheType: raw?.cacheType,
      ok: m.stopReason !== "error",
    });
  });

  // A warm must never overlap a real request, and an aborted turn fires no
  // `message_end`, so the run boundary clears the flag too.
  pi.on("agent_end", () => warmer.noteInFlight(false));
  // Anything that rewrites the transcript invalidates the cached prefix, so the
  // captured request is no longer worth replaying.
  pi.on("session_before_compact", () => warmer.invalidate("compaction rewrites the prefix"));
  pi.on("session_before_tree", () => warmer.invalidate("branch switch rewrites the prefix"));
  pi.on("session_before_switch", () => warmer.invalidate("session switch"));
  pi.on("model_select", () => warmer.invalidate("model switch changes the cached prefix"));
  pi.on("session_start", () => warmer.invalidate("session start"));
  pi.on("session_shutdown", () => warmer.stop());

  // Mode `pi`: pi's warmer decides by expected *savings*, which for a corporate
  // key is the wrong question — a cold 200k-token prompt costs a minute, not a
  // cent. The hook swaps in the latency rule; pi's 30/60-minute caps still
  // apply, which is what mode `extension` exists for.
  pi.on("cache_warming_decision", (event) =>
    warmingDecisionOverride(warmSettings(), warmer.status().promptTokens, event));

  // DashScope reports some transient failures as SSE `server_error` events
  // over HTTP 200: rate limits with `<429>` in the message, and inference-
  // backend `Backend buffer overflow` errors. Prefix the assistant error so
  // modern pi's retry classifier matches it — a bare `Backend buffer
  // overflow.` carries no retryable marker and would fail the turn at once.
  pi.on("message_end", (event) => {
    const { message } = event;
    if (message.role !== "assistant") return;
    if (message.provider !== "alibaba-plan" && message.provider !== "alibaba-cloud") return;
    const key = `${message.provider}/${message.model}`;
    const cls = streamErrorByModel.get(key);
    // Consumed on every finalized assistant message, so a classification from a
    // recovered turn cannot leak into a later permanent error.
    streamErrorByModel.delete(key);
    if (message.stopReason !== "error") return;
    const errorMessage = message.errorMessage ?? "";
    const rewritten =
      rewriteDashScopeRateLimitErrorMessage(errorMessage) ??
      rewriteDashScopeBackendOverflowMessage(errorMessage) ??
      rewriteFromStreamError(errorMessage, cls);
    if (!rewritten) return;
    return { message: { ...message, errorMessage: rewritten } };
  });

  // A tool with `codemode` exposure never activates, so `promptSnippet` and
  // `promptGuidelines` are never rendered. One system-prompt section tells the
  // model the tools exist and points image generation at the recommended
  // family. Present only while at least one Alibaba tool is codemode-exposed.
  //
  // Since pi 1.2.0 the event is a union on `messageType`: "user" for prompts,
  // "custom" for runs started by pi.sendMessage(..., { triggerTurn: true }).
  // The section deliberately applies to both kinds — a custom run reaches the
  // same tools, and 1.2.0 is the release that stops such runs from dropping
  // before_agent_start sections after their first tool call. No messageType
  // guard: this handler reads no user-only field, and a pre-1.2.0 host sends
  // no messageType at all, so the same code keeps working on the 1.0.0 floor.
  pi.on("before_agent_start", (event) => {
    const cfg = loadConfig();
    const callable: string[] = [];
    if (resolveToolsExposure(cfg) === "codemode") {
      callable.push("`alibaba_tools` (billed Qwen sidecar: web search, page extraction, sandbox computation, image search)");
    }
    if (resolveImageExposure(cfg) === "codemode") {
      callable.push("`alibaba_image` (DashScope image generation and editing)");
    }
    if (!callable.length) return;
    event.systemPromptOptions.sections = {
      ...event.systemPromptOptions.sections,
      alibaba:
        `Alibaba tools are callable from codemode scripts: ${callable.join("; ")}. ` +
        "Prefer `qwen-image-*` models for image generation.",
    };
  });

  // Startup contract (plan C): seed registration from the private bundle;
  // when the bundle is missing (first run, fresh agent dir, right after
  // "Reset all") force-refresh right here instead of booting an empty catalog
  // and waiting for session_start. The lockfile keeps a fleet from all
  // fetching — a loser of the race just registers what the winner bundled.
  seedFromSnapshot();
  const planCred = readAuth()["alibaba-plan"];
  const bootKey = readCloudKey();
  // A swapped key re-derives the Cloud endpoint (default first, then corporate)
  // before any fetch can hit the previous key's endpoint.
  if (bootKey) await ensureCloudEndpointBound(bootKey);
  if (!planDefs.length && planCred?.access) await loadPlanCatalog(true);
  if (bootKey && (!cloudDefs.length || cloudDefs === CLOUD_LOGIN_SEED || !cloudImagesLoaded)) {
    await loadCloudCatalog(loadConfig().cloudDomain || DEFAULT_CLOUD_DOMAIN, bootKey, true);
  }
  seedFromSnapshot();
  // Keep the Cloud provider visible in /login even with no models yet (issue #1).
  if (!cloudDefs.length) cloudDefs = CLOUD_LOGIN_SEED;
  registerPlanProvider(pi);
  registerCloudProvider(pi);

  // ── Lazy refresh: fetch live catalogs and re-register ───────────────
  // Lazy refresh on session start: the one-shot workspace-domain upgrade, then
  // pi's own refresh path — our refreshModels handlers fetch under the
  // cross-instance lock and publish the snapshot once, so parallel pi instances
  // share one catalog fetch and one models-store.json write.
  pi.on("session_start", async (_event, ctx) => {
   try {
    const key = readCloudKey();
    if (key) {
      const before = loadConfig().cloudDomain || DEFAULT_CLOUD_DOMAIN;
      // A swapped key re-derives the endpoint first (default → corporate); the
      // boot auto-upgrade then takes a plain shared domain the rest of the way.
      await ensureCloudEndpointBound(key);
      const up = await upgradeCloudDomainToWorkspace(key);
      if (up.status === "upgraded") {
        console.warn(`[alibaba] Cloud endpoint auto-upgraded to the workspace domain ${up.domain} (WorkspaceId ${up.wsid}).`);
      }
      if ((loadConfig().cloudDomain || DEFAULT_CLOUD_DOMAIN) !== before) registerCloudProvider(pi); // baseUrl changed
    }
    await ctx.modelRegistry.refresh();
   } catch (e: any) {
    console.warn(`[alibaba] session_start catalog refresh failed (${e?.message || e}); keeping previously loaded models.`);
   }
  });

  // ── Command: /alibaba ──────────────────────────────────────────────
  // The image surface reads live config and the curated image catalogue
  // through deps, so image-tool.ts needs no import back into this module.
  const imageDeps: ImageToolDeps = {
    loadConfig: () => loadConfig(),
    imageCatalogIds: () => cloudImageDefs.map((r) => r.id),
  };
  pi.registerCommand("alibaba", {
    description: "Manage Alibaba (Plan + Cloud) configuration, or generate an image with /alibaba image <prompt>",
    handler: async (args, ctx: ExtensionCommandContext) => {
      // Subcommand form: `/alibaba image <prompt> [flags]` generates an image
      // without codemode (it calls the model registry directly). `image` is the
      // only reserved first word; a bare `/alibaba` opens the menu.
      const sub = args.trim();
      if (sub === "image" || sub.startsWith("image ")) {
        await runImageCommand(pi, sub.slice("image".length).trim(), ctx, imageDeps);
        return;
      }
      if (sub && !sub.startsWith("image")) {
        ctx.ui.notify(`Unknown /alibaba subcommand: ${sub.split(/\s+/)[0]}. Try: /alibaba image <prompt>`, "error");
        return;
      }
      const choice = await ctx.ui.select("Alibaba:", [
        "Status",
        "Refresh model lists",
        "Re-login Plan",
        "Re-login Cloud",
        "Plan — Change Endpoints",
        "Cloud — Change Domain",
        "Cloud — Auto workspace domain",
        "Cloud — Change API Format",
        "Cloud — Session Cache: On / Off",
        "Cloud — Responses Input Guard: On / Off",
        "Cloud — Cache Warming",
        "Tools — Exposure",
        "Tools — Sidecar model",
        "Image — Default model",
        "Rate limits (Cloud)",
        "Cloud — Authorized-only Filter",
        "Context Window — Override",
        "Reset all",
      ]);
      if (!choice) return;

      const cfg = loadConfig();
      const auth = readAuth();
      const planCred = auth["alibaba-plan"];
      const cloudCred = auth["alibaba-cloud"];

      if (choice === "Status") {
        const ep = resolvePlanEndpoints(planCred);
        const age = (t?: number) => (t ? `${Math.round((Date.now() - t) / 60000)}m old` : "not fetched yet");
        const planState = planDefs.length ? `fetched ${age(cfg.planFetchedAt)}` : "not fetched";
        const cloudState = cloudDefs.length ? `fetched ${age(cfg.cloudFetchedAt)}` : "not fetched";
        const cloudFmt = (cfg.cloudApiFormat || DEFAULT_CLOUD_FORMAT) as CloudApiFormat;
        const fallbacks = countFallbackModels(cloudDefs, cloudFmt);
        const lines = [
          `Plan:  ${planCred ? "logged in" : "not logged in"}`,
          `       Anthropic: ${ep.anthropic}`,
          `       OpenAI:    ${ep.openai}`,
          `       Models:    ${planDefs.length} (${planState})`,
          ``,
          `Cloud: ${cloudCred ? "logged in" : (process.env.DASHSCOPE_API_KEY ? "via $DASHSCOPE_API_KEY" : "not logged in")}`,
          `       Domain:    ${cfg.cloudDomain || DEFAULT_CLOUD_DOMAIN}`,
          `       Auto-WS:   ${cfg.cloudAutoWorkspaceDomain === false ? "off" : "on"}${cfg.cloudWorkspaceId ? ` (WorkspaceId ${cfg.cloudWorkspaceId})` : ""}`,
          `       Format:    ${cloudFmt}${fallbacks ? ` (${fallbacks} model${fallbacks === 1 ? "" : "s"} fall back to Chat Completions)` : ""}`,
          `       Sess.cache: ${cfg.cloudSessionCache === false ? "off" : "on (Responses header)"}`,
          `       Input guard: ${cfg.responsesInputGuard === false ? "off (full catalog window)" : "on (cards declare the endpoint's input cap)"}`,
          `       Markers:   ${cfg.cloudCacheControl === false ? "off" : "on (cache_control on Completions)"}`,
          ...cacheStatusLines(cfg, warmer, CACHE_LOG_PATH),
          ...modelLines(ctx.model, cfg),
          `       Sidecar:   ${resolveToolsExposure(cfg) === "off" ? "off" : `${resolveToolsExposure(cfg)} (${cfg.cloudSidecarModel || "auto Qwen"})`}`,
          `       Auth-only: ${cfg.cloudAuthorizedOnly === false ? "off" : "on (when endpoint available)"}${cfg.cloudAuthorizedFilteredLast ? " — active (filtered list)" : ""}`,
          `       Models:    ${cloudDefs.length} chat (${cloudState})`,
          `       Images:    ${cloudImageDefs.length} registered; default ${cfg.imageModel || DEFAULT_IMAGE_MODEL}`,
          `       Tools:     alibaba_tools=${resolveToolsExposure(cfg)}, alibaba_image=${resolveImageExposure(cfg)}`,
        ];
        const overrides = cfg.contextWindowOverrides;
        if (overrides && Object.keys(overrides).length) {
          lines.push("", "Context window overrides:");
          for (const [id, n] of Object.entries(overrides)) {
            lines.push(`       ${id}: ${n.toLocaleString()} tokens`);
          }
        }
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (choice === "Refresh model lists") {
        try {
          // pi's own refresh path: our `refreshModels` handlers fetch and pi
          // persists the result (`force` bypasses its freshness checks).
          const res = await ctx.modelRegistry.refresh({ force: true });
          const failed = [...res.errors.values()].map((err: any) => err?.message || String(err));
          ctx.ui.notify(
            `Plan: ${planDefs.length} models. Cloud: ${cloudDefs.length} models.` +
              (failed.length ? `\nFailed: ${failed.join("; ")}` : ""),
            failed.length ? "warning" : "info",
          );
        } catch (e: any) {
          ctx.ui.notify(`Failed: ${e?.message || e}`, "error");
        }
        return;
      }

      if (choice === "Re-login Plan") {
        if (!await ctx.ui.confirm("Wipe Plan credentials and re-login?", "Removes alibaba-plan from auth.json")) return;
        // Use authStorage.remove() rather than fs.write — it persists AND updates pi's
        // in-memory credential map, so /login's `• configured` label refreshes without restart.
        authStore(ctx).remove("alibaba-plan");
        ctx.ui.notify("Plan credentials wiped. Run /login → Alibaba Model Studio Coding Plan.", "info");
        await ctx.reload();
        return;
      }

      if (choice === "Re-login Cloud") {
        if (!await ctx.ui.confirm("Wipe Cloud credentials and re-login?", "Removes alibaba-cloud from auth.json")) return;
        authStore(ctx).remove("alibaba-cloud");
        // The replacement key is a NEW binding: drop the fingerprint so its
        // endpoint is re-derived (default first, then corporate) on first use.
        const rebindCfg = loadConfig();
        delete rebindCfg.cloudKeyFingerprint;
        saveConfig(rebindCfg);
        resetCloudKeyBindingGuard();
        ctx.ui.notify("Cloud credentials wiped. Run /login → Use an API key → Alibaba Cloud (API Key).", "info");
        await ctx.reload();
        return;
      }

      if (choice === "Plan — Change Endpoints") {
        const o = (await ctx.ui.input("OpenAI-compat base URL:")) || "";
        const a = (await ctx.ui.input("Anthropic-compat base URL:")) || "";
        if (o && a) {
          cfg.planOpenAI = o; cfg.planAnthropic = a; saveConfig(cfg);
          // Also rewrite the active credential's refresh-blob so resolvePlanEndpoints
          // (which prefers credentials.refresh over config) picks up the new endpoints
          // for the existing logged-in session — otherwise the change only takes effect
          // after the user logs out + back in.
          const store = authStore(ctx);
          const currentPlan = store.get("alibaba-plan");
          if (currentPlan?.type === "oauth") {
            store.set("alibaba-plan", {
              ...currentPlan,
              refresh: JSON.stringify({ openai: o, anthropic: a }),
            });
          }
          ctx.ui.notify("Plan endpoints updated.", "info");
          await ctx.reload();
        }
        return;
      }

      if (choice === "Cloud — Change Domain") {
        const sel = await ctx.ui.select("Cloud endpoint:", [
          `International (${DEFAULT_CLOUD_DOMAIN})`,
          `China (${DEFAULT_CLOUD_CN_DOMAIN})`,
          `US — Virginia (${DEFAULT_CLOUD_US_DOMAIN})`,
          `Hong Kong (${DEFAULT_CLOUD_HK_DOMAIN})`,
          "China — Beijing workspace domain…",
          "Singapore workspace domain…",
          "Japan — Tokyo workspace domain…",
          "Germany — Frankfurt workspace domain…",
          "US — workspace domain…",
          "Custom…",
        ]);
        if (!sel) return;
        let domain = sel.match(/\(([^)]+)\)/)?.[1] || "";
        if (sel.endsWith("workspace domain…")) {
          const region = sel.startsWith("China")
            ? WSID_BEIJING
            : sel.startsWith("Singapore")
              ? WSID_SINGAPORE
              : sel.startsWith("Japan")
                ? WSID_TOKYO
                : sel.startsWith("US")
                  ? WSID_US
                  : WSID_FRANKFURT;
          const cached = sanitizeWorkspaceId(cfg.cloudWorkspaceId);
          const input = await ctx.ui.input(
            "Model Studio business-space ID (console → 业务空间详情):",
            cached || "llm-…",
          );
          if (input === undefined) return; // dismissed
          // Blank input falls back to the WorkspaceId discovered by the
          // auto-upgrade (/alibaba → Cloud — Auto workspace domain).
          const wsid = sanitizeWorkspaceId(input) ?? cached;
          if (wsid) domain = workspaceDomain(wsid, region);
        }
        if (sel.startsWith("Custom")) domain = (await ctx.ui.input("Cloud domain:")) || "";
        if (domain) {
          // Explicitly landing on a shared regional domain means “stay here” —
          // opt out of the boot auto-upgrade so it never fights this choice.
          if (regionForSharedCloudDomain(domain)) cfg.cloudAutoWorkspaceDomain = false;
          cfg.cloudDomain = domain; saveConfig(cfg);
          ctx.ui.notify(`Cloud domain: ${domain}`, "info");
          await ctx.reload();
        }
        return;
      }

      if (choice === "Cloud — Auto workspace domain") {
        const DETECT = "Detect & upgrade now";
        const ENABLE = "Enable auto-upgrade on boot";
        const DISABLE = "Disable auto-upgrade on boot";
        const enabled = cfg.cloudAutoWorkspaceDomain !== false;
        const cached = sanitizeWorkspaceId(cfg.cloudWorkspaceId);
        const current = cfg.cloudDomain || DEFAULT_CLOUD_DOMAIN;
        const onWorkspace = parseWorkspaceCloudDomain(current);
        const sel = await ctx.ui.select(
          `Auto workspace domain — ${enabled ? "enabled" : "disabled"}` +
            (cached ? `, WorkspaceId ${cached}` : "") +
            ` (current: ${current}${onWorkspace ? " — already a workspace domain" : ""}):`,
          [DETECT, enabled ? DISABLE : ENABLE],
        );
        if (!sel) return;
        if (sel === DETECT) {
          const key = readCloudKey();
          if (!key) {
            ctx.ui.notify("Cloud not logged in — no key in auth.json and no $DASHSCOPE_API_KEY. Run /login first.", "error");
            return;
          }
          const up = await upgradeCloudDomainToWorkspace(key, true);
          if (up.status === "upgraded") {
            ctx.ui.notify(`Cloud domain upgraded to ${up.domain} (WorkspaceId ${up.wsid}). Reloading…`, "info");
            await ctx.reload();
          } else if (up.status === "demoted") {
            ctx.ui.notify(
              `${up.reason}. Fell back to the shared ${up.domain}; auto-upgrade disabled — re-enable it from this menu once your key's workspace is discoverable. Reloading…`,
              "warning",
            );
            await ctx.reload();
          } else if (up.status === "already") {
            ctx.ui.notify(`Cloud is ${up.reason} — nothing to upgrade.`, "info");
          } else {
            ctx.ui.notify(`Not upgraded (${up.status}): ${up.reason}.`, "warning");
          }
          return;
        }
        cfg.cloudAutoWorkspaceDomain = sel === ENABLE;
        saveConfig(cfg);
        ctx.ui.notify(
          cfg.cloudAutoWorkspaceDomain
            ? "Auto workspace-domain upgrade enabled — applied on the next boot while on a shared regional domain."
            : "Auto workspace-domain upgrade disabled.",
          "info",
        );
        return;
      }

      if (choice === "Cloud — Change API Format") {
        const sel = await ctx.ui.select("Cloud API format:", [
          "OpenAI Responses (recommended)",
          "Anthropic Messages",
          "OpenAI Chat Completions",
        ]);
        if (!sel) return;
        cfg.cloudApiFormat = sel.startsWith("Anthropic")
          ? "anthropic-messages"
          : sel.startsWith("OpenAI Responses")
            ? "openai-responses"
            : "openai-completions";
        saveConfig(cfg);
        ctx.ui.notify(`Cloud format: ${cfg.cloudApiFormat}`, "info");
        await ctx.reload();
        return;
      }

      if (choice === "Cloud — Session Cache: On / Off") {
        const on = cfg.cloudSessionCache !== false;
        cfg.cloudSessionCache = !on;
        saveConfig(cfg);
        ctx.ui.notify(
          `Session cache (x-dashscope-session-cache, Responses format): ${on ? "off" : "on"}.\n` +
          `Writes are billed at 125% of input and re-read at ~10%: keep it on for multi-turn\n` +
          `agent sessions (net win), off if pi is mostly one-shot prompts.`,
          "info",
        );
        await ctx.reload();
        return;
      }

      if (choice === "Cloud — Responses Input Guard: On / Off") {
        const on = cfg.responsesInputGuard !== false;
        cfg.responsesInputGuard = !on;
        saveConfig(cfg);
        ctx.ui.notify(
          `Responses input guard: ${on ? "off" : "on"}.\n` +
          `The Responses endpoint accepts ~80% of the context window as input and silently truncates\n` +
          `the rest, so with the guard on a 1M model is registered as 800k and pi compacts first.\n` +
          `Off keeps the full window on the card and accepts the truncation.`,
          "info",
        );
        await ctx.reload();
        return;
      }

      if (choice === "Cloud — Cache Warming") {
        await cacheWarmMenu(ctx, warmer, CACHE_LOG_PATH);
        return;
      }

      if (choice === "Tools — Exposure") {
        const tool = await ctx.ui.select("Which tool?", [
          `alibaba_tools (sidecar, billed) — now ${resolveToolsExposure(cfg)}`,
          `alibaba_image (image generation) — now ${resolveImageExposure(cfg)}`,
        ]);
        if (!tool) return;
        const isImage = tool.startsWith("alibaba_image");
        const current = isImage ? resolveImageExposure(cfg) : resolveToolsExposure(cfg);
        const options = TOOL_EXPOSURES.map((e) => `${current === e ? "• " : "  "}${TOOL_EXPOSURE_LABELS[e]}`);
        const sel = await ctx.ui.select(
          `${isImage ? "alibaba_image" : "alibaba_tools"} exposure (now ${current}):`,
          options,
        );
        if (!sel) return;
        const idx = options.indexOf(sel);
        const picked = idx >= 0 ? TOOL_EXPOSURES[idx] : current;
        const next: AlibabaConfig = { ...cfg };
        if (isImage) next.alibabaImageExposure = picked;
        else next.alibabaToolsExposure = picked;
        saveConfig(next);
        const note = picked === "codemode"
          ? " Requires codemode to be enabled in pi; with codemode off this tool is unreachable."
          : "";
        ctx.ui.notify(`${isImage ? "alibaba_image" : "alibaba_tools"} exposure: ${picked}.${note} Reloading…`, "info");
        await ctx.reload();
        return;
      }

      if (choice === "Tools — Sidecar model") {
        const id = (await ctx.ui.input(
          `Sidecar Qwen model id (blank = auto; currently ${cfg.cloudSidecarModel || "auto"}):`,
        ))?.trim();
        if (id === undefined) return;
        if (id) cfg.cloudSidecarModel = id;
        else delete cfg.cloudSidecarModel;
        saveConfig(cfg);
        ctx.ui.notify(`Sidecar model: ${cfg.cloudSidecarModel || "auto (Qwen Flash/Plus preferred)"}.`, "info");
        return;
      }

      if (choice === "Image — Default model") {
        const ids = cloudImageDefs.map((r) => r.id);
        const CLEAR = "Clear (pick automatically)";
        const sel = await ctx.ui.select(
          `Default image model (now ${cfg.imageModel || DEFAULT_IMAGE_MODEL}):`,
          [...ids, CLEAR],
        );
        if (!sel) return;
        if (sel === CLEAR) delete cfg.imageModel;
        else cfg.imageModel = sel;
        saveConfig(cfg);
        ctx.ui.notify(`Default image model: ${cfg.imageModel || `${DEFAULT_IMAGE_MODEL} (auto)`}`, "info");
        return;
      }

      if (choice === "Rate limits (Cloud)") {
        const key = readCloudKey();
        if (!key) {
          ctx.ui.notify("Cloud not logged in — no key in auth.json and no $DASHSCOPE_API_KEY. Run /login first.", "error");
          return;
        }
        const domain = cfg.cloudDomain || DEFAULT_CLOUD_DOMAIN;
        const quotas = await fetchCloudQuotas(domain, key);
        if (!quotas) {
          ctx.ui.notify(
            `Could not fetch rate limits from https://${domain}/api/v1/models/limits. ` +
            "This endpoint is only documented on the Beijing workspace domain so far — set one via " +
            "/alibaba → Cloud — Change Domain (e.g. {WorkspaceId}.cn-beijing.maas.aliyuncs.com) and retry.",
            "error",
          );
          return;
        }
        const chatIds = cloudDefs.length > 1 ? new Set(cloudDefs.map((m) => m.id)) : null;
        const entries = [...quotas.values()].filter((q) => !chatIds || chatIds.has(q.model)).sort((a, b) => a.model.localeCompare(b.model));
        const MAX_SHOWN = 60;
        const lines = [`Rate limits — ${domain} (showing ${Math.min(entries.length, MAX_SHOWN)} of ${quotas.size}):`];
        for (const q of entries.slice(0, MAX_SHOWN)) lines.push(`  ${q.model}: ${formatQuota(q)}`);
        if (entries.length > MAX_SHOWN) lines.push(`  … and ${entries.length - MAX_SHOWN} more`);
        if (!entries.length) lines.push("  (no quotas for the current model list)");
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (choice === "Cloud — Authorized-only Filter") {
        const next = cfg.cloudAuthorizedOnly === false;
        cfg.cloudAuthorizedOnly = next;
        saveConfig(cfg);
        ctx.ui.notify(`Cloud authorized-only filter: ${next ? "ON" : "OFF"} — reloading…`, "info");
        await ctx.reload();
        return;
      }

      if (choice === "Context Window — Override") {
        // Override the context-window shown on a model's card (e.g. when the
        // inferred size is wrong for a brand-new model). Pick a model id, or
        // "*" to set a default for every model without its own override.
        const ov = cfg.contextWindowOverrides || {};
        const fmt = (n: number) => n.toLocaleString();
        const ids = Array.from(new Set([...planDefs.map((m) => m.id), ...cloudDefs.map((m) => m.id)])).sort();
        const labelToId = new Map<string, string>();
        const opts: string[] = [];
        for (const id of ids) {
          const label = ov[id] ? `${id}  (override: ${fmt(ov[id])})` : id;
          labelToId.set(label, id);
          opts.push(label);
        }
        const allLabel = ov["*"] ? `* every other model  (override: ${fmt(ov["*"])})` : "* every other model";
        labelToId.set(allLabel, "*");
        opts.push(allLabel);
        const CLEAR = "Clear all overrides";
        opts.push(CLEAR);

        const sel = await ctx.ui.select("Override context window for:", opts);
        if (!sel) return;
        if (sel === CLEAR) {
          delete cfg.contextWindowOverrides;
          saveConfig(cfg);
          ctx.ui.notify("Cleared all context-window overrides.", "info");
          await ctx.reload();
          return;
        }
        const id = labelToId.get(sel) ?? sel;
        const current = ov[id];
        const val = (await ctx.ui.input(
          `Context window for ${id} in tokens — e.g. 1048576 (0 to remove)${current ? `; currently ${fmt(current)}` : ""}:`,
        ))?.trim();
        if (!val) return; // cancelled / left blank → no change
        const n = Number(val.replace(/[_,\s]/g, ""));
        if (!Number.isFinite(n) || n < 0) {
          ctx.ui.notify("Enter a non-negative number of tokens (0 removes the override).", "error");
          return;
        }
        cfg.contextWindowOverrides = cfg.contextWindowOverrides || {};
        if (n === 0) {
          delete cfg.contextWindowOverrides[id];
          ctx.ui.notify(`Removed context-window override for ${id}.`, "info");
        } else {
          cfg.contextWindowOverrides[id] = Math.floor(n);
          ctx.ui.notify(`Context window for ${id} set to ${fmt(Math.floor(n))} tokens.`, "info");
        }
        if (Object.keys(cfg.contextWindowOverrides).length === 0) delete cfg.contextWindowOverrides;
        saveConfig(cfg);
        await ctx.reload();
        return;
      }

      if (choice === "Reset all") {
        if (!await ctx.ui.confirm(
          "Reset all Alibaba settings?",
          "Wipes config, both auth entries, legacy catalog caches, the cache telemetry log, and any alibaba-* entries in settings.json (enabledModels + defaultProvider/defaultModel if alibaba). Run before `pi remove` for a clean uninstall.",
        )) return;
        try { fs.unlinkSync(CONFIG_PATH); } catch {}
        try { fs.unlinkSync(CATALOG_CACHE_PATH); } catch {}
        try { fs.unlinkSync(CACHE_LOG_PATH); } catch {}
        removeLegacyCaches();
        // Use authStorage.remove() so pi's in-memory credential cache stays in sync —
        // otherwise /login's "• configured" label persists until pi is restarted.
        const store = authStore(ctx);
        for (const k of ["alibaba", "alibaba-plan", "alibaba-cloud", "alibaba-studio", "alibaba-token", "dashscope"]) {
          store.remove(k);
        }
        resetCloudKeyBindingGuard();
        // Also strip stale alibaba-* / dashscope-* model ids from settings.json enabledModels,
        // and clear defaultProvider/defaultModel if they reference alibaba (otherwise pi would
        // try to default-launch into a now-missing provider).
        try {
          const SETTINGS_PATH = path.join(HOME_DIR, "settings.json");
          const s = readJSON<Record<string, any>>(SETTINGS_PATH, {});
          let touched = false;
          if (Array.isArray(s.enabledModels)) {
            const before = s.enabledModels.length;
            s.enabledModels = s.enabledModels.filter((id: string) =>
              typeof id === "string" && !/^(alibaba(-plan|-cloud|-studio|-token)?|dashscope)\//.test(id),
            );
            if (s.enabledModels.length !== before) touched = true;
          }
          if (typeof s.defaultProvider === "string" && /^(alibaba(-plan|-cloud|-studio|-token)?|dashscope)$/.test(s.defaultProvider)) {
            delete s.defaultProvider;
            delete s.defaultModel;
            touched = true;
          }
          if (touched) writeJSON(SETTINGS_PATH, s);
        } catch {}
        ctx.ui.notify("All Alibaba settings wiped. Now safe to `pi remove`.", "info");
        await ctx.reload();
        return;
      }
    },
  });

  registerAlibabaTools(pi, config, imageDeps);
}
