# pi-alibaba-models

The complete [`pi`](https://github.com/badlogic/pi-mono) extension for Alibaba's model lineup — **Qwen 3.8 Max**, **Qwen 3.7 Max / Plus**, **Qwen 3.6 Max / Plus**, **DeepSeek V4 Pro**, **Kimi K2.6**, **GLM-5**, **MiniMax M2.5**, and the rest of the catalog. Native thinking-level support, **OpenAI Responses by default** (since 1.5.0) plus OpenAI Chat Completions and Anthropic Messages, International / China / US / workspace endpoints, both Coding Plan subscriptions and pay-per-token Cloud keys.

## Features

- **Dual Provider Support**: Both the subscription-based Model Studio Coding Plan **and** the pay-per-token Alibaba Cloud (DashScope) — registered side by side, switch per chat from the model picker.
- **Three API Shapes**: OpenAI **Responses** (`/compatible-mode/v1/responses`) **by default since 1.5.0** (session-cache economics, agent-native features); OpenAI Chat Completions (`/compatible-mode/v1`) auto-selected for DeepSeek and for models without Responses support; Anthropic-compatible (`/v1/messages`) still selectable per-Cloud via `/alibaba`.
- **Five+ Regions**: International (`dashscope-intl.aliyuncs.com`), China, US-Virginia, Hong Kong, plus Alibaba's recommended **workspace domains** `{WorkspaceId}.{region}.maas.aliyuncs.com` for Beijing / Singapore / Tokyo / Frankfurt / US — switch with `/alibaba`, no re-login needed. Shared regional domains are **auto-upgraded** to the matching workspace domain when the WorkspaceId is discoverable and the candidate passes a probe. Replacing the API key **re-derives the endpoint from scratch** — the default (shared) endpoint first, then the corporate upgrade — so a stale workspace domain can never 403 a new key.
- **Native Reasoning**: First-class thinking-level support for every reasoning-capable model, including `reasoning.effort` on Responses and Completions effort maps for Qwen 3.8 / GLM-5.x / DeepSeek V4.
- **DashScope sidecar tools**: one Pi tool, `alibaba_tools`, for live web search, page extract, code interpreter, and image search. Billed separately. Does not change the chat API format.
- **Image generation** (Cloud): DashScope's `qwen-image-*`, `z-image-*`, and `wan*-image`/`wan*-t2i` families are registered as pi **image models**, reachable from `codemode` scripts through `models.generateImages()` **and** through a dedicated `alibaba_image` tool that carries every generation parameter. Also available without `codemode` via `/alibaba image <prompt>`. Plan accounts register no image models.
- **Configurable tool exposure**: each Alibaba tool can be `codemode` (default), `direct`, `deferred`, or off. The default keeps tool declarations out of every request while surviving a reload and staying callable from scripts.
- **Vision Capable**: Image input automatically enabled for VL models, Qwen 3.8, Qwen 3.x Plus variants, and Kimi.
- **Prompt-cache warming that treats latency as the point**: the extension replays your last request with a 16-token cap to keep DashScope's 5-minute cache block alive — on its own schedule, for hours, with retries — so a long pause does not turn the next turn into a 1–2 minute cold prefill. Tunable in `/alibaba → Cloud — Cache Warming`, with per-turn cache telemetry (`cached_tokens` **and** the `cache_creation_input_tokens` pi never sees).
- **Honest catalog pricing**: input/output/cache-read/cache-write are parsed from the exact price rows (tiered models priced at the tier you actually send, peak vs off-peak resolved, thinking-mode rows understood) and declared in CNY or converted USD.
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

> **Distribution status.** This repository is a **personal fork** (original: [Fornace/pi-alibaba-models](https://github.com/Fornace/pi-alibaba-models)), built for one's own use first. There is **no npm release line for this fork** — publishing under a personal npm name is a distant plan. `pi install pi-alibaba-models` / `pi install npm:pi-alibaba-models` resolve the **original, much older** npm package, not this fork. Install from git or a local checkout.

> **Host versions.** Requires pi **1.0.0 or newer** — the release uses the union-typed model list (image models), the tool `exposure` API, and `provider_stream_event` directly, and drops the pre-1.0.0 compatibility shim (ADR-0001). Verified against pi **1.0.0** (2026-10-03) and re-verified against **1.0.2** (2026-10-04), **1.0.4** (2026-10-06), **1.1.0** (2026-10-08) and **1.2.0** (2026-10-13): `tsc --noEmit` clean (tsc 6.0.3), 284/284 tests green, `pi -ne -e <repo> --offline --list-models alibaba-cloud` registers the provider, plus a live Cloud session on 1.1.0 (`alibaba-cloud/qwen3.8-max-0902`, `openai-responses`, thinking `high`) that exercised the whole path — streaming turns, the warm engine's refreshes and the `alibaba-cache.jsonl` telemetry, with ~99 % of each prompt read from cache, and a live Cloud session on 1.2.0 (`alibaba-cloud/qwen3.8-flash`, `openai-responses`) whose cold turn wrote the cache block and whose next turn read it back at 99.3 % (`alibaba-cache.jsonl`, `ok: true`). The 1.0.1–1.2.0 releases added no API break this extension relies on — the deltas are additive (`registerToolRenderer`, `getPromptGuidelines`, `durationMs`/`outputPad` in the tool render context, `aborted` on `agent_settled`, `+name`/`-name` in `--tools`), with one 1.2.0 change handled by design rather than by code: `before_agent_start` is now a union on `messageType` that also fires for runs started by `pi.sendMessage(..., { triggerTurn: true })`, and the codemode-tools section deliberately applies to both kinds (see the 2.1.4 changelog entry). The host internals this extension depends on were re-read unchanged in 1.2.0: pi's warmer constants (the $0.05 expected-savings gate, the 30/60-minute horizons, the `min(0.9·ttl, ttl−10 s)` schedule, the half-margin late-timer deadline), `oauth.modifyModels` still projected over chat models, `onPayload` (`before_provider_request`) still reaching only loop requests, and the PackageManager layouts the duplicate guard mirrors (`<agentDir>/npm/node_modules/<name>`, `<agentDir>/git/<host>/<path>`, `.pi/…` for project scope). 1.5.3 is the last line that runs on pre-1.0.0 hosts.
>
> One 1.1.0 host change is worth knowing about: standalone/managed pi binaries **no longer load `.env`, `.env.local` or `.env.development` from the launch directory**. A `DASHSCOPE_API_KEY` that lived only in such a file stops reaching the Cloud provider — export it for real, or store it with `/login → Alibaba Cloud (API Key)`.

```bash
# from this fork (recommended)
pi install git:github.com/RarogCmex/pi-alibaba-models

# or from a local checkout (development)
git clone https://github.com/RarogCmex/pi-alibaba-models
cd pi-alibaba-models && pi install .

# the bare name / npm form installs the ORIGINAL upstream package, not this fork:
#   pi install pi-alibaba-models
#   pi install npm:pi-alibaba-models
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
rm -f ~/.pi/agent/alibaba-config.json ~/.pi/agent/alibaba-models.cache.json ~/.pi/agent/alibaba-catalog.lock* \
      ~/.pi/agent/alibaba-cache.jsonl \
      ~/.pi/agent/alibaba-plan-models.cache.json ~/.pi/agent/alibaba-cloud-models.cache*.json  # 1.4.x leftovers
# then edit ~/.pi/agent/auth.json and remove the "alibaba-plan" / "alibaba-cloud" entries
# then edit ~/.pi/agent/settings.json and drop any "alibaba-*/..." or "dashscope/..." entries from enabledModels
```

## Two providers

| Provider id    | Section in `/login`     | Auth shape | Use it for                                 |
|----------------|-------------------------|------------|--------------------------------------------|
| `alibaba-plan` | Plans                   | OAuth (paste token) | Model Studio Coding Plan subscription |
| `alibaba-cloud`| API Keys                | API key | Pay-per-token DashScope API           |

Plan is registered as an `oauth` provider (paste token in `/login`). Cloud is registered as an API-key provider (`apiKey: "$DASHSCOPE_API_KEY"`) and shows up under `/login → Use an API key`; credentials are stored as `{ type: "api_key", key }`. Older Cloud entries saved in OAuth shape are migrated to that API-key record. The Plan provider stores the chosen endpoints in the `refresh` field as JSON; the Cloud provider stores its domain in `~/.pi/agent/alibaba-config.json`.

> **Cloud without `/login`:** the Cloud provider also reads the `DASHSCOPE_API_KEY` environment variable. If it's set, the extension fetches your live model catalog from it on startup — no `/login` needed. With **no** credential at all (no `/login`, no env var) the Cloud provider still shows up in `/login → Use an API key` via a single placeholder model, so you can sign in; your real catalog replaces it the moment a key is present.

### Endpoints

**Plan (default Singapore / Global):**
- Anthropic-compat: `https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic` (pi appends `/v1/messages`)
- OpenAI-compat:    `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`

**Cloud (default International):**
- Anthropic-compat: `https://dashscope-intl.aliyuncs.com/apps/anthropic`
- OpenAI-compat:    `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` (Chat Completions **and** Responses)

> **OpenAI Responses API** (`/compatible-mode/v1/responses`): Alibaba's newest OpenAI-compatible surface, with `reasoning.effort` thinking levels. **Default since 1.5.0** — an unset format is pinned to it at first boot, and formats chosen explicitly are never touched. The sidecar is **not** mixed into that chat stream (pi still sends its own agent tools). Enable them separately with `/alibaba → Tools — Exposure → alibaba_tools → direct` (or `codemode` to keep the declaration out of every request): that registers `alibaba_tools`, which makes its own Cloud request (Responses, or Completions `enable_search` for a cheap search) using a Qwen model. DeepSeek stays on Chat Completions when the Cloud format is Anthropic (that path hangs); on Responses it follows the selected format (Beijing/Singapore per Alibaba's docs).

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

> Workspace domains are the ones Alibaba recommends (and they're required for Japan/Frankfurt). `/alibaba → Cloud — Change Domain` asks for your business-space ID and builds the host — the ID discovered by the auto-upgrade pre-fills the prompt (blank input reuses it).

### Workspace-domain auto-upgrade

Although Alibaba's docs say the WorkspaceId is console-only, the key's workspace is discoverable: `GET /api/v1/models/limits` returns `workspace_id` on every quota row — even on the shared domains where the endpoint itself is undocumented. So on boot (and on `session_start`, which covers logging into Cloud mid-session), when the Cloud endpoint is one of the three shared regional domains (`dashscope.aliyuncs.com` → Beijing, `dashscope-intl.aliyuncs.com` → Singapore, `dashscope-us.aliyuncs.com` → US), the extension:

1. reads the `workspace_id` bound to your key (cached value as fallback),
2. probes `{WorkspaceId}.{region}.maas.aliyuncs.com` with a cheap catalog GET,
3. **only if the probe succeeds**, saves it as the new Cloud domain and logs the switch.

A failed probe changes nothing and retries at most once per 24h. Hong Kong, custom, and already-workspace domains are never touched (a **key swap** re-derives even a workspace domain — see below). Picking a shared domain explicitly via `/alibaba → Cloud — Change Domain` counts as “stay here” and disables the auto-upgrade; manage it anytime via `/alibaba → Cloud — Auto workspace domain` (detect now / enable / disable). `/alibaba → Status` shows the current state (`Auto-WS`) and the discovered WorkspaceId.

**Swapping the API key:** the endpoint is derived from the key, and that derivation is tracked as a key fingerprint (`cloudKeyFingerprint` in `alibaba-config.json`; the key itself stays in `auth.json`). pi's `/login` API-key write fires no extension hook, so the swap is caught the first time the extension observes an unseen key (boot, `session_start`, or a catalog refresh) and the endpoint is **re-derived from scratch**, in a fixed order:

1. the key is verified against the **default** (shared regional) endpoints first — the current region's own default first (e.g. the Beijing default `dashscope.aliyuncs.com` behind a `{WorkspaceId}.cn-beijing.maas.aliyuncs.com` endpoint), then the other sites' defaults, since CN ↔ International ↔ US keys do not cross-authenticate — and the endpoint lands on whichever default accepts it;
2. only then is the verified default **upgraded to the corporate (workspace) endpoint** of the *new* key's own WorkspaceId (skipped when auto-upgrade is disabled).

The previous key's endpoint is never inherited — keeping it is exactly what turned a key swap into `403` on every request. The derivation runs **once per key** (zero network afterwards), switches endpoints only on positive probe evidence (offline or an invalid key changes nothing and retries on the next run), drops the stale `cloudWorkspaceId` cache, and keeps a workspace's home region across a same-workspace swap (Tokyo / Frankfurt don't drift to another region's suffix). Hong Kong and custom domains are key-independent user config and are never re-derived. `Re-login Cloud` clears the binding so the replacement key is re-derived immediately; `Detect & upgrade now` remains the manual escape hatch.

### Rate limits

`/alibaba → Rate limits (Cloud)` queries `GET /api/v1/models/limits` with your API key and prints each model's quota. Read-only and best-effort — the endpoint is currently only documented on the **Beijing workspace domain**.

### Authorized-models filter

`GET /api/v1/models/permissions` returns the models your business space is authorized to call. When the endpoint is reachable (Beijing workspace domain), the extension intersects it with the live catalog and hides models you don't have inference permission for. On by default; disable via `/alibaba → Cloud — Authorized-only Filter`. If the fetch fails or the intersection would be empty, the full catalog is shown.

## Prompt cache & warming

DashScope caches the **prefix** of a request for 5 minutes, and every hit renews that window
(measured, not documented behaviour — see `docs/notes/`). A hit is worth latency first and money
second: a 150k–220k-token prompt answers in **10–17 s from cache and 57–151 s cold**. Warming is how
a pause longer than five minutes stops costing a minute of wall time.

**This extension runs its own warmer for Cloud models** (`extensions/cache-warm.ts`). It captures each
request as pi dispatches it — payload and resolved headers — and replays it byte-identically with a
16-token output cap, which renews the block without producing an answer. pi's own warmer is a
money mechanism: it refreshes only when the expected savings clear $0.05, gives up permanently when a
timer fires a few seconds late, and stops 30 min after the last request. Those rules cost 10 of 146
warms in our own history — each one arriving after expiry and paying a full-price rewrite. Because
`promptCache` is the only model field pi's warmer reads, Cloud cards declare it only in `pi` mode, so
the two engines never refresh the same block.

`/alibaba → Cloud — Cache Warming`:

| Setting | Default | Meaning |
|---|---|---|
| Engine | `extension` | `extension` = this warmer (own horizon, retries, no dollar gate); `pi` = pi's warmer, with our `cache_warming_decision` handler replacing its savings gate by the same latency rule; `off` = no warming |
| Refresh interval | 216 s | Seconds between refreshes. The block lives 300 s, so the gap is your margin: 150 s → 150 s of slack, 270 s → 30 s |
| Horizon | 240 min | How long to keep warming after the last real request |
| Minimum prompt | 20 000 tokens | Smaller prompts are fast even when cold; warming them only spends quota |
| Telemetry | on | One JSON line per turn and per warm in `alibaba-cache.jsonl` |

The same page has **Warm now** (send a refresh immediately and print what the provider reported) and
**Cache statistics** (hit rate, cached vs cold tokens, and how the refreshes ended: hits, rewrites
that arrived after expiry, **blind** replays, failures). Rewrites mean the interval is too long for
your prompt size; blind means the provider answered and reported neither a hit nor a creation, so
nothing says the block was renewed. `/alibaba → Status` shows the engine state, the next refresh,
and the current model's cache economics.

Failures back off (×2, ×3, ×4 on the interval) and end the run after four, because a warm that cannot
get through is usually a rate limit and the next real request needs that quota. **Three blind
replays in a row end it too** — a context whose refreshes renew nothing is paying a full prefill
every interval for nothing (measured: 27 replays of a 376 453-token `deepseek-v4.1-flash` context
over 1 h 37 m, `cached_tokens` 0–4 096, 22–50 s each, and no real request ever came back for the
block — [`docs/notes/2026-10-11-cache-warm-blind-probes.md`](docs/notes/2026-10-11-cache-warm-blind-probes.md)).
Any real request clears the streak. A warm never overlaps
a real request, and compaction or a branch switch drops the captured request instead of warming a
prefix that no longer exists. Records carry a `ctx` id (a hash of the cached prefix head) so a miss
can be attributed to one context when several run in parallel.

### What a cached turn costs

Prices come from the live catalog (`GET /api/v1/models`), matched by exact row type, in the tier that
contains `priceTierTokens` (default 128k) and the `standard` time band. The catalog bills **CNY per
million tokens**; `costCurrency` says whether pi's `cost.*` should carry those numbers (default — the
figure the Bailian console bills) or convert to USD at `cnyPerUsd` (default 7.1). Status always states
the unit.

For `qwen3.8-max-0902` (12 CNY/M input): a session-cache **read costs 1** (8.3 %), a **write 15**
(125 %), an implicit-cache read 1.5 (12.5 %). Explicit caching is what the wire actually uses —
the `x-dashscope-session-cache` header on Responses, `cache_control` markers on the Anthropic and
Completions shapes — and the declared read/write pair follows that. Families without explicit-cache
rows (`glm-5.3`, `kimi-k3`, `deepseek-v4.x`) stay on implicit caching, where the header and the
markers are no-ops and reads cost 10–25 %.

**The declared context window is what the endpoint accepts, not what the catalog calls the window.**
Completions and Anthropic reject an oversized prompt with `400 Range of input length should be
[1, N]`; Responses **silently truncates** instead — keeping the head and the tail and dropping the
middle, so the model answers confidently over a transcript with a hole in it, and the cached prefix
dies with it. `N` is per model and matches no single catalog field (it is `reasoning_max_input_tokens`
for qwen3.8-*, `max_input_tokens` for MiniMax-M2.1, and plain `context_window` for qwen-plus,
kimi-k2.6, deepseek-v3.2 and glm-5.1 — where it is *larger* than both), so cards declare the
**measured** cap where we have one and a derived one otherwise:

| Model | catalog window | Responses | Completions / Anthropic |
|---|---|---|---|
| qwen3.8-max-0902 | 1 000 000 | **792 945** measured | 983 616 measured |
| qwen3.8-flash | 1 000 000 | **800 056** measured | 983 616 measured |
| qwen3.7-plus / -flash, qwen3.6-flash | 1 000 000 | **792 907** measured | 983 616 derived |
| qwen3.5-plus / -flash / -27b / -35b-a3b | 1 000 000 / 262 144 | **90 000** measured generation budget | 983 616 / 258 048 |
| deepseek-v4.1-flash | 1 000 000 | **754 977** measured | 1 000 000 measured |
| deepseek-v4-pro | 1 000 000 | 755 000 derived | 1 000 000 derived |
| glm-5.3, kimi-k3 | 1 000 000 | 780 000 derived | 1 000 000 (the window binds) |
| MiniMax-M2.1 | 204 800 | 134 184 derived | 172 032 measured |

The qwen3.5 line is the reason this is measured rather than computed: the documented rule ("~80 % of
the context window") holds at 79.3–80.0 % for qwen3.6/3.7/3.8 and 75.5 % for deepseek-v4, but qwen3.5
sits on a flat ~90 000-token budget — 9 % of a 1 M window. Deriving 80 % there would let pi fill a
transcript the endpoint then hollows out.

`/alibaba → Status` prints the declared window for the model in use **and where it came from**
(`measured` / `derived` / `your override` / `catalog`), so a guess is visible as a guess. A
`Context Window — Override` still wins outright, and `/alibaba → Cloud — Responses Input Guard: On /
Off` re-declares the full window if you would rather see the catalog number and accept the
truncation. Measurements, method and a re-probe script:
[`docs/notes/2026-10-07-dashscope-input-caps.md`](docs/notes/2026-10-07-dashscope-input-caps.md).

Fixed on the same pass: `maxTokens` now respects `reasoning_max_output_tokens`, because `qwen3-max`
answers `Range of max_tokens should be [1, 32768]` to the 65 536 its own catalog row advertises
whenever thinking is on — a hard 400 on every turn.

### Keeping the prefix stable

The cache is **prefix-scoped**: it stores bytes, not sessions, and one changed byte near the front
invalidates everything after it. In our own telemetry that was the single largest loss — 38 % of
cold-miss spend happened *under 300 s after the previous request*, i.e. not from expiry but from
rewrites no warmer can undo. Three rules, in order of impact:

1. **Tool definitions ride in the system message.** Adding, removing or reordering tools — or editing
   a description — costs a full-price rewrite of the whole prompt on the next turn. This is why both
   Alibaba tools default to `codemode` exposure: they stay callable without being declared every turn.
2. **Time rewrites to a dead cache.** Compaction, context edits, persona/role switches and skill-list
   changes all invalidate the prefix, so their marginal cost is zero right after a pause of 5+ minutes
   and maximal in the middle of a run. Compact on resume, not mid-turn.
3. **Nothing volatile in the system prompt.** A timestamp, a counter or a changing working-directory
   listing in any prompt section costs a full miss on every turn. This extension's own
   `before_agent_start` section is static for exactly that reason.

A related consequence: because the cache is prefix-scoped rather than session-scoped, two sessions
that share a byte-identical prefix share the block. Subagents could inherit their parent's cache the
same way — that needs pi-subagents to keep the forked prefix identical, and is tracked in
`docs/TODO.md` (P2-I).

## Studio plan models — dynamic source

The plan model list is fetched from the canonical Qwen Code template:

<https://github.com/QwenLM/qwen-code/blob/main/packages/cli/src/constants/codingPlan.ts>

Model catalogs use the **"plan C" hybrid**: a private versioned snapshot (`alibaba-models.cache.json`) seeds provider registration at boot — zero network, so `pi --list-models` and `enabledModels` validation see real ids at once — while `refreshModels` additionally serves and publishes pi's own models store as a bonus channel (pi's legacy provider form does not persist returns on its own). A **missing bundle force-refreshes at startup** (first run, fresh agent dir, right after `Reset all`) instead of booting an empty catalog. Neither source is treated as proof of freshness: a shared 10-minute timestamp in `alibaba-config.json` governs that, and an `alibaba-catalog.lock` lockfile serializes fetchers across instances. A failed fetch keeps the previous list (and, with none, registers an empty list rather than crashing). `/alibaba → Refresh model lists` forces a refresh through `ctx.modelRegistry.refresh({force: true})`.

The Cloud provider prefers Alibaba's native `GET /api/v1/models` (paginated, text-generation models) and falls back to compatible-mode `/v1/models` on domains that don't expose it. Qwen 3.8 Max, Qwen 3.7 Max/Plus, DeepSeek V4, Kimi, GLM-5, MiniMax etc. all surface automatically as Alibaba ships them.

## Limitations & Known Issues

- **DeepSeek Compatibility**: The Anthropic-compatible path on the Alibaba Plan host often hangs or times out for DeepSeek models. To resolve this seamlessly, this extension automatically forces any model ID containing `deepseek` to use the **OpenAI-completions endpoint** instead.
- **Model Availability (404s)**: When `GET /api/v1/models/permissions` is reachable, the picker shows the catalog your account is authorized to call. Toggle with `/alibaba → Cloud — Authorized-only Filter`. On other domains the advertised catalog is shown and a model you can't access still errors only when you send a message.
- **API Wrapper Quirks**: Alibaba's native Anthropic compatibility layer can occasionally be strict or quirky with complex parallel tool calls. If you experience systemic parsing errors on DashScope, switch Cloud API format to "OpenAI Chat Completions" or "OpenAI Responses".
- **Responses API**: not every model supports every built-in DashScope tool, and `xhigh`/`max` effort are documented for Beijing/Singapore. If a model errors out, switch back to Chat Completions or Anthropic for that session.
- **`alibaba_tools`**: Cloud key required (`/login` or `$DASHSCOPE_API_KEY`). Qwen only — 3.7 Max / 3.6 Plus+ search is Responses-only. Completions search does not return source URLs; Responses search/research can. Auto sidecar model prefers Flash/Plus over Max. Search usage is billed on the sidecar call. A silent hang should not happen: the tool card streams elapsed time and built-in calls. Sidecar 429s and transient `server_error` backend failures (`Backend buffer overflow`) retry inside the tool (user sees `429 / server_error, retrying…`; the model only gets the final result). If it still times out, narrow the task or raise `ALIBABA_SIDECAR_TIMEOUT_MS`.
- **Image generation**: Cloud only; a Plan account registers no image models. DashScope bills **per image**, not per token, so the picker's cost figures do not cover image generation and image cards declare zero cost. pi's own `models.generateImages()` carries only a prompt and reference images — no `size`, `n`, `seed`, or prompt-extension switches — which is why `alibaba_image` and `/alibaba image` exist. A generation takes 6–57 s depending on the model. The returned URLs expire in 24 hours, so the extension downloads the bytes and returns image content; nothing is written to disk unless `save` (tool) or `--save` (command) is given.
- **Output budget vs. thinking budget**: On the Anthropic path, `max_tokens` is a **total** budget shared between thinking and the final answer. pi splits the card's `maxTokens` accordingly, so a card value of 8192 leaves only 8192 − 7168 = **1024 tokens** for the actual answer at high thinking — enough to truncate large tool calls (e.g. big `write`/`edit` content) mid-arguments. The card therefore reports the model's own catalog `max_output_tokens` whenever the catalog has a row (clamped at 131072 — e.g. `qwen-plus` = 32768, which yields a 16384-token answer budget at high thinking). Models with **no** catalog row keep a conservative fallback (32768; 8192 for non-reasoning ids and the open-weight `qwen3-<size>b` line, measured at 8192), because overshooting the real ceiling is rejected outright with `Range of max_tokens should be [1, N]`. Completions and Responses keep the catalog's larger output ceilings.
- **Dynamic Caching**: Model lists use the plan-C hybrid (private snapshot + pi's models store as a bonus channel; details above). If a new model drops and you don't see it, run `/alibaba` -> `Refresh model lists` (force — always fetches).
- **Prompt caching & cache warming**: Cloud models are warmed by **this extension's own engine**, not by pi's — see [Prompt cache & warming](#prompt-cache--warming) for the settings and the reasons. pi's global `cacheWarming` setting therefore has no effect on Cloud models unless you switch the engine to `pi` (`/alibaba → Cloud — Cache Warming → Engine…`), which declares `promptCache` again and hands the schedule back to the host. The Plan provider still uses pi's warmer with the documented 5-minute window. No `long` tier is declared anywhere (DashScope publishes none), and the open-weight `qwen3-<size>b` line has no documented caching, so it is never warmed.
- **Inferred Context Windows**: Compatible-mode `/v1/models` returns only ids and names, so context windows are inferred from the model id unless native `/api/v1/models` supplied a real value. If a brand-new model shows the wrong size, fix it yourself with `/alibaba → Context Window — Override` (per model, or `*` for all) — no extension update needed.

## `/alibaba` command reference

| Choice                       | What it does                                                              |
|------------------------------|---------------------------------------------------------------------------|
| Status                       | Print Plan/Cloud login state, active endpoints, model count, catalog fetch age |
| Refresh model lists          | Force-refetch Plan + Cloud catalogs and reload the extension             |
| Re-login Plan                | Wipe `alibaba-plan` from `auth.json` and reload (then run `/login`)      |
| Re-login Cloud               | Wipe `alibaba-cloud` from `auth.json` and reload (then run `/login`)     |
| Plan — Change Endpoints      | Override OpenAI / Anthropic base URLs                                    |
| Cloud — Change Domain        | International / China / US / HK / workspace domains / Custom             |
| Cloud — Change API Format    | OpenAI Responses (default) / Anthropic Messages / OpenAI Chat Completions |
| Cloud — Session Cache: On / Off | toggles `x-dashscope-session-cache` on Cloud Responses requests |
| Cloud — Cache Warming        | Engine (extension / pi / off), refresh interval, horizon, minimum prompt size, telemetry, Warm now, Cache statistics |
| Cloud — Responses Input Guard: On / Off | Whether cards declare the endpoint's effective input cap (measured per model) or the catalog's full context window |
| Tools — Exposure | Set `alibaba_tools` / `alibaba_image` to codemode (default), direct, deferred, or off |
| Tools — Sidecar model | Pin the Qwen model `alibaba_tools` uses (blank = auto) |
| Image — Default model | Pick the default DashScope image model for the tool and `/alibaba image` |
| Rate limits (Cloud)          | Show per-model rate/usage quotas (`/api/v1/models/limits`)               |
| Cloud — Authorized-only Filter | Toggle hiding catalog models the account isn't authorized to call      |
| Context Window — Override    | Set the context-window shown on a model's card (per model, or `*` for all) |
| Reset all                    | Wipe all Alibaba state (config, both auth entries, plan-models cache)    |

Enable `alibaba_tools` (it defaults to `codemode` exposure), then ask the agent for live docs or news. Typical calls:

```text
alibaba_tools({ action: "search", task: "Hangzhou weather tomorrow" })
alibaba_tools({ action: "research", task: "What changed in DashScope web_search this week?" })
```

Default to **`search`**. `research` (search + extractor + interpreter, thinking on) is slower and only worth it when search was too thin. The sidecar **streams** into the tool card (heartbeat every 4s) so a long call is not a silent hang. Limits: 3 min for search/code/image, 8 min for research — override with `ALIBABA_SIDECAR_TIMEOUT_MS`. Chat format is unchanged.

## Tool exposure

Each Alibaba tool has its own exposure (`/alibaba → Tools — Exposure`), written to `alibabaToolsExposure` / `alibabaImageExposure`:

| Exposure | Meaning |
|---|---|
| `codemode` (default) | Registered and callable from `codemode` scripts; **not** declared to the model on every turn, only listed in the `codemode` tool description under the `alibaba` namespace. A system-prompt line tells the model the tools exist. |
| `direct` | Declared to the model on every turn (the old `alibaba_tools` behaviour). |
| `deferred` | Reachable through `tool_search` instead of the `codemode` listing. |
| `off` | Not registered at all; costs nothing and is unreachable. |

Both tools share one namespace (`alibaba`) with longer `instructions` a script reads through `describeNamespace("alibaba")`. `alibaba_tools` is marked non-destructive; `alibaba_image` is marked destructive because `save` can overwrite a file. With both tools left at the default and `codemode` disabled in pi, neither is reachable — `/alibaba image <prompt>` is then the only Alibaba generation path.

## Image generation

Cloud keys register Alibaba's prompt-driven image models (`qwen-image-3.0-pro`, `qwen-image-3.0`, `qwen-image-max`, `qwen-image-plus`, `qwen-image`, `qwen-image-2.0`, `z-image-turbo`, `wan2.7-image-pro`, `wan2.6-t2i`, plus the `qwen-image-edit-*` editors) as pi **image models**. Vertical products (virtual try-on, face chains, word art) and third-party ids are never registered. Image models use the same Cloud key and Domain as chat. `qwen-image-3.0-pro` and `qwen-image-3.0` are hybrids — they generate from text *and* edit 1–3 references — and only the `qwen-image-edit-*` models require references.

Three ways to use them:

1. **From a `codemode` script** — pi's own API, prompt and reference images only:

   ```js
   // @options: {"timeout_ms": 300000}
   const painter = await models.getModelOfType("image", "alibaba-cloud", "qwen-image-plus");
   const result = await models.generateImages(painter, { input: [{ type: "text", text: "a red fox in the snow" }] });
   if (result.stopReason !== "stop") return result.errorMessage;
   for (const block of result.output) if (block.type === "image") image(block);
   ```

   pi's script API cannot carry generation parameters, so it uses each model's default size.
2. **The `alibaba_image` tool** — every parameter DashScope accepts. Reachable directly (exposure `direct`) or from `codemode` (default):

   ```text
   alibaba_image({ task: "a red fox in the snow", model: "qwen-image-max", size: "1664*928", n: 2, seed: 7, save: "fox.png" })
   ```

   Parameters: `model`, `task` (prompt), `images` (0–3 local paths or `data:` URLs to edit; remote URLs are not supported), `size` (`<width>*<height>`), `n`, `seed`, `negative_prompt`, `watermark`, `prompt_extend`, `prompt_extend_mode` (`direct`/`agent`), `enable_thinking`, `save`. The result carries the image blocks to the model **and** as `structuredContent` to scripts. `save` is the only file-writing behaviour; without it nothing is written. With `n > 1` the first image goes to `save` and the rest get a numeric suffix (`fox-2.png`, `fox-3.png`).
3. **Without `codemode`** — `/alibaba image <prompt> [--model id] [--size 1024*1024] [--n 2] [--seed 7] [--negative "…"] [--no-watermark] [--prompt-extend-mode agent] [--thinking] [--image ref.png] [--save out.png]`. It reports elapsed time while the model works (6–57 s is normal) and shows the result in the transcript.

The default image model is set from `/alibaba → Image — Default model` (`imageModel` in config) and reported in `/alibaba → Status`. Generated URLs expire in 24 hours, so the extension downloads the bytes: what you see in the session is the image itself.

## Troubleshooting

- **Model picker shows "No matching models"** → run `/login`, pick the right Alibaba entry, paste your key. Models register only after a successful login (Cloud fetches its real model list at boot from the live key).
- **`sk-sp-` accidentally pasted into the Cloud slot** → run `/alibaba → Re-login Cloud`, then `/login → Alibaba Model Studio Coding Plan` and paste it there. (The login validators will also catch this and offer to redirect you.)
- **DeepSeek hangs / times out** → make sure you're on the latest version of this extension; it forces DeepSeek to OpenAI-compat. If you customised plan endpoints, verify the OpenAI URL ends in `/compatible-mode/v1`.
- **Plan picker shows models that 404 at request time** → your subscription tier may not include every advertised model. The picker shows whatever upstream advertises; the API tells you "model_not_found" only when you actually call it.
- **`Error: server_error: <429> InternalError.Algo: ... [Too many requests.]`** → DashScope wrapped a rate limit inside a 200 SSE `error` event. Chat auto-retries via pi; `alibaba_tools` retries inside the tool card (`429, retrying n/3…`). If retries still fail, wait a minute (RPM windows reset ~60s) or `/alibaba → Rate limits (Cloud)`.
- **`Error: server_error: Backend buffer overflow.`** → transient DashScope inference-backend failure, not a problem with your request. Chat auto-retries via pi (the extension marks bare variants retryable); `alibaba_tools` retries inside the tool card (`server_error, retrying n/3…`). If it keeps failing, wait a minute and resend, or switch model/region.
- **`/alibaba` command doesn't appear** → `pi list` should show `pi-alibaba-models` (or whatever source you installed from) under "User packages". If absent, run `pi install pi-alibaba-models` again and restart `pi`.
- **`pi-alibaba-models is installed 2 times; 1 of those would shadow this copy`** → two copies of this plugin are configured (most often a local checkout *and* `npm:pi-alibaba-models`), and `pi` refuses to start rather than let one silently override the other. Both copies register the same `alibaba-cloud` provider and pi keeps whichever loads last, so the other's wire format, `maxTokens` and endpoint are dropped without a word — long answers get truncated mid-sentence at 1024 output tokens. Run `pi remove <the copy named in the error>` (usually `pi remove npm:pi-alibaba-models`) and restart. `pi list` shows every configured copy; the npm- and git-installed manifests live in `~/.pi/agent/npm/node_modules/` and `~/.pi/agent/git/`. Set `PI_ALIBABA_ALLOW_DUPLICATE=1` to boot anyway (e.g. while deliberately comparing two versions).
- **`alibaba_tools` missing** → its exposure is `off`. `/alibaba → Tools — Exposure → alibaba_tools → codemode` (or `direct`), then `/reload` or restart. Needs a Cloud key. With `codemode` disabled in pi, a `codemode`-exposed tool is registered but unreachable — choose `direct` instead.
- **Cloud key "disappeared" after updating pi to 1.1.0** → standalone/managed binaries no longer load `.env`/`.env.local`/`.env.development` from the launch directory. If `DASHSCOPE_API_KEY` was only in such a file, export it in your shell profile or store it with `/login → Alibaba Cloud (API Key)`.
- **`alibaba_image` says the model is not registered** → Cloud image models are fetched only with a Cloud key. Run `/login → Alibaba Cloud (API Key)` (or set `$DASHSCOPE_API_KEY`), then `/alibaba → Refresh model lists`. Plan accounts never register image models.

## Files

All paths live in pi's config directory — `~/.pi/agent` by default, or `$PI_CODING_AGENT_DIR` when that override is set (the extension resolves them via pi's `getAgentDir()`).

| Path                                                  | Purpose                            |
|-------------------------------------------------------|------------------------------------|
| `~/.pi/agent/auth.json`                               | Both provider credentials (0600)   |
| `~/.pi/agent/alibaba-config.json`                     | endpoints, domain/format, toggles, cache-warming and price settings, catalog fetch timestamps |
| `~/.pi/agent/alibaba-models.cache.json`               | versioned catalog snapshot (boot seed, written after fetches; includes the raw price rows) |
| `~/.pi/agent/alibaba-cache.jsonl`                     | prompt-cache telemetry: one line per turn and per warm, with the provider's own `cached_tokens` / `cache_creation_input_tokens` (capped at ~1.5 MB) |

Model catalogs live in **two places on purpose** (the "plan C" hybrid): pi's provider models store (`models-store.json`) is a bonus channel, while a private versioned snapshot `alibaba-models.cache.json` — written only after a real fetch — seeds provider registration at boot with **zero network** and keeps the extension independent of pi's store semantics. `alibaba-catalog.lock` is a transient fetch lock. Every JSON write is atomic (tmp + rename), so parallel instances can never observe a torn file. Uninstalling removes only our files — `models-store.json` belongs to pi and is shared with other providers, so delete our rows there only if you also want the cached catalogs gone.

## From the same author

By [Francesco Frapporti](https://fornace.it) at [Fornace](https://fornace.it).

- **[pi-bench](https://github.com/fornace/pi-bench)** — LLM benchmark toolkit for pi. Probes every available model to find the fastest and cheapest.
- **[pi-recap](https://github.com/fornace/pi-recap)** — Always-visible session recap panel for pi. Uses pi-bench data to pick the fastest summarization model.
- **[pi-banana](https://github.com/fornace/pi-banana)** — Generate and edit images inside pi using Google Nano Banana. All package banners in this ecosystem were created with pi-banana.
- **[pi-notte-theme](https://github.com/fornace/pi-notte-theme)** — Notte: a true-dark pi theme where darkness has color and text glows like terminal phosphor.
