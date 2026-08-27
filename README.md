# pi-alibaba-models

The complete [`pi`](https://github.com/badlogic/pi-mono) extension for Alibaba's model lineup — **Qwen 3.8 Max**, **Qwen 3.7 Max / Plus**, **Qwen 3.6 Max / Plus**, **DeepSeek V4 Pro**, **Kimi K2.6**, **GLM-5**, **MiniMax M2.5**, and the rest of the catalog. Native thinking-level support, Anthropic Messages plus OpenAI Chat Completions **and Responses**, International / China / US / workspace endpoints, both Coding Plan subscriptions and pay-per-token Cloud keys.

## Features

- **Dual Provider Support**: Both the subscription-based Model Studio Coding Plan **and** the pay-per-token Alibaba Cloud (DashScope) — registered side by side, switch per chat from the model picker.
- **Three API Shapes**: Anthropic-compatible (`/v1/messages`) by default; OpenAI Chat Completions (`/compatible-mode/v1`) auto-selected for DeepSeek and selectable per-Cloud via `/alibaba`; OpenAI **Responses** (`/compatible-mode/v1/responses`) as a third Cloud format.
- **Five+ Regions**: International (`dashscope-intl.aliyuncs.com`), China, US-Virginia, Hong Kong, plus Alibaba's recommended **workspace domains** `{WorkspaceId}.{region}.maas.aliyuncs.com` for Beijing / Singapore / Tokyo / Frankfurt / US — switch with `/alibaba`, no re-login needed.
- **Native Reasoning**: First-class thinking-level support for every reasoning-capable model, including `reasoning.effort` on Responses and Completions effort maps for Qwen 3.8 / GLM-5.x / DeepSeek V4.
- **Vision Capable**: Image input automatically enabled for VL models, Qwen 3.8, Qwen 3.x Plus variants, and Kimi.
- **Live Catalog**: Cloud prefers Alibaba's native `GET /api/v1/models` (real context windows, max output, capability tags, pricing) and falls back to compatible-mode `/models`. Plan still uses the live `/compatible-mode/v1/models` list. New models appear as Alibaba ships them — no extension update needed.

## How to Use (Quickstart)

1. **Install** the extension (see below).
2. **Restart** `pi` to load the extension.
3. Type `/login` in your pi chat input.
4. Select your provider based on your account type:
   - Choose **Plans > Alibaba Model Studio Coding Plan** if you have a subscription (your token likely starts with `sk-sp-` or `sk-tok-`).
   - Choose **Use an API key > Alibaba Cloud (API Key)** if you use the pay-as-you-go DashScope service (your token likely starts with `sk-`).
5. Paste your token when prompted.
6. Open the model picker, select a model (e.g., `Qwen 3.8 Max`, `Qwen 3.7 Plus`, or `DeepSeek V4 Pro`), and start chatting!

## Install

```bash
# recommended
pi install pi-alibaba-models

# explicit npm form (fallback if the bare name doesn't resolve)
pi install npm:pi-alibaba-models

# or from GitHub
pi install git:github.com/Fornace/pi-alibaba-models

# or from a local checkout (development)
git clone https://github.com/Fornace/pi-alibaba-models
cd pi-alibaba-models && pi install .
```

After install, restart `pi`. The extension registers two providers and a slash command on every boot.

## Uninstall

`pi remove` only removes the package entry from `settings.json["packages"]` — it does not clean extension-private state (auth entries, config, model cache, enabled-model lists). For a clean uninstall:

```text
1. /alibaba  →  "Reset all"      (wipes config, both auth entries, plan-models cache, alibaba-* enabledModels)
2. pi remove pi-alibaba-models
```

If you've already run `pi remove` and want to clean leftovers manually:

```bash
rm -f ~/.pi/agent/alibaba-config.json ~/.pi/agent/alibaba-plan-models.cache.json
# then edit ~/.pi/agent/auth.json and remove the "alibaba-plan" / "alibaba-cloud" entries
# then edit ~/.pi/agent/settings.json and drop any "alibaba-*/..." or "dashscope/..." entries from enabledModels
```

## Two providers

| Provider id    | Section in `/login`     | Auth shape | Use it for                                 |
|----------------|-------------------------|------------|--------------------------------------------|
| `alibaba-plan` | Plans                   | OAuth (paste token) | Model Studio Coding Plan subscription |
| `alibaba-cloud`| API Keys (via OAuth UI) | OAuth (paste API key) | Pay-per-token DashScope API           |

Both are registered as `oauth`-shaped providers so they appear in `/login` and live in `~/.pi/agent/auth.json` under their respective keys. The Plan provider stores the chosen endpoints in the `refresh` field as JSON; the Cloud provider stores its domain in `~/.pi/agent/alibaba-config.json`.

> **Cloud without `/login`:** the Cloud provider also reads the `DASHSCOPE_API_KEY` environment variable. If it's set, the extension fetches your live model catalog from it on startup — no `/login` needed. With **no** credential at all (no `/login`, no env var) the Cloud provider still shows up in `/login → Use an API key` via a single placeholder model, so you can sign in; your real catalog replaces it the moment a key is present.

### Endpoints

**Plan (default Singapore / Global):**
- Anthropic-compat: `https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic` (pi appends `/v1/messages`)
- OpenAI-compat:    `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`

**Cloud (default International):**
- Anthropic-compat: `https://dashscope-intl.aliyuncs.com/apps/anthropic`
- OpenAI-compat:    `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` (Chat Completions **and** Responses)

> **OpenAI Responses API** (`/compatible-mode/v1/responses`): Alibaba's newest OpenAI-compatible surface, with `reasoning.effort` thinking levels. Select it per-Cloud via `/alibaba → Cloud — Change API Format → OpenAI Responses`. Built-in DashScope tools (web search, code interpreter, web extractor) are not auto-injected — pi still sends its own agent tools. DeepSeek stays on Chat Completions when the Cloud format is Anthropic (that path hangs); on Responses it follows the selected format (Beijing/Singapore per Alibaba's docs).

