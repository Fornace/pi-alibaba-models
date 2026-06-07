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

const MODELS_CACHE_TTL_MS = 4 * 60 * 60 * 1000;

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

// ── Plan model fetch + parse + cache ──────────────────────────────────
interface PlanCache { fetchedAt: number; source: string; models: PlanModelDef[]; }

// Heuristic: turn a bare model id (from /v1/models API) into a full PlanModelDef.
function inferPlanDef(id: string): PlanModelDef {
  const openaiOnly = /deepseek/i.test(id);
  const isVision = /vl|vision/i.test(id) || /^qwen3\.\d+-plus$/i.test(id) || /kimi/i.test(id);
  const isReasoning = /max|kimi|glm|minimax|deepseek|3\.6|3\.5|3\.7/i.test(id);
  const ctxMatch = /flash/i.test(id) ? 131072 : /kimi/i.test(id) ? 262144 : /^qwen3\.6-plus$/i.test(id) ? 1048576 : 131072;
  return {
    id,
    name: prettyName(id),
    reasoning: isReasoning,
    input: isVision ? ["text", "image"] : ["text"],
    contextWindow: ctxMatch,
    maxTokens: openaiOnly ? 16384 : 65536,
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
    return json.data
      .filter((m) => !exclude.test(m.id))
      .map((m) => inferPlanDef(m.id));
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
  const ep = resolvePlanEndpoints(credentials);
  const cache: PlanCache = { fetchedAt: Date.now(), source: `${ep.openai}/models`, models: apiModels };
  writeJSON(PLAN_CACHE_PATH, cache);
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

async function fetchCloudModels(domain: string, apiKey: string, _force = false): Promise<ProviderModelConfig[]> {
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
        const contextWindow = /^qwen3\.6-plus$/i.test(m.id) ? 1048576 : 128000;
        return {
          id: m.id,
          name: m.name || m.id,
          reasoning: isReasoning,
          input: isVision ? (["text", "image"] as ("text" | "image")[]) : (["text"] as ("text" | "image")[]),
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow,
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

// ── Offline-resilient catalog loaders ────────────────────────────────
// Live API is the source of truth. But a network failure must never take
// the whole extension (and therefore pi, and the user's local models) down
// with it. So: try live, fall back to the last-known-good on-disk cache,
// warn, and never throw. Cache is an offline fallback only — when the API
// is reachable, its response always wins and overwrites the cache.
const cacheAgeMin = (fetchedAt: number) => Math.round((Date.now() - fetchedAt) / 60000);

async function loadPlanDefs(force: boolean, credentials?: { access?: string; refresh?: string }): Promise<PlanModelDef[]> {
  if (!credentials?.access) return [];
  try {
    return await fetchPlanModels(force, credentials);
  } catch (e: any) {
    const cache = readJSON<PlanCache | null>(PLAN_CACHE_PATH, null);
    if (cache?.models?.length) {
      console.warn(`[alibaba] Plan catalog fetch failed (${e?.message || e}); using cached models (${cache.models.length}, ${cacheAgeMin(cache.fetchedAt)}m old).`);
      return cache.models;
    }
    console.warn(`[alibaba] Plan catalog fetch failed (${e?.message || e}); no cache — Plan models unavailable until reconnected. Other providers still work.`);
    return [];
  }
}

async function loadCloudDefs(domain: string, apiKey: string, force: boolean): Promise<ProviderModelConfig[]> {
  try {
    return await fetchCloudModels(domain, apiKey, force);
  } catch (e: any) {
    const cache = readJSON<CloudCache | null>(CLOUD_CACHE_PATH, null);
    if (cache?.models?.length && cache.domain === domain) {
      console.warn(`[alibaba] Cloud catalog fetch failed (${e?.message || e}); using cached models (${cache.models.length}, ${cacheAgeMin(cache.fetchedAt)}m old).`);
      return cache.models;
    }
    console.warn(`[alibaba] Cloud catalog fetch failed (${e?.message || e}); no cache — Cloud models unavailable until reconnected. Other providers still work.`);
    return [];
  }
}

// ── Module-level mutable model lists ─────────────────────────────────
// Populated by the async extension factory before provider registration.
let planDefs: PlanModelDef[] = [];
let cloudDefs: ProviderModelConfig[] = [];

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
// Async factory: pi awaits this before provider registrations are flushed.
// Fetch live model catalogs before registerProvider() so enabledModels
// validation sees the real catalog immediately. No fallbacks.
export default async function (pi: ExtensionAPI) {
  migrateLegacyAuth();
  const config = loadConfig();

  let planKey: string | null = null;
  let cloudKey: string | null = null;
  try {
    const auth = readAuth();
    planKey = auth["alibaba-plan"]?.access || auth["alibaba-plan"]?.key || null;
    cloudKey = auth["alibaba-cloud"]?.key || auth["alibaba-cloud"]?.access || null;
  } catch {}

  // ── Live catalog fetch (before provider registration) ───────────────
  let planCreds: { access?: string; refresh?: string } | undefined;
  if (planKey) { try { planCreds = readAuth()["alibaba-plan"]; } catch {} }
  const planEndpoints = resolvePlanEndpoints(planCreds);
  const cloudDomain = config.cloudDomain || DEFAULT_CLOUD_DOMAIN;
  const cloudFmt = config.cloudApiFormat || "anthropic-messages";

  if (planCreds?.access) planDefs = await loadPlanDefs(true, planCreds);
  if (cloudKey) cloudDefs = await loadCloudDefs(cloudDomain, cloudKey, true);

  // ── Plan provider ───────────────────────────────────────────────────
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

  // ── Cloud provider ─────────────────────────────────────────────────
  pi.registerProvider("alibaba-cloud", {
    name: "Alibaba Cloud (API Key)",
    baseUrl: `https://${cloudDomain}/apps/anthropic`,
    apiKey: "$DASHSCOPE_API_KEY",
    api: "anthropic-messages",
    authHeader: true,
    models: buildCloudModels(cloudDefs, cloudDomain, cloudFmt),
  });

  // ── Lazy refresh: fetch live catalogs and re-register ───────────────
  pi.on("session_start", async () => {
   try {
    const planCred = readAuth()["alibaba-plan"];
    planDefs = await loadPlanDefs(false, planCred);

    const auth = readAuth();
    const key = auth["alibaba-cloud"]?.key || auth["alibaba-cloud"]?.access;
    if (key) {
      const cfg = loadConfig();
      const domain = cfg.cloudDomain || DEFAULT_CLOUD_DOMAIN;
      cloudDefs = await loadCloudDefs(domain, key, false);
    }

    // Re-register both providers with the expanded model lists
    const currentConfig = loadConfig();
    const currentPlanCreds = readAuth()["alibaba-plan"];
    const ep = resolvePlanEndpoints(currentPlanCreds);
    const currentDomain = currentConfig.cloudDomain || DEFAULT_CLOUD_DOMAIN;
    const currentFmt = currentConfig.cloudApiFormat || "anthropic-messages";

    pi.registerProvider("alibaba-plan", {
      name: "Alibaba Model Studio Plan",
      baseUrl: ep.anthropic,
      api: "anthropic-messages",
      authHeader: true,
      models: buildPlanModels(planDefs, ep.openai, ep.anthropic),
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
          const ep2 = resolvePlanEndpoints(credentials);
          const updated = buildPlanModels(planDefs, ep2.openai, ep2.anthropic);
          return models.map((m) => {
            if (m.provider !== "alibaba-plan") return m;
            const found = updated.find((u) => u.id === m.id);
            if (!found || !found.api) return m;
            return { ...m, baseUrl: found.baseUrl ?? m.baseUrl, api: found.api };
          });
        },
      },
    });

    pi.registerProvider("alibaba-cloud", {
      name: "Alibaba Cloud (API Key)",
      baseUrl: `https://${currentDomain}/apps/anthropic`,
      apiKey: "$DASHSCOPE_API_KEY",
      api: "anthropic-messages",
      authHeader: true,
      models: buildCloudModels(cloudDefs, currentDomain, currentFmt),
    });
   } catch (e: any) {
    console.warn(`[alibaba] session_start catalog refresh failed (${e?.message || e}); keeping previously loaded models.`);
   }
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
        const isPlanLive = planCache && planAge !== null && planCache.models.length === planDefs.length;
        const isCloudLive = cloudCache && cloudAge !== null && cloudCache.models.length === cloudDefs.length;
        const planState = isPlanLive ? `live, ${planAge}m old` : (planDefs.length ? "live, not cached" : "not fetched");
        const cloudState = isCloudLive ? `live, ${cloudAge}m old` : (cloudDefs.length ? "live, not cached" : "not fetched");
        const lines = [
          `Plan:  ${planCred ? "logged in" : "not logged in"}`,
          `       Anthropic: ${ep.anthropic}`,
          `       OpenAI:    ${ep.openai}`,
          `       Models:    ${planDefs.length} (${planState})`,
          ``,
          `Cloud: ${cloudCred ? "logged in" : "not logged in"}`,
          `       Domain:    ${cfg.cloudDomain || DEFAULT_CLOUD_DOMAIN}`,
          `       Format:    ${cfg.cloudApiFormat || "anthropic-messages"}`,
          `       Models:    ${cloudDefs.length} (${cloudState})`,
        ].join("\n");
        ctx.ui.notify(lines, "info");
        return;
      }

      if (choice === "Refresh model lists") {
        try {
          const planCred = readAuth()["alibaba-plan"];
          planDefs = await fetchPlanModels(true, planCred);
          let cloudCount = 0;
          if (cloudCred?.key || cloudCred?.access) {
            const domain = cfg.cloudDomain || DEFAULT_CLOUD_DOMAIN;
            const key = cloudCred.key || cloudCred.access;
            cloudDefs = await fetchCloudModels(domain, key, true);
            cloudCount = cloudDefs.length;
          }
          ctx.ui.notify(`Plan: ${planDefs.length} models. Cloud: ${cloudCount > 0 ? `${cloudCount} models` : "skipped (not logged in)"}.`, "info");
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
