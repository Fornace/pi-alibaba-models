import type { ExtensionAPI, ProviderModelConfig, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Paths ─────────────────────────────────────────────────────────────
const HOME_DIR = path.join(os.homedir(), ".pi", "agent");
const CONFIG_PATH = path.join(HOME_DIR, "alibaba-config.json");
const AUTH_PATH = path.join(HOME_DIR, "auth.json");
const PLAN_CACHE_PATH = path.join(HOME_DIR, "alibaba-plan-models.cache.json");
const CLOUD_CACHE_PATH = path.join(HOME_DIR, "alibaba-cloud-models.cache.json");

const PLAN_MODELS_SOURCE = "https://raw.githubusercontent.com/QwenLM/qwen-code/main/packages/cli/src/constants/codingPlan.ts";
const MODELS_CACHE_TTL_MS = 48 * 60 * 60 * 1000;

const DEFAULT_PLAN_OPENAI = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";
const DEFAULT_PLAN_ANTHROPIC = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic";
const DEFAULT_CLOUD_DOMAIN = "dashscope-intl.aliyuncs.com";

// ── Config / auth helpers ─────────────────────────────────────────────
interface AlibabaConfig {
  planOpenAI?: string;
  planAnthropic?: string;
  cloudDomain?: string;
  cloudApiFormat?: "anthropic-messages" | "openai-completions";
}

const readJSON = <T>(p: string, fallback: T): T => {
  try { return JSON.parse(fs.readFileSync(p, "utf8")) as T; } catch { return fallback; }
};
const writeJSON = (p: string, data: unknown) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), { mode: 0o600 });
};
const loadConfig = (): AlibabaConfig => readJSON<AlibabaConfig>(CONFIG_PATH, {});
const saveConfig = (c: AlibabaConfig) => writeJSON(CONFIG_PATH, c);
const readAuth = (): Record<string, any> => readJSON<Record<string, any>>(AUTH_PATH, {});
const writeAuth = (a: Record<string, any>) => writeJSON(AUTH_PATH, a);

// ── Plan model definitions ────────────────────────────────────────────
// Anthropic-compatible by default; deepseek forced to openai-completions.
interface PlanModelDef {
  id: string; name: string; reasoning: boolean; contextWindow: number; maxTokens: number;
  input: ("text" | "image")[]; compat?: { thinkingFormat: "qwen" }; openaiOnly?: boolean;
}

// Hardcoded fallback (used when upstream fetch fails and no cache exists).
const PLAN_MODEL_DEFS_FALLBACK: PlanModelDef[] = [
  { id: "qwen3.6-plus",          name: "Qwen 3.6 Plus",      reasoning: true,  input: ["text", "image"], contextWindow: 1000000, maxTokens: 65536, compat: { thinkingFormat: "qwen" } },
  { id: "qwen3.5-plus",          name: "Qwen 3.5 Plus",      reasoning: true,  input: ["text", "image"], contextWindow: 1000000, maxTokens: 65536, compat: { thinkingFormat: "qwen" } },
  { id: "qwen3-coder-plus",      name: "Qwen 3 Coder Plus",  reasoning: false, input: ["text"],          contextWindow: 1000000, maxTokens: 65536 },
  { id: "qwen3-coder-next",      name: "Qwen 3 Coder Next",  reasoning: false, input: ["text"],          contextWindow: 262144,  maxTokens: 65536 },
  { id: "qwen3-max-2026-01-23",  name: "Qwen 3 Max",         reasoning: true,  input: ["text"],          contextWindow: 262144,  maxTokens: 16384, compat: { thinkingFormat: "qwen" } },
  { id: "glm-5",                 name: "GLM-5",              reasoning: true,  input: ["text"],          contextWindow: 202752,  maxTokens: 16384, compat: { thinkingFormat: "qwen" } },
  { id: "glm-4.7",               name: "GLM-4.7",            reasoning: true,  input: ["text"],          contextWindow: 202752,  maxTokens: 16384, compat: { thinkingFormat: "qwen" } },
  { id: "MiniMax-M2.5",          name: "MiniMax M2.5",       reasoning: true,  input: ["text"],          contextWindow: 196608,  maxTokens: 24576, compat: { thinkingFormat: "qwen" } },
  { id: "kimi-k2.5",             name: "Kimi K2.5",          reasoning: true,  input: ["text"],          contextWindow: 262144,  maxTokens: 16384, compat: { thinkingFormat: "qwen" } },
  { id: "deepseek-v3.2",         name: "DeepSeek V3.2",      reasoning: true,  input: ["text"],          contextWindow: 131072,  maxTokens: 16384, openaiOnly: true },
];

