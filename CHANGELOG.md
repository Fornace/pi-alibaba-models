# Changelog

## 1.2.1

- **`alibaba_tools` is search-first.** Guidelines and schema tell the model to use `search` for live facts; `research` only if that was too thin.
- **Streaming sidecar:** DashScope Responses/Completions are requested with `stream: true`. Progress (elapsed time, search/extract calls, partial text) is pushed through pi's `onUpdate` so the TUI is not a silent hang. Failures **throw** so the transcript marks `isError`.
- **Timeouts:** `research` 8 min, others 3 min (was 3 min / 90 s). Override with `ALIBABA_SIDECAR_TIMEOUT_MS`. Timeout text suggests `search` instead of `research`.
- Auto sidecar model prefers Flash/Plus over Max when the catalog has both. Independent `code`/`image` calls may run in parallel.

## 1.2.0

- **`alibaba_tools` sidecar** (opt-in): `/alibaba → Cloud — DashScope built-in tools` registers one Pi tool that POSTs its own Cloud Completions/Responses request. Actions: `research` (web_search + web_extractor + code_interpreter), `search`, `code`, `image`. Qwen-only allowlist; DeepSeek/Kimi/GLM/MiniMax are rejected. Built-in tool events stay inside the plugin — they are not mixed into pi's agent stream or the current chat format (Anthropic default included).
- Tests for allowlists, model picking, request bodies, and Responses/Completions result parsing.

## 1.1.0

