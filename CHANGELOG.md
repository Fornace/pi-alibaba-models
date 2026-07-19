# Changelog

## 1.0.15

- **oh-my-pi support.** The agent directory is no longer hardcoded to `~/.pi/agent` — it is resolved from `PI_CODING_AGENT_DIR`, then `PI_CONFIG_DIR`, then host detection, falling back to `~/.pi/agent` under classic pi. Host detection uses the process identity (`execPath`/`argv0`/`title` = `omp`), because oh-my-pi does not export a marker into its own process env (`OMPCODE` only leaks into shells omp spawns; `PI_CODING_AGENT_DIR` is unset). Named profiles (`OMP_PROFILE` / `PI_PROFILE`) resolve to `<config root>/profiles/<name>/agent`. This moves `alibaba-config.json`, `auth.json` access, and both model caches to the right place under oh-my-pi.
- **Fix: credentials invisible under oh-my-pi** (`/alibaba → Status` always showed "not logged in"). The extension read credentials straight from `auth.json`, but oh-my-pi stores them in `agent.db` behind its `AuthStorage` API. All credential reads/writes now go through a feature-detected host shim: the runtime registry (`ctx.modelRegistry.authStorage`, probing pi's `get/set/remove` and oh-my-pi's `getOAuthCredential`/`getApiKey` shapes) first, with the `auth.json` file as fallback for pi's pre-session factory path. Side effect: the pre-existing type errors against current `@earendil-works/pi-coding-agent` typings (`authStorage` no longer on `ModelRegistry`) are gone — `tsc` is clean again.
- **Fix: model picker stuck on the login seed under oh-my-pi.** omp does not replace a provider on duplicate `registerProvider` (and has no `unregisterProvider`), so the `session_start` re-registration never reached the model picker. The factory now seeds the catalog from the last-known-good on-disk cache when no credential is readable, so the *first* registration already carries the real model list; `session_start` still live-refreshes (and unregisters first where the host supports it). `/alibaba → Refresh model lists` covers mid-session changes via reload.
- **Fix: Plan provider unreachable under oh-my-pi.** Because credentials only become visible at `session_start` (agent.db, not auth.json), the factory-time Plan catalog is empty on a cold start — and a zero-model provider is hidden from `/login`, so Plan could never be logged into under oh-my-pi. The Plan provider now registers a single login seed (`qwen3.7-plus`) whenever its catalog is empty, mirroring the Cloud login seed from 1.0.12 (#1); the live catalog replaces it the moment a token is present. Verified end-to-end under oh-my-pi 17: `/login` → Plan token → `/alibaba → Status` shows `logged in` with the full live catalog.

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