// Always-include extras for Plan: real models served on the plan endpoint
// that aren't listed in the upstream qwen-code template file. Verified live.
const PLAN_EXTRAS: PlanModelDef[] = [
  { id: "deepseek-v3.2",         name: "DeepSeek V3.2",      reasoning: true,  input: ["text"],          contextWindow: 131072,  maxTokens: 16384, openaiOnly: true },
];

// ── Cloud fallback ────────────────────────────────────────────────────
// Used both when /v1/models fetch fails AND merged into live results so
// curated/announced models always appear in the picker, even if DashScope's
// catalog hasn't surfaced them yet on this region/account.
const CLOUD_FALLBACK: ProviderModelConfig[] = [
  { id: "qwen3.6-plus",      name: "Qwen 3.6 Plus",  reasoning: true,  input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192, compat: { thinkingFormat: "qwen" } },
  { id: "qwen3.6-max-preview", name: "Qwen 3.6 Max (preview)", reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192, compat: { thinkingFormat: "qwen" } },
  { id: "qwen-max",          name: "Qwen Max",       reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 },
  { id: "qwen-plus",         name: "Qwen Plus",      reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 },
  { id: "qwen-turbo",        name: "Qwen Turbo",     reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 },
  { id: "qwen-long",         name: "Qwen Long",      reasoning: false, input: ["text"],          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 8192 },
  { id: "qwen-coder-plus",   name: "Qwen Coder Plus",reasoning: false, input: ["text"],          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 },
  { id: "deepseek-v3.2",     name: "DeepSeek V3.2",  reasoning: true,  input: ["text"],          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131072, maxTokens: 8192 },
];

// CLOUD_FALLBACK is used ONLY when the live /v1/models fetch fails. Live
// catalog is the single source of truth on success — invented or stale ids
// in fallback must never leak into the picker.

// ── Plan model fetch + parse + cache ──────────────────────────────────
interface PlanCache { fetchedAt: number; source: string; models: PlanModelDef[]; }

function parseCodingPlan(src: string): PlanModelDef[] {
  // Extract every object literal containing `id: '...'`. We match a balanced-ish
  // brace block by counting from the `{` preceding `id: '...'`. The upstream file
  // is plain TS object literals (no nested template literals, no `}` in strings).
  const out = new Map<string, PlanModelDef>();
  const idRe = /\bid:\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = idRe.exec(src)) !== null) {
    const id = m[1];
    if (out.has(id)) continue;
    // Walk backwards to find the opening `{` of this object literal.
    let i = m.index;
    while (i > 0 && src[i] !== "{") i--;
    if (src[i] !== "{") continue;
    // Walk forward to find the matching `}`.
    let depth = 0, j = i;
    for (; j < src.length; j++) {
      const c = src[j];
      if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) { j++; break; } }
    }
    const block = src.slice(i, j);
    const ctx = block.match(/contextWindowSize:\s*(\d+)/);
    const thinking = /enable_thinking:\s*true/.test(block);
    const openaiOnly = /deepseek/i.test(id);
    // Vision-capable: explicit vl/vision in id, OR qwen plus models (qwen3.x-plus accept images).
    const isVision = /vl|vision/i.test(id) || /^qwen3\.\d+-plus$/i.test(id);
    out.set(id, {
      id,
      name: prettyName(id),
      reasoning: thinking || /max|kimi|glm|minimax|deepseek/i.test(id),
      input: isVision ? ["text", "image"] : ["text"],
      contextWindow: ctx ? parseInt(ctx[1], 10) : 131072,
      maxTokens: openaiOnly ? 16384 : 65536,
      compat: thinking || /max|kimi|glm|minimax/i.test(id) ? { thinkingFormat: "qwen" } : undefined,
      openaiOnly,
    });
  }
  return Array.from(out.values());
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