## Key prefix reference

| Prefix      | Provider       | Where to obtain                                                   |
|-------------|----------------|-------------------------------------------------------------------|
| `sk-sp-`    | `alibaba-plan` | Model Studio Coding Plan console — Singapore / Global             |
| `sk-tok-`   | `alibaba-plan` | Model Studio Coding Plan console — alternate token format         |
| `sk-`(other)| `alibaba-cloud`| DashScope API Keys console (per-token billing)                    |

Consoles:
- International / Singapore Coding Plan: <https://modelstudio-intl.console.alibabacloud.com/>
- China Coding Plan:                     <https://bailian.console.aliyun.com/>
- DashScope (per-token):                 <https://dashscope.console.aliyun.com/> or <https://dashscope-intl.console.aliyun.com/>

The login flow validates the prefix and offers to redirect you to the correct provider if you paste the wrong type.

## Region table

| Region                | Plan host                                      | Cloud host                                     |
|-----------------------|------------------------------------------------|------------------------------------------------|
| International         | `token-plan.ap-southeast-1.maas.aliyuncs.com`  | `dashscope-intl.aliyuncs.com`                  |
| China                 | (region-specific host, paste via "Custom")     | `dashscope.aliyuncs.com`                       |
| US (Virginia)         | —                                              | `dashscope-us.aliyuncs.com`                    |
| Hong Kong             | —                                              | `cn-hongkong.dashscope.aliyuncs.com`           |
| Beijing (workspace)   | `{WorkspaceId}.cn-beijing.maas.aliyuncs.com`   | `{WorkspaceId}.cn-beijing.maas.aliyuncs.com`   |
| Singapore (workspace) | `{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com` | `{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com` |
| Japan (Tokyo)         | —                                              | `{WorkspaceId}.ap-northeast-1.maas.aliyuncs.com` |
| Germany (Frankfurt)   | —                                              | `{WorkspaceId}.eu-central-1.maas.aliyuncs.com` |
| US (workspace)        | —                                              | `{WorkspaceId}.us-east-1.maas.aliyuncs.com`    |
| Custom                | paste both base URLs at login                  | paste domain at login                          |