- **OpenAI Responses API** for Cloud: `/alibaba → Cloud — Change API Format → OpenAI Responses` sets `api: "openai-responses"` on `https://{domain}/compatible-mode/v1` (pi talks to `/responses`). Thinking maps onto Bailian's `reasoning.effort` (`off→none`, plus minimal/low/medium/high/xhigh/max). DeepSeek still falls back to Chat Completions when the Cloud format is Anthropic.
- **Native Cloud catalog** via `GET /api/v1/models` (real context windows, max output, Reasoning/VU tags, CNY pricing), with the compatible-mode `/models` list as fallback. Anthropic `maxTokens` is still clamped to the verified **32768** ceiling so thinking does not squeeze the answer budget; OpenAI Completions/Responses keep the catalog ceiling.
- **More Cloud regions**: US-Virginia, Hong Kong, and workspace domains `{WorkspaceId}.{region}.maas.aliyuncs.com` (Beijing / Singapore / Tokyo / Frankfurt / US).
- **Rate limits (Cloud)** (`GET /api/v1/models/limits`) and an **authorized-only catalog filter** (`GET /api/v1/models/permissions`) — both best-effort, currently documented on the Beijing workspace domain.
- **OpenAI-compat flags:** `supportsStore: false` next to `supportsDeveloperRole: false`. Qwen 3.8 is vision-capable. Completions effort maps: Qwen 3.8 `low/medium/xhigh`, GLM-5.x / DeepSeek V4 `high/max`. Re-login / Reset / endpoint changes still prefer `authStorage` when pi exposes it, and write `auth.json` directly otherwise.
- **Startup no longer blocks on a live catalog fetch.** A cache younger than 4 hours is served immediately; `session_start` and `/alibaba → Refresh model lists` still refresh when the cache is stale or when you ask. Fetch failures still fall back to the stale cache.
- **Thinking levels:** reasoning models expose `high` and `max` in the picker on the Anthropic path. Unused intermediate levels are marked unsupported instead of being aliased onto `"high"`.
- **Kimi is not flagged as reasoning.** DashScope Anthropic-compat rejects `thinking_budget` for `kimi-k3` / `kimi-k2.7-code` (Fornace#9); `--thinking off` still sent the field. Cached catalogs rehydrate `reasoning` so a stale kimi entry does not keep sending it.
- Tests: deterministic `node:test` coverage for cache TTL, thinking-level maps, Responses routing, Anthropic maxTokens clamp, native catalog helpers, and reasoning/vision heuristics (no network, no provider).

## 1.0.15

- **Fix: large tool calls no longer truncated on reasoning models.** Every Cloud model used to report a flat `maxTokens: 8192` (Plan non-DeepSeek models: 65536). On pi's Anthropic path, `max_tokens` is a total budget shared between thinking and the final answer, so with pi's high thinking budget (16384) the answer budget collapsed to 8192 − 7168 = **1024 tokens** — enough to cut big `write`/`edit` calls mid-arguments (the model never emitted the `path` field; the content string ended abruptly). Reasoning models now report `maxTokens: 32768` → answer budget 32768 − 16384 = **16384** at high thinking, on both providers (Plan non-DeepSeek included; DeepSeek keeps its 16384 OpenAI-path value). 32768 was verified empirically as the universal `max_tokens` ceiling on the Anthropic-compat endpoint (non-reasoning `qwen-plus` rejects 65536 with `Range of max_tokens should be [1, 32768]`; `qwen3.8-max`, `deepseek-v4-flash`, `glm-5.2` and `kimi-k2.7-code` all accept 32768), so it can never be rejected as out of range. Non-reasoning models keep 8192 (pi sends it straight as the output cap — no thinking squeeze).
- Cached catalogs (offline fallback) now also recompute `maxTokens`, so stale caches pick up the fix.

## 1.0.14

- Release bump. First npm publish since 1.0.10; bundles the 1.0.11–1.0.13 work: Qwen 3.7 Plus/Max metadata (1M context, 3.7 Plus multimodal), shared Plan/Cloud capability heuristics, the `/alibaba → Context Window — Override` setting, the `/login` Cloud-visibility fix (#1), and Cloud catalog loading from `$DASHSCOPE_API_KEY`.

## 1.0.13

- **Cloud catalog now loads from `DASHSCOPE_API_KEY` too.** Previously the live catalog was only fetched when a key was saved via `/login`; users who authenticate the Cloud provider purely through the `DASHSCOPE_API_KEY` env var were stuck on the login-seed model. The catalog fetch now uses the saved key **or** the env var, so env-var users get their full, correctly-described model list. As a result the hardcoded login seed (added in 1.0.12 for #1) is now used **only** when there is no credential anywhere — a state in which no model is usable regardless, so it's purely a "sign in" entry, not a model guess.
- `/alibaba → Status` now reports Cloud auth via `$DASHSCOPE_API_KEY` when that's how you're authenticated.
- Docs: document env-var auth for the Cloud provider.

## 1.0.12

- **Fix: Cloud provider missing from `/login`** (#1). pi hides any provider that has zero registered models, so after the hardcoded fallbacks were removed the **Alibaba Cloud (API Key)** entry disappeared from `/login → Use an API key` until you were already logged in. The provider now registers a single real login seed (`qwen-plus`) whenever the live catalog is empty, so it's always visible to log into. This is one login seed, not a model-catalog fallback — the live catalog replaces it the moment you log in.
- **New setting: context-window override.** `/alibaba → Context Window — Override` lets you correct the context size shown on a model's card — per model id, or `*` for a global default. Stored in `alibaba-config.json` under `contextWindowOverrides`. Handy when a brand-new model is inferred with the wrong size (the `/v1/models` API doesn't report context windows).
- Docs: corrected a stale "48 hours" cache note (it's 4 h).

## 1.0.11

- **Qwen 3.7 support**: `qwen3.7-plus` and `qwen3.7-max` now report their correct **1M (1,048,576) token** context windows, and Qwen 3.7 Plus is correctly flagged as multimodal (text + image input). Both surface automatically from the live catalog — this just fixes their inferred metadata.
- Corrected `qwen3.6-max` to its actual **256K** context window (it does not share the 1M window of Qwen 3.6/3.7 Plus).
- Capability inference (context window, reasoning, vision) is now shared between the Plan and Cloud code paths via common helpers, so they can no longer drift apart. Fixes a case where Qwen 3.x Plus was treated as text-only and non-reasoning on the Cloud provider.
- Context-window matching now also covers dated model variants (e.g. `qwen3.7-plus-2026-06-01`).
- Docs: refreshed the model lineup and corrected stale cache notes (4 h TTL, cache-based offline fallback — no hardcoded list).
- Thanks to [@pkking](https://github.com/pkking) for reporting the context-window issue (#3).

## 1.0.10

- Fix `qwen3.6-plus` context window: now reports **1M (1,048,576)** tokens instead of the hardcoded 128K, on both the Plan and Cloud endpoints (#3, #4). Thanks [@pkking](https://github.com/pkking).
- Use the `$`-prefixed `$DASHSCOPE_API_KEY` env var reference to silence the legacy environment-variable deprecation warning.

## 1.0.9

- Offline resilience: a failed catalog fetch (no connection, DNS, timeout) no longer crashes the extension — and therefore no longer prevents `pi` from starting or blocks your local/other-provider models. The startup and `session_start` catalog loads now fall back to the last-known-good on-disk cache and emit a warning instead of throwing. Live API remains the source of truth whenever it's reachable; the cache is an offline fallback only. If there's no cache either, the affected provider registers with an empty model list (a warning, not a fatal error).

## 1.0.8

- Fix startup model resolution by making the extension factory async and fetching live Plan/Cloud catalogs before provider registration. Pi now validates `enabledModels` against the real API model lists immediately, eliminating startup "No models match pattern" warnings without hardcoded or cache fallbacks.

## 1.0.7

- Bump (1.0.6 already published).

## 1.0.6

- Removed all hardcoded model fallbacks (`PLAN_MODEL_DEFS_FALLBACK`, `CLOUD_FALLBACK`). If the API is unreachable and no stale cache exists, the extension now errors immediately instead of silently degrading to a stale model list. This eliminates transient "no models match" warnings caused by the hardcoded list being out of sync with the live catalog.

## 1.0.5

- Plan model list now fetched dynamically from the Plan endpoint's own `/compatible-mode/v1/models` API (primary source), replacing the fragile GitHub TypeScript template parser. New models appear automatically as Alibaba ships them — no extension update needed. The GitHub template parser remains as a secondary fallback.

## 1.0.4

- Version bump (no code changes)

## 1.0.3

- Sync factory pattern: hardcoded models registered instantly for picker availability, with lazy `session_start` fetch that re-registers both providers with live catalog data

## 1.0.2

- Fix README install instructions: replaced hardcoded local path (`/Users/francesco/alibaba-pi-package`) with `pi install pi-alibaba-models` everywhere (Install, Uninstall, Troubleshooting). npm and git fallbacks documented.

## 1.0.1

- Pre-release polish: fix LICENSE author, fix import scope, expand README, sync model lineup (Qwen 3.6 Max, DeepSeek V4 Pro), gitignore `package-lock.json`
- Use Supabase CDN for directory banner

## 1.0.0

- Initial release
- Two providers: `alibaba-plan` (Model Studio Coding Plan) and `alibaba-cloud` (DashScope API Key)
- `/alibaba` slash command for runtime configuration
- Dynamic plan model list fetched from upstream Qwen Code template
- Cloud model list fetched live from DashScope `/v1/models`
- Vision support via `input: ["text", "image"]` for VL/Qwen-plus models
- Qwen thinking support with `thinkingFormat: "qwen"` and `thinkingLevelMap`
- DeepSeek models forced to OpenAI-compat endpoint (Anthropic-compat hangs)
- Auth migration from legacy single-key format to split Plan/Cloud
