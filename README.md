# pi-alibaba-models

The complete [`pi`](https://github.com/badlogic/pi-mono) extension for Alibaba's model lineup — **Qwen 3.7 Max**, **Qwen 3.7 Plus** (both 1M context), **Qwen 3.6 Max**, **Qwen 3.6 Plus**, **DeepSeek V4 Pro**, **Kimi K2.6**, **GLM-5**, **MiniMax M2.5**, and the rest of the catalog. Native thinking-level support, both Anthropic- and OpenAI-shaped APIs, both International and China endpoints, both Coding Plan subscriptions and pay-per-token Cloud keys.

## Features

- **Dual Provider Support**: Both the subscription-based Model Studio Coding Plan **and** the pay-per-token Alibaba Cloud (DashScope) — registered side by side, switch per chat from the model picker.
- **Both API Shapes**: Anthropic-compatible (`/v1/messages`) by default; OpenAI-compatible (`/compatible-mode/v1`) auto-selected for DeepSeek and selectable per-Cloud via `/alibaba`.
- **Both Regions**: International (`dashscope-intl.aliyuncs.com`, Singapore plan host) and China (`dashscope.aliyuncs.com` + region-specific plan hosts) — switch with `/alibaba`, no re-login needed.
- **Native Reasoning**: First-class thinking-level support for every reasoning-capable model (Qwen 3.7 Max/Plus, Qwen 3.6 Max/Plus, DeepSeek V4, Kimi K2.6, GLM-5, MiniMax M2.5).
- **Vision Capable**: Image input automatically enabled for VL models and Qwen 3.x Plus variants.
- **Live Catalog**: Pulls the real `/v1/models` from DashScope on every login + the canonical Qwen-Code plan template. New models appear as Alibaba ships them — no extension update needed.

## How to Use (Quickstart)

1. **Install** the extension (see below).
2. **Restart** `pi` to load the extension.
3. Type `/login` in your pi chat input.
4. Select your provider based on your account type:
   - Choose **Plans > Alibaba Model Studio Coding Plan** if you have a subscription (your token likely starts with `sk-sp-` or `sk-tok-`).
   - Choose **Use an API key > Alibaba Cloud (API Key)** if you use the pay-as-you-go DashScope service (your token likely starts with `sk-`).
5. Paste your token when prompted.
6. Open the model picker, select a model (e.g., `Qwen 3.7 Max`, `Qwen 3.7 Plus`, `Qwen 3.6 Max`, or `DeepSeek V4 Pro`), and start chatting!

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
# Agent dir: ~/.pi/agent under pi, ~/.omp/agent under oh-my-pi
rm -f ~/.pi/agent/alibaba-config.json ~/.pi/agent/alibaba-plan-models.cache.json
# then edit <agent dir>/auth.json and remove the "alibaba-plan" / "alibaba-cloud" entries
# then edit <agent dir>/settings.json and drop any "alibaba-*/..." or "dashscope/..." entries from enabledModels
```

## Two providers

| Provider id    | Section in `/login`     | Auth shape | Use it for                                 |
|----------------|-------------------------|------------|--------------------------------------------|
| `alibaba-plan` | Plans                   | OAuth (paste token) | Model Studio Coding Plan subscription |
| `alibaba-cloud`| API Keys (via OAuth UI) | OAuth (paste API key) | Pay-per-token DashScope API           |

Both are registered as `oauth`-shaped providers so they appear in `/login` and live in the host's `auth.json` (`~/.pi/agent/auth.json` under pi, `~/.omp/agent/auth.json` under oh-my-pi) under their respective keys. The Plan provider stores the chosen endpoints in the `refresh` field as JSON; the Cloud provider stores its domain in `alibaba-config.json` in the same agent directory. The agent directory is resolved generically: `PI_CODING_AGENT_DIR` if set, then `PI_CONFIG_DIR`, then `~/.omp` when running under oh-my-pi, otherwise `~/.pi` (named profiles via `OMP_PROFILE`/`PI_PROFILE` resolve to `<config root>/profiles/<name>/agent`).

> **Cloud without `/login`:** the Cloud provider also reads the `DASHSCOPE_API_KEY` environment variable. If it's set, the extension fetches your live model catalog from it on startup — no `/login` needed. With **no** credential at all (no `/login`, no env var) the Cloud provider still shows up in `/login → Use an API key` via a single placeholder model, so you can sign in; your real catalog replaces it the moment a key is present.

### Endpoints

**Plan (default Singapore / Global):**
- Anthropic-compat: `https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic` (pi appends `/v1/messages`)
- OpenAI-compat:    `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`

**Cloud (default International):**
- Anthropic-compat: `https://dashscope-intl.aliyuncs.com/apps/anthropic`
- OpenAI-compat:    `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`

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

| Region        | Plan host                                         | Cloud host                       |
|---------------|---------------------------------------------------|----------------------------------|
| International | `token-plan.ap-southeast-1.maas.aliyuncs.com`     | `dashscope-intl.aliyuncs.com`    |
| China         | (region-specific host, paste via "Custom")        | `dashscope.aliyuncs.com`         |
| Custom        | paste both base URLs at login                     | paste domain at login            |

## Studio plan models — dynamic source

The plan model list is fetched from the canonical Qwen Code template:

<https://github.com/QwenLM/qwen-code/blob/main/packages/cli/src/constants/codingPlan.ts>

Cached at `<agent dir>/alibaba-plan-models.cache.json` for **4 hours**. The live API is always the source of truth; on a failed fetch the extension falls back to the last-known-good on-disk cache (and, if there's no cache either, registers an empty list rather than crashing). Force a refresh from `/alibaba → Refresh model lists`.

`deepseek-v3.2` (and any plan-served models the upstream template omits) is merged in via a small allow-list so the picker reflects what the endpoint actually serves. The Cloud provider mirrors the live `/v1/models` response — V4 Pro/Flash, Qwen 3.7 Max/Plus, Qwen 3.6 Max/Plus, Kimi K2.6, GLM-5, MiniMax M2.5 etc. all surface automatically as Alibaba ships them.

## Limitations & Known Issues

- **DeepSeek Compatibility**: The Anthropic-compatible path on the Alibaba Plan host often hangs or times out for DeepSeek models. To resolve this seamlessly, this extension automatically forces any model ID containing `deepseek` to use the **OpenAI-completions endpoint** instead.
- **Model Availability (404s)**: The model picker displays the universally *advertised* catalog. However, if your specific Alibaba Cloud account or Model Studio subscription tier does not include access to a specific model, the API will return a `model_not_found` error only when you actually attempt to send a message.
- **API Wrapper Quirks**: Alibaba's native Anthropic compatibility layer can occasionally be strict or quirky with complex parallel tool calls. If you experience systemic parsing errors on DashScope, you can use the `/alibaba` command to switch your Cloud API format to "OpenAI".
- **Dynamic Caching**: Model lists are cached for 4 hours. If a new model drops and you don't see it, run `/alibaba` -> `Refresh model lists`.
- **Inferred Context Windows**: The `/v1/models` API returns only ids and names, so context windows are inferred from the model id. If a brand-new model shows the wrong size, fix it yourself with `/alibaba → Context Window — Override` (per model, or `*` for all) — no extension update needed.

## `/alibaba` command reference

| Choice                       | What it does                                                              |
|------------------------------|---------------------------------------------------------------------------|
| Status                       | Print Plan/Cloud login state, active endpoints, model count, cache age   |
| Refresh model lists          | Force-refetch Plan + Cloud catalogs and reload the extension             |
| Re-login Plan                | Wipe `alibaba-plan` from `auth.json` and reload (then run `/login`)      |
| Re-login Cloud               | Wipe `alibaba-cloud` from `auth.json` and reload (then run `/login`)     |
| Plan — Change Endpoints      | Override OpenAI / Anthropic base URLs                                    |
| Cloud — Change Domain        | International / China / Custom domain                                    |
| Cloud — Change API Format    | Switch between Anthropic-compat and OpenAI-compat                        |
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
| `<agent dir>/auth.json`                               | Both provider credentials (0600)   |
| `<agent dir>/alibaba-config.json`                     | Endpoint / domain / format config  |
| `<agent dir>/alibaba-plan-models.cache.json`          | 48 h plan-models cache             |
| `<agent dir>/alibaba-cloud-models.cache.json`         | 48 h cloud-models cache            |

`<agent dir>` is `~/.pi/agent` under pi and `~/.omp/agent` under oh-my-pi (honoring `PI_CODING_AGENT_DIR`, `PI_CONFIG_DIR`, and named profiles).

## From the same author

By [Francesco Frapporti](https://fornace.it) at [Fornace](https://fornace.it).

- **[pi-bench](https://github.com/fornace/pi-bench)** — LLM benchmark toolkit for pi. Probes every available model to find the fastest and cheapest.
- **[pi-recap](https://github.com/fornace/pi-recap)** — Always-visible session recap panel for pi. Uses pi-bench data to pick the fastest summarization model.
- **[pi-banana](https://github.com/fornace/pi-banana)** — Generate and edit images inside pi using Google Nano Banana. All package banners in this ecosystem were created with pi-banana.
- **[pi-notte-theme](https://github.com/fornace/pi-notte-theme)** — Notte: a true-dark pi theme where darkness has color and text glows like terminal phosphor.