> Workspace domains are the ones Alibaba recommends (and they're required for Japan/Frankfurt). `/alibaba → Cloud — Change Domain` asks for your business-space ID and builds the host.

### Rate limits

`/alibaba → Rate limits (Cloud)` queries `GET /api/v1/models/limits` with your API key and prints each model's quota. Read-only and best-effort — the endpoint is currently only documented on the **Beijing workspace domain**.

### Authorized-models filter

`GET /api/v1/models/permissions` returns the models your business space is authorized to call. When the endpoint is reachable (Beijing workspace domain), the extension intersects it with the live catalog and hides models you don't have inference permission for. On by default; disable via `/alibaba → Cloud — Authorized-only Filter`. If the fetch fails or the intersection would be empty, the full catalog is shown.

## Studio plan models — dynamic source

The plan model list is fetched from the canonical Qwen Code template:

<https://github.com/QwenLM/qwen-code/blob/main/packages/cli/src/constants/codingPlan.ts>

Cached at `~/.pi/agent/alibaba-plan-models.cache.json` for **4 hours**. A fresh cache is the startup fast path (no network on launch). A stale or missing cache, or `/alibaba → Refresh model lists`, fetches live and rewrites the file. On a failed fetch the extension falls back to the last-known-good cache (and, if there's no cache either, registers an empty list rather than crashing).

The Cloud provider prefers Alibaba's native `GET /api/v1/models` (paginated, text-generation models) and falls back to compatible-mode `/v1/models` on domains that don't expose it. Qwen 3.8 Max, Qwen 3.7 Max/Plus, DeepSeek V4, Kimi, GLM-5, MiniMax etc. all surface automatically as Alibaba ships them.

## Limitations & Known Issues

- **DeepSeek Compatibility**: The Anthropic-compatible path on the Alibaba Plan host often hangs or times out for DeepSeek models. To resolve this seamlessly, this extension automatically forces any model ID containing `deepseek` to use the **OpenAI-completions endpoint** instead.
- **Model Availability (404s)**: When `GET /api/v1/models/permissions` is reachable, the picker shows the catalog your account is authorized to call. Toggle with `/alibaba → Cloud — Authorized-only Filter`. On other domains the advertised catalog is shown and a model you can't access still errors only when you send a message.
- **API Wrapper Quirks**: Alibaba's native Anthropic compatibility layer can occasionally be strict or quirky with complex parallel tool calls. If you experience systemic parsing errors on DashScope, switch Cloud API format to "OpenAI Chat Completions" or "OpenAI Responses".
- **Responses API**: not every model supports every built-in DashScope tool, and `xhigh`/`max` effort are documented for Beijing/Singapore. If a model errors out, switch back to Chat Completions or Anthropic for that session.
- **Output budget vs. thinking budget**: On the Anthropic path, `max_tokens` is a **total** budget shared between thinking and the final answer. pi splits the card's `maxTokens` accordingly, so a card value of 8192 leaves only 8192 − 7168 = **1024 tokens** for the actual answer at high thinking — enough to truncate large tool calls (e.g. big `write`/`edit` content) mid-arguments. Reasoning models therefore report `maxTokens: 32768` (the verified universal ceiling — non-reasoning `qwen-plus` rejects 65536 with `Range of max_tokens should be [1, 32768]`), which yields a 16384-token answer budget at high thinking. Non-reasoning models keep 8192: pi sends it straight as the output cap, so there is no squeeze to fix. Completions and Responses keep the catalog's larger output ceilings.
- **Dynamic Caching**: Model lists are cached for 4 hours. If a new model drops and you don't see it, run `/alibaba` -> `Refresh model lists`.
- **Inferred Context Windows**: Compatible-mode `/v1/models` returns only ids and names, so context windows are inferred from the model id unless native `/api/v1/models` supplied a real value. If a brand-new model shows the wrong size, fix it yourself with `/alibaba → Context Window — Override` (per model, or `*` for all) — no extension update needed.

## `/alibaba` command reference

| Choice                       | What it does                                                              |
|------------------------------|---------------------------------------------------------------------------|
| Status                       | Print Plan/Cloud login state, active endpoints, model count, cache age   |
| Refresh model lists          | Force-refetch Plan + Cloud catalogs and reload the extension             |
| Re-login Plan                | Wipe `alibaba-plan` from `auth.json` and reload (then run `/login`)      |
| Re-login Cloud               | Wipe `alibaba-cloud` from `auth.json` and reload (then run `/login`)     |
| Plan — Change Endpoints      | Override OpenAI / Anthropic base URLs                                    |
| Cloud — Change Domain        | International / China / US / HK / workspace domains / Custom             |
| Cloud — Change API Format    | Anthropic Messages / OpenAI Chat Completions / OpenAI Responses          |
| Rate limits (Cloud)          | Show per-model rate/usage quotas (`/api/v1/models/limits`)               |
| Cloud — Authorized-only Filter | Toggle hiding catalog models the account isn't authorized to call      |
| Context Window — Override    | Set the context-window shown on a model's card (per model, or `*` for all) |
| Reset all                    | Wipe all Alibaba state (config, both auth entries, plan-models cache)    |

## Troubleshooting

- **Model picker shows "No matching models"** → run `/login`, pick the right Alibaba entry, paste your key. Models register only after a successful login (Cloud fetches its real model list at boot from the live key).
- **`sk-sp-` accidentally pasted into the Cloud slot** → run `/alibaba → Re-login Cloud`, then `/login → Alibaba Model Studio Coding Plan` and paste it there. (The login validators will also catch this and offer to redirect you.)
- **DeepSeek hangs / times out** → make sure you're on the latest version of this extension; it forces DeepSeek to OpenAI-compat. If you customised plan endpoints, verify the OpenAI URL ends in `/compatible-mode/v1`.
- **Plan picker shows models that 404 at request time** → your subscription tier may not include every advertised model. The picker shows whatever upstream advertises; the API tells you "model_not_found" only when you actually call it.
- **`/alibaba` command doesn't appear** → `pi list` should show `pi-alibaba-models` (or whatever source you installed from) under "User packages". If absent, run `pi install pi-alibaba-models` again and restart `pi`.

## Files

| Path                                                  | Purpose                            |
|-------------------------------------------------------|------------------------------------|
| `~/.pi/agent/auth.json`                               | Both provider credentials (0600)   |
| `~/.pi/agent/alibaba-config.json`                     | Endpoint / domain / format config  |
| `~/.pi/agent/alibaba-plan-models.cache.json`          | 4 h plan-models cache              |
| `~/.pi/agent/alibaba-cloud-models.cache.json`         | 4 h cloud-models cache             |

## From the same author

By [Francesco Frapporti](https://fornace.it) at [Fornace](https://fornace.it).

- **[pi-bench](https://github.com/fornace/pi-bench)** — LLM benchmark toolkit for pi. Probes every available model to find the fastest and cheapest.
- **[pi-recap](https://github.com/fornace/pi-recap)** — Always-visible session recap panel for pi. Uses pi-bench data to pick the fastest summarization model.
- **[pi-banana](https://github.com/fornace/pi-banana)** — Generate and edit images inside pi using Google Nano Banana. All package banners in this ecosystem were created with pi-banana.
- **[pi-notte-theme](https://github.com/fornace/pi-notte-theme)** — Notte: a true-dark pi theme where darkness has color and text glows like terminal phosphor.