async function fetchPlanModels(force = false): Promise<PlanModelDef[]> {
  // Use cache if fresh and not forced.
  if (!force) {
    const cache = readJSON<PlanCache | null>(PLAN_CACHE_PATH, null);
    if (cache && Date.now() - cache.fetchedAt < MODELS_CACHE_TTL_MS && cache.models?.length) {
      return cache.models;
    }
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(PLAN_MODELS_SOURCE, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const models = parseCodingPlan(text);
    if (!models.length) throw new Error("parser returned 0 models");
    // Targeted allow-list: real models that work on the plan endpoint but
    // aren't in the qwen-code template file. Keep this minimal — anything
    // here will appear in the picker even if upstream drops it.
    const have = new Set(models.map((m) => m.id));
    for (const f of PLAN_EXTRAS) if (!have.has(f.id)) models.push(f);
    const cache: PlanCache = { fetchedAt: Date.now(), source: PLAN_MODELS_SOURCE, models };
    writeJSON(PLAN_CACHE_PATH, cache);
    return models;
  } catch {
    // Fall through to whatever we have (stale cache or hardcoded).
    const cache = readJSON<PlanCache | null>(PLAN_CACHE_PATH, null);
    return cache?.models?.length ? cache.models : PLAN_MODEL_DEFS_FALLBACK;
  }
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

function buildPlanModels(defs: PlanModelDef[], openaiUrl: string, anthropicUrl: string): ProviderModelConfig[] {
  return defs.map((m) => {
    const useOpenAI = !!m.openaiOnly || /deepseek/i.test(m.id);
    return {
      id: m.id, name: m.name, reasoning: m.reasoning, input: m.input,
      contextWindow: m.contextWindow, maxTokens: m.maxTokens, compat: m.compat,
      thinkingLevelMap: m.reasoning ? { off: null } : undefined,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      baseUrl: useOpenAI ? openaiUrl : anthropicUrl,
      api: (useOpenAI ? "openai-completions" : "anthropic-messages") as "anthropic-messages" | "openai-completions",
    };
  });
}

// ── Cloud builders ────────────────────────────────────────────────────
interface CloudCache { fetchedAt: number; domain: string; models: ProviderModelConfig[]; }

async function fetchCloudModels(domain: string, apiKey: string, force = false): Promise<ProviderModelConfig[]> {
  // Cache hit: same domain, fresh, non-empty.
  if (!force) {
    const cache = readJSON<CloudCache | null>(CLOUD_CACHE_PATH, null);
    if (cache && cache.domain === domain && Date.now() - cache.fetchedAt < MODELS_CACHE_TTL_MS && cache.models?.length) {
      return cache.models;
    }
  }
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
    // Filter out non-LLMs (image, audio, video, embedding, etc.) — we only want chat models.
    const exclude = /(image|audio|video|tts|asr|embed|vector|rerank|wan|omni|livetranslate|realtime)/i;
    const models = json.data
      .filter((m) => !exclude.test(m.id))
      .map((m) => {
        const isVision = /vl|vision/i.test(m.id);
        const isReasoning = /qwq|max|thinking|deepseek|minimax|kimi|glm|3\.6|3\.5/i.test(m.id);
        return {
          id: m.id,
          name: m.name || m.id,
          reasoning: isReasoning,
          input: isVision ? (["text", "image"] as ("text" | "image")[]) : (["text"] as ("text" | "image")[]),
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 8192,
          compat: isReasoning ? { thinkingFormat: "qwen" as const } : undefined,
        };
      });
    const cache: CloudCache = { fetchedAt: Date.now(), domain, models };
    writeJSON(CLOUD_CACHE_PATH, cache);
    return models;
  } finally { clearTimeout(t); }
}

function buildCloudModels(models: ProviderModelConfig[], domain: string, fmt: string): ProviderModelConfig[] {
  return models.map((m) => {
    const useOpenAI = /deepseek/i.test(m.id) || fmt === "openai-completions";
    return {
      ...m,
      thinkingLevelMap: m.reasoning ? { off: null } : undefined,
      baseUrl: useOpenAI ? `https://${domain}/compatible-mode/v1` : `https://${domain}/apps/anthropic`,
      api: (useOpenAI ? "openai-completions" : "anthropic-messages") as "anthropic-messages" | "openai-completions",
    };
  });
}

// ── Migration ─────────────────────────────────────────────────────────
const isPlanKey = (k: string) => k.startsWith("sk-sp-") || k.startsWith("sk-tok-");

function extractKey(entry: any): string | undefined {
  if (!entry || typeof entry !== "object") return undefined;
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
export default async function (pi: ExtensionAPI) {
  migrateLegacyAuth();
  const config = loadConfig();
  const planDefs = await fetchPlanModels();

  let planKey: string | null = null;
  let cloudKey: string | null = null;
  try {
    const auth = readAuth();
    // Plan: oauth-shape (access). Cloud: api_key-shape (key).
    planKey = auth["alibaba-plan"]?.access || auth["alibaba-plan"]?.key || null;
    cloudKey = auth["alibaba-cloud"]?.key || auth["alibaba-cloud"]?.access || null;
  } catch {}

  // ── Plan provider (subscription-style; OAuth shape with paste-key) ──
  let planCreds: { access?: string; refresh?: string } | undefined;
  if (planKey) { try { planCreds = readAuth()["alibaba-plan"]; } catch {} }
  const planEndpoints = resolvePlanEndpoints(planCreds);

  pi.registerProvider("alibaba-plan", {
    name: "Alibaba Model Studio Plan",
    baseUrl: planEndpoints.anthropic,
    api: "anthropic-messages",
    authHeader: true,
    models: buildPlanModels(planDefs, planEndpoints.openai, planEndpoints.anthropic),
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

  // ── Cloud provider (per-token API key) ──────────────────────────────
  let cloudModels = [...CLOUD_FALLBACK];
  const cloudDomain = config.cloudDomain || DEFAULT_CLOUD_DOMAIN;
  const cloudFmt = config.cloudApiFormat || "anthropic-messages";
  if (cloudKey) {
    try { cloudModels = await fetchCloudModels(cloudDomain, cloudKey); } catch {}
  }

  // Registered as an API-key provider (no `oauth` block) so /login routes it
  // under "Use an API key" via pi's discriminator (interactive-mode.js:97-105
  // — !oauthProviderIds.has("alibaba-cloud") returns true).
  // pi's API-key login path saves {type:"api_key", key:<input>} directly; there
  // is no extension hook to validate the input or pre-fill a custom prompt.
  // A Plan token misrouted here is detected on the next launch via
  // migrateLegacyAuth() and moved to alibaba-plan.
  pi.registerProvider("alibaba-cloud", {
    name: "Alibaba Cloud (API Key)",
    baseUrl: `https://${cloudDomain}/apps/anthropic`,
    // Env var fallback (matches pi's built-in API-key providers). When unset
    // and no /login key, pi sends the literal string and the server returns
    // a 403 — same behavior as built-in providers like deepseek/groq/etc.
    apiKey: "DASHSCOPE_API_KEY",
    api: "anthropic-messages",
    authHeader: true,
    models: buildCloudModels(cloudModels, cloudDomain, cloudFmt),
  });

  // ── Command: /alibaba ──────────────────────────────────────────────
  pi.registerCommand("alibaba", {
    description: "Manage Alibaba (Plan + Cloud) configuration",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      const choice = await ctx.ui.select("Alibaba:", [
        "Status",
        "Refresh model lists",
        "Re-login Plan",
        "Re-login Cloud",
        "Plan — Change Endpoints",
        "Cloud — Change Domain",
        "Cloud — Change API Format",
        "Reset all",
      ]);
      if (!choice) return;

      const cfg = loadConfig();
      const auth = readAuth();
      const planCred = auth["alibaba-plan"];
      const cloudCred = auth["alibaba-cloud"];

      if (choice === "Status") {
        const ep = resolvePlanEndpoints(planCred);
        const planCache = readJSON<PlanCache | null>(PLAN_CACHE_PATH, null);
        const cloudCache = readJSON<CloudCache | null>(CLOUD_CACHE_PATH, null);
        const ageMin = (c: { fetchedAt: number } | null) => c ? Math.round((Date.now() - c.fetchedAt) / 60000) : null;
        const planAge = ageMin(planCache);
        const cloudAge = ageMin(cloudCache);
        const lines = [
          `Plan:  ${planCred ? "logged in" : "not logged in"}`,
          `       Anthropic: ${ep.anthropic}`,
          `       OpenAI:    ${ep.openai}`,
          `       Models:    ${planDefs.length} (cache ${planAge === null ? "absent" : `${planAge}m old, TTL 48h`})`,
          ``,
          `Cloud: ${cloudCred ? "logged in" : "not logged in"}`,
          `       Domain:    ${cfg.cloudDomain || DEFAULT_CLOUD_DOMAIN}`,
          `       Format:    ${cfg.cloudApiFormat || "anthropic-messages"}`,
          `       Models:    ${cloudModels.length} (cache ${cloudAge === null ? "absent" : `${cloudAge}m old, TTL 48h`})`,
        ].join("\n");
        ctx.ui.notify(lines, "info");
        return;
      }

      if (choice === "Refresh model lists") {
        try {
          const planFresh = await fetchPlanModels(true);
          let cloudCount = 0;
          if (cloudCred?.key || cloudCred?.access) {
            const domain = cfg.cloudDomain || DEFAULT_CLOUD_DOMAIN;
            const key = cloudCred.key || cloudCred.access;
            const fresh = await fetchCloudModels(domain, key, true);
            cloudCount = fresh.length;
          }
          ctx.ui.notify(`Plan: ${planFresh.length} models. Cloud: ${cloudCount > 0 ? `${cloudCount} models` : "skipped (not logged in)"}.`, "info");
          await ctx.reload();
        } catch (e: any) {
          ctx.ui.notify(`Failed: ${e?.message || e}`, "error");
        }
        return;
      }

      if (choice === "Re-login Plan") {
        if (!await ctx.ui.confirm("Wipe Plan credentials and re-login?", "Removes alibaba-plan from auth.json")) return;
        // Use authStorage.remove() rather than fs.write — it persists AND updates pi's
        // in-memory credential map, so /login's `• configured` label refreshes without restart.
        ctx.modelRegistry.authStorage.remove("alibaba-plan");
        ctx.ui.notify("Plan credentials wiped. Run /login → Alibaba Model Studio Coding Plan.", "info");
        await ctx.reload();
        return;
      }

      if (choice === "Re-login Cloud") {
        if (!await ctx.ui.confirm("Wipe Cloud credentials and re-login?", "Removes alibaba-cloud from auth.json")) return;
        ctx.modelRegistry.authStorage.remove("alibaba-cloud");
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
          const currentPlan = ctx.modelRegistry.authStorage.get("alibaba-plan");
          if (currentPlan?.type === "oauth") {
            ctx.modelRegistry.authStorage.set("alibaba-plan", {
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
          "International (dashscope-intl.aliyuncs.com)",
          "China (dashscope.aliyuncs.com)",
          "Custom…",
        ]);
        if (!sel) return;
        let domain = sel.match(/\(([^)]+)\)/)?.[1] || "";
        if (sel.startsWith("Custom")) domain = (await ctx.ui.input("Cloud domain:")) || "";
        if (domain) {
          cfg.cloudDomain = domain; saveConfig(cfg);
          ctx.ui.notify(`Cloud domain: ${domain}`, "info");
          await ctx.reload();
        }
        return;
      }

      if (choice === "Cloud — Change API Format") {
        const sel = await ctx.ui.select("Cloud API format:", ["Anthropic (recommended)", "OpenAI"]);
        if (!sel) return;
        cfg.cloudApiFormat = sel.startsWith("OpenAI") ? "openai-completions" : "anthropic-messages";
        saveConfig(cfg);
        ctx.ui.notify(`Cloud format: ${cfg.cloudApiFormat}`, "info");
        await ctx.reload();
        return;
      }

      if (choice === "Reset all") {
        if (!await ctx.ui.confirm(
          "Reset all Alibaba settings?",
          "Wipes config, both auth entries, plan-models cache, and any alibaba-* entries in settings.json (enabledModels + defaultProvider/defaultModel if alibaba). Run before `pi remove` for a clean uninstall.",
        )) return;
        for (const p of [CONFIG_PATH, PLAN_CACHE_PATH, CLOUD_CACHE_PATH]) { try { fs.unlinkSync(p); } catch {} }
        // Use authStorage.remove() so pi's in-memory credential cache stays in sync —
        // otherwise /login's "• configured" label persists until pi is restarted.
        for (const k of ["alibaba", "alibaba-plan", "alibaba-cloud", "alibaba-studio", "alibaba-token", "dashscope"]) {
          ctx.modelRegistry.authStorage.remove(k);
        }
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
}
