# Changelog

## 2.1.4

**Verified against pi 1.2.0** (2026-10-13): `tsc --noEmit` clean (tsc 6.0.3), **284/284** tests green, `pi -ne -e <repo> --offline --list-models alibaba-cloud` boots the extension and registers the provider on a pi 1.2.0 host, and a live Cloud session on 1.2.0 (`alibaba-cloud/qwen3.8-flash`, `openai-responses`, thinking `off`) exercised the provider path end to end — a cold turn wrote the cache block (`creation` 3 910 of 3 918 prompt tokens) and the next turn of the same session read it back (`cached` 3 910 of 3 938, 99.3 %, `creation` 20), both recorded in `alibaba-cache.jsonl` with `ok: true`. `devDependencies` moves to `^1.2.0`; the host floor stays pi 1.0.0. One 1.2.0 breaking change reaches this extension's surface, and it called for a decision rather than a fix:

- **`before_agent_start` now also fires for runs started by `pi.sendMessage(..., { triggerTurn: true })`, and the event is a union on `messageType`.** The handler adds one static system-prompt section naming the codemode-exposed Alibaba tools; it deliberately applies to **both** kinds of run — a custom-message run reaches the same tools, and 1.2.0 is also the release that stops such runs from stripping `before_agent_start` sections after their first tool call, so the section now survives where it used to vanish mid-run. There is no `messageType === "user"` guard: the handler reads no user-only field (`prompt`, `images`), and a pre-1.2.0 host sends no `messageType` at all, so the same code keeps working on the 1.0.0 floor. Pinned by a new factory test that drives the handler with both event shapes.
- **The other 1.2.0 concurrency change is not on our path.** The session counting as busy while a run starts (`ctx.isIdle()` false, `pi.sendMessage()` queuing into the starting run instead of failing with "Agent is already processing", `pi.sendUserMessage()` requiring `deliverAs`) matters only to extensions that message from `before_agent_start` or start runs from one. This extension's only `pi.sendMessage` is the `/alibaba image` result, sent from a command handler; `sendUserMessage` is not used at all.
- **Host internals this design leans on were re-read in the installed 1.2.0, not assumed.** pi's warmer constants are unchanged (the $0.05 expected-savings gate, the 30/60-minute horizons, the `min(0.9·ttl, ttl−10 s)` schedule, the half-margin late-timer deadline), `oauth.modifyModels` is still projected over chat models (`provider-composer.js`), `onPayload` (`before_provider_request`) still reaches only loop requests — compaction passes the bare stream function and builds its summarization options without it, while `transformHeaders` (and therefore `before_provider_headers`) still applies to every request — and the PackageManager layouts the duplicate guard mirrors are unchanged (`<agentDir>/npm` + `node_modules/<name>`, `<agentDir>/git/<host>/<path>`, `.pi/…` for project scope).
- **Deliberately not adopted from the 1.2.0 release.** `reachesTools` (both of our tools call DashScope HTTP directly and reach nothing); tool-namespace aliases (one name, `alibaba`, is all we need and `describeNamespace("alibaba")` is unaffected); the published `https://pi.dev/schemas/*.schema.json` files (they cover the host's own settings/models/keybindings/themes files, which this extension neither writes nor themes — a `$schema` for our `alibaba-config.json` would be our own work and is recorded in `docs/TODO.md`); per-key OpenRouter model lists, `PI_CLIPBOARD_OSC52`, the codemode elapsed-time rows and `@`-tag input constraints, and the `pi mcp list --json` `resources: true` shape (no MCP server is registered here).
- **Also verified:** the README's codemode example still opens with `// @options:` on the first line, which 1.2.0 now enforces with a hard error before the script runs; and 1.2.0's removal of `@earendil-works/chord` and the unreleased experimental server/client stack touches no import of this package.

## 2.1.3

**Warming stops paying for replays that renew nothing, and the statistics now say so.** Reported as «прогревы кэша иногда не работают». Measured from 4 020 records of `alibaba-cache.jsonl` (2026-10-07 → 2026-10-10), the session files of the window, and live probes against the cn-beijing workspace; the full analysis is `docs/notes/2026-10-11-cache-warm-blind-probes.md`.

- **The failure was real and it was silent.** A `deepseek-v4.1-flash` context of 376 453 tokens was replayed 27 times over 1 h 34 m (2026-10-09T18:12:39–19:46:15Z, every 216 s), each probe reporting `cached_tokens` 0–4 096 — nothing, or the first block to four of a 376k prefix — and together taking 889 s of cold prefill. No real request ever came back for the block: **10.15 M tokens re-read at full price for nothing**, and `MAX_WARM_FAILURES` never fired because nothing failed — every probe was HTTP 200.
- **A replay that proves nothing is now *blind*, and three in a row end the run.** `isBlindWarm()` = no creation tokens reported and a hit under `BLIND_HIT_FRACTION = 0.05` of the prompt; `MAX_BLIND_WARMS = 3` stops the run until the next real request, which renews the block itself. The band the threshold sits in is empty in four days of telemetry: every one of the 1 112 real hits on `qwen3.8-max-0902` (1 081, min 99.99 %) and `glm-5.3` (31, min 99.98 %) covered essentially the whole prefix, while the 29 blind `deepseek-v4.1-flash` probes reported 0–1.09 %. Replayed over the whole log the rule fires only on that one model, and there it would have cut the chain from 27 probes to 3 — 10.15 M tokens to 1.13 M.
- **The statistics called blind probes "rewrites".** `summarizeCacheLog()` counted every successful hit-less probe as a rewrite — a word that claims the probe re-created an expired block, which is only *known* when the provider reports creation tokens (DashScope reported none on any blind probe). `Cache statistics` therefore showed 27 useless probes as 27 successes, while the engine's own counters left them uncounted (`31 warms: 2 hits, 0 late, 0 failed`). Blind is now its own counter in the roll-up, on the `/alibaba → Status` line and in the Cache Warming menu, with a line explaining what it means.
- **Records are attributable to a context.** The session the report pointed at (`01a126a9`) had *no* Cloud turns at all — it switched away 46 s in — while four other pi processes wrote 755 Cloud records inside its window; separating them meant reconstructing contexts from prompt sizes and timestamps. Every turn and warm record now carries `ctx`, a sha1/8 of the cached prefix head (`contextId()`: system prompt, first two messages, tool names), which is what a provider cache keys on and what a child agent or a second session does not share.
- **A foreign context can no longer stop the warming of the one that matters.** `notePromptTokens(n, ctx)` ignores a size reported by a different context: one process can serve several (parent + child agent, a sidecar call), and a 4 096-token child turn used to drop the shared estimate under `minPromptTokens` and end the run for a 150k context.
- **Neither the replay shape nor the size explains it — both were probed, not assumed.** Live probes on 2026-10-11 sent one streaming and three warm-shaped requests per model, with a unique nonce per run: `deepseek-v4.1-flash`, `glm-5.3` and `qwen3.8-max-0902` all report `usage.input_tokens_details.cached_tokens` on the non-streaming replay (the parser was never blind), the 16-token cap makes reasoning models answer `status: "incomplete"` and still caches and renews, and a **356 560-token `deepseek-v4.1-flash` context — within 5 % of the one that went blind — renewed twice** (probes C and D, 356 352 cached, 11.6–12.6 s each, where the blind probes took 22–50 s). What is left is a transient provider-side condition, and one measurable consequence: a blind probe at 17:08:33Z was followed by a real turn that also missed, so blind replays really do leave nothing behind. That is why the fix is a streak counter and not a per-model blocklist — the same model warmed fine two hours earlier and again in the probe.
- **Full analysis:** `docs/notes/2026-10-11-cache-warm-blind-probes.md` (the pointed-at session, the four processes that actually wrote the window's records, per-model roll-ups, the probe tables, the open question, and the commands to reproduce).
- **Deliberately unchanged, with the measurements that say so.** Horizon stays 240 min (idle periods that ended with a returning turn: 16 in 5–15 min, 9 in 15–30, 2 in 30–60, 1 in 1–2 h, 4 in 2–4 h, 6 over 4 h — cutting to 60 min would abandon ~29 % of real returns, and the workspace key is not token-metered, so a probe costs quota and provider compute, not money; one did hit `HTTP 429`). `minPromptTokens` stays 20 000 (the window's other misses were 4 096–18 752-token contexts, the documented "cold start costs seconds" case). One template per process stays — per-context slots are a bigger change, and `docs/TODO.md` now records how to measure whether they are needed using the new `ctx` field.
- **Also fixed:** the host-floor error hardcoded the package version and still said `pi-alibaba-models 2.1.1` when 2.1.2 had shipped; it now reads `SELF_VERSION` from the manifest.
- **283/283** tests green (10 new: the blind rule and its boundary, the streak stop and its reset by a real request, first-block-only hits, the foreign-context size guard, `ctx` in telemetry, `contextId()` stability/separation/Completions shape), `tsc --noEmit` clean (tsc 6.0.3).

## 2.1.2

**The `qwen-image-3.0` hybrids can generate from text again.** `validateEditorReferences()` asked `isImageEditModel()`, which is true for anything that *accepts* reference images, so `qwen-image-3.0` and `qwen-image-3.0-pro` — on both curated lists, generators and editors at once — were rejected client-side on every call without `images`. The gate sits in `generateImage()`, which the `alibaba_image` tool and `/alibaba image` share, so both surfaces refused; no request was ever sent, which made a purely local validation failure look like a provider refusal while a direct API call succeeded. A hybrid is a reasonable `imageModel` default and was the reporter's, so text-to-image was unreachable through the plugin.

- **Text-only generation on the pair is verified, not assumed.** Model Studio's Qwen-Image-3.0 reference lists text-to-image and editing as both supported, and both protocols were exercised live on 2026-10-09 with `input_image_count: 0` and HTTP 200 — the native `multimodal-generation` endpoint this extension builds for (`request_id a5089971-fd6b-9266-a239-ff7dd78bbc`) and the OpenAI-compatible one. `buildImageRequest()` already emitted a valid text-only body; only the gate was wrong.
- **Two predicates where one was overloaded.** `isEditOnlyImageModel()` (editor list minus generator list) now answers "must this model edit?"; `isImageEditModel()` keeps meaning "accepts references", which is what `curatedImageInput()` needs to declare `["text", "image"]` on a hybrid's card.
- **The tool description said the opposite of the truth** — "Editors (`qwen-image-edit-*`, `qwen-image-3.0*`) need 1–3 reference images" — and that string is what a codemode script reads through `describeTool`, so the model was being told the hybrid cannot generate. It now names only the edit-only family; README says the same.
- **Regression guards, both confirmed to fail on the old predicate:** unit cases across hybrid / edit-only / generator at 0, 2 and 4 references, and a tool-level case where `alibaba_image` with `model: "qwen-image-3.0"` and no `images` reaches the registry with an empty image input list. **273/273** tests green, `tsc --noEmit` clean (tsc 6.0.3).
- **Docs.** The `pi 1.0.0` handoff note is retired: its two shipped items were already covered by the 2.0.0 spec, ADR-0001 and this changelog, while the one thing recorded nowhere — the measured host-side export surface behind the `ChatModelConfig` / `ImageModelConfig` aliases — becomes `docs/notes/2026-10-11-host-model-config-export-surface.md`, re-verified unchanged against pi 1.1.0. Its two leftovers (the never-measured token cost of a `direct` declaration, and the upstream ask to re-export the union members from the package root) move to the watch list in `docs/TODO.md`.

## 2.1.1

Re-verified against pi **1.1.0** (2026-10-08): `tsc --noEmit` clean (tsc 6.0.3), **270/270** tests green, `pi -ne -e <repo> --offline --list-models alibaba-cloud` registers the provider, and a live Cloud session on 1.1.0 (`alibaba-cloud/qwen3.8-max-0902`, `openai-responses`, thinking `high`) exercised the whole path — streaming turns, the warm engine's refreshes and the `alibaba-cache.jsonl` telemetry, with ~99 % of each prompt read from cache. No API this extension relies on changed: the 1.1.0 delta is additive (`durationMs`/`outputPad` in the tool render context, `aborted` on `agent_settled`, `+name`/`-name` in `--tools`, classifier `images`, OSC 7501 program status), and the host internals this design leans on were re-read in the installed 1.1.0 rather than assumed — pi's warmer constants (the $0.05 expected-savings gate, the 30/60-minute horizons, the `min(0.9·ttl, ttl−10 s)` schedule, the half-margin late-timer deadline), `oauth.modifyModels` still projected over chat models, `onPayload` still reaching only loop requests, and the PackageManager layouts the duplicate guard mirrors. `devDependencies` moves to `^1.1.0`; the host floor stays pi 1.0.0.

Documentation and comments only, plus the host-floor message following the package version:

- **One 1.1.0 host change reaches this plugin's auth path.** Standalone/managed pi binaries no longer load `.env`, `.env.local` or `.env.development` from the launch directory, so a `DASHSCOPE_API_KEY` that lived only in such a file stops reaching the Cloud provider. README gains the caveat under **Host versions** and a Troubleshooting row.
- **Two claims about the host were wrong and are now corrected.** `before_provider_headers` *does* fire for compaction and branch-summary requests — only `onPayload`, which emits `before_provider_request`, is loop-scoped — so the warm-engine comment says what actually happens: a summary's headers can sit in `pendingHeaders` until the next real request overwrites them, and nothing is captured without a payload event. And `prices.ts` no longer claims that "pi holds one price per model": `cost.tiers` (`ModelCostTier.inputTokensAbove`, where the highest matching threshold prices the whole request) has been accepted on extension-registered models since pi 0.80.6.
- **`docs/TODO.md`.** `samplingParamsByThinkingLevel` sits on the models.json `ProviderChatModelConfig`, not the extension-facing one (the runtime spreads every definition field, so a cast would reach pi-ai — an undocumented path, not a surface). A new section lists the 1.1.0 surfaces, headed by **request-wide price tiers**: DashScope's `32k<输入<=128k` ranges map one-to-one onto `inputTokensAbove` and `parseRangeTokens` already parses them, while `parseCatalogPrices` still collapses them into one flat cost at `priceTierTokens`, so a 30k and a 400k session are priced alike. Adopting tiers is what would make pi's cost figures — and its warming gate in `pi` mode — match the Bailian bill instead of estimating it.
- **Deliberately not changed.** The two `RETRYABLE_MARKER` regexes stay a narrower subset of pi-ai's list even though 1.1.0 also retries `server_busy` and `servers are currently busy`: a marker missing here costs one redundant `server_error ` prefix, while a marker present here but absent from a 1.0.x host would stop that host retrying at all — and the floor is 1.0.0.

## 2.1.0

**Cache warming becomes a latency mechanism, and Cloud prices become the real bill.** Built on the provider probes, pi's warmer internals and four months of local telemetry recorded in `docs/notes/2026-10-07-long-session-cache-provider-data-and-options.md`; decisions in `docs/specs/2.1.0-cache-warming-and-prices.md`. A cold 150k–220k-token prompt answers in 10–17 s from cache and 57–151 s without it, so every change below is aimed at cold starts, not at the bill.

### Cache warming owned by this extension (`extensions/cache-warm.ts`)

- **An engine of our own, on by default.** It captures each Cloud request as pi dispatches it — payload from `before_provider_request`, resolved headers (Authorization included) from `before_provider_headers` — and replays it byte-identically with a 16-token output cap and `stream: false`, which renews DashScope's 5-minute block without producing an answer. Defaults: refresh every **216 s** (the block lives 300 s and a hit renews it, so 84 s of margin), keep warming for **4 h** after the last real request, skip prompts under **20 000 tokens**. Failures stretch the interval ×2/×3/×4 and end the run after four, because a warm that cannot get through is usually a rate limit and the next real request needs that quota. A warm never overlaps a real request, timers are `unref`'d, and every failure path ends in a stopped run.
- **Why not pi's warmer:** it refreshes only when `p · missCost − warmCost ≥ $0.05`, gives up permanently when a timer fires ~5 % of the declared TTL late, and stops 30 min after the last request (60 min while streaming). In our own history that cost **10 of 146 warms — each arriving after expiry and paying a full-price rewrite (34 CNY, more than the 136 successful warms cost)**, all of them 274–328 s after the previous completion on 73k–593k-token prompts. `cache_warming_decision` can override a decision but never lengthen the caps.
- **`promptCache` is now the engine switch.** It is the only model field pi's warmer reads, so Cloud cards declare it **only** in `pi` mode (`{short: ceil(refresh / 0.9)}`, which reproduces the interval through pi's `0.9·ttl` schedule); in the default `extension` mode and in `off` they declare nothing and pi's warmer reports "cache lifetime unavailable". Two engines refreshing one block would only burn quota. Consequence: pi's global `cacheWarming` setting no longer affects Cloud models unless the engine is set to `pi`. The Plan provider keeps `{short: 300}` and pi's warmer — our replay depends on DashScope's measured TTL and the Cloud credential.
- **`pi` mode still gets the latency rule.** A `cache_warming_decision` handler turns pi's savings-gated `stop` into `warm` for prompts at or above the minimum, so a corporate key stops being told that a minute of wall time is not worth $0.05.
- **Transcript rewrites invalidate the run**: `session_before_compact`, `session_before_tree`, `session_before_switch` and `session_start` drop the captured request rather than warm a prefix that no longer exists. Compaction and branch-summary requests were never capturable in the first place — pi builds their options without `onPayload`/`transformHeaders`, the same reason pi's own warmer skips them.
- **`/alibaba → Cloud — Cache Warming`**: Engine (extension / pi / off), Refresh interval (150/216/270 s or custom, 60–270), Horizon (1 h/4 h/8 h/24 h or custom), Minimum prompt size (0/20k/100k or custom), Telemetry toggle, **Warm now** (sends one refresh and prints what the provider reported), **Cache statistics**. Config lives in `alibaba-config.json` under `cacheWarm`; out-of-range values fall back to the default instead of being clamped, so a typo cannot silently disable warming.

### Cache telemetry (`alibaba-cache.jsonl`)

- One JSON line per turn and per warm with the provider's own counters: `cached_tokens`, `cache_creation_input_tokens` and `cache_type` recovered from the raw `provider_stream_event` (`response.completed` / `message_start` / the final Completions chunk) and merged with pi's normalized usage at `message_end`. **pi cannot see creation tokens at all** — pi-ai reads `usage.input_tokens_details.cache_write_tokens`, a field DashScope never sends, while the real value sits in `usage.x_details[].prompt_tokens_details` — so every Cloud cache write used to be recorded as ordinary input. The file is capped at ~1.5 MB by trimming to its last 1200 lines, is deleted by `Reset all`, and feeds both the new statistics page and `/alibaba → Status`.
- A warm that arrives after expiry is logged as a **rewrite** rather than a hit, which is the signal that the refresh interval is too long for your prompt size.

### Prices parsed from the exact catalog rows (`extensions/prices.ts`)

- **The `/input/i` bug is gone.** It also matched `input_token_cache_read` and the last match won, so **72 of 154 Cloud models were priced from a cache row** — the default `qwen3.8-max-0902` was registered at 1 instead of 12 CNY/M input, and every pi/pi-debi cost figure and every warming decision downstream of it was wrong. Rows are now matched by exact `type`, so batch (`input_token_batch*`) and thinking rows can no longer pose as the interactive price.
- **`cacheRead`/`cacheWrite` are declared, following the wire**: explicit (session-cache header on Responses, pi-ai's `cache_control` injection on the Anthropic shape, our markers on Completions) → `input_token_cache_read` / `input_token_cache_creation_5m`; implicit → `input_token_cache` and **0**, because an implicit write is billed as ordinary input. For `qwen3.8-max-0902` that is read 1 (8.3 % of input) and write 15 (125 %); `glm-5.3`, `kimi-k3` and `deepseek-v4.x` have no explicit rows and stay implicit (read 25 %/10 %/10 %, write 0).
- **Tiers and time bands are decisions, not accidents.** 43 catalog models are priced by prompt size with no `Default` range and used to fall back to their cheapest tier (`qwen3-max` at 2.5 instead of 4 or 7); the tier containing `priceTierTokens` (default 128k) is now used, and the widest tier above it. Where a model publishes only `peak`/`offpeak` rows (`deepseek-v4.1-flash`), peak wins — under-reporting a bill is worse than over-reporting it. `/alibaba → Status` prints the chosen tier.
- **Thinking-mode rows**: a model that publishes only `thinking_*` rows is priced from them, and where both exist the thinking output price is used by default (`priceThinkingOutput`), since pi runs these reasoning models with a level (`qwen-plus` output 8, not 2).
- **Currency is explicit.** The catalog bills CNY per million while pi labels `cost.*` as dollars. `costCurrency` defaults to `cny` — the number the Bailian console bills, and what a corporate key reconciles against — and `"usd"` converts at `cnyPerUsd` (default 7.1). Status always states the unit. Note that honest prices move pi's own warming gate in both directions (for `qwen3.8-max-0902` the idle threshold lands at ~320k tokens), which is one more reason the default engine does not use it.
- Raw price rows are kept per model (module map + a new optional `prices` section in the private catalog snapshot), so a change of session-cache header, currency or tier probe re-prices every card at registration without a refetch; a snapshot without the section still works and simply keeps the stored cost.

### Explicit cache on Chat Completions (`extensions/cache-control.ts`)

- Completions has no session-cache header, so models whose catalog rows include explicit-cache prices now get up to two `cache_control: {"type": "ephemeral"}` markers injected by `before_provider_request`: one on the last system/developer message (where DashScope serializes the tool definitions) and one on the last markable message, whose 20-content-block backward window catches the previous turn's tail. Tool results are never converted to part arrays, an already-marked payload is left alone, and the injection is gated on catalog rows so families without explicit support are untouched. Verified live on `kimi-k2.6`, `glm-5.1` and `deepseek-v3.2` (`creation` then exactly the same `cached`), which turns their probabilistic implicit hits into deterministic explicit ones. Toggle: `cloudCacheControl`, `/alibaba → Status` line `Markers`.

### Declared context windows follow the endpoint, not the catalog (`extensions/model-limits.ts`)

- **The catalog's `context_window` is not what a request may contain.** Measured per model on 2026-10-07 (`docs/notes/2026-10-07-dashscope-input-caps.md`): Completions and Anthropic reject an oversized prompt with `400 Range of input length should be [1, N]`, where `N` is `reasoning_max_input_tokens` for qwen3.8-*, `max_input_tokens` for `qwen3-30b-a3b` and `MiniMax-M2.1`, and plain `context_window` for `qwen-plus`, `kimi-k2.6`, `deepseek-v3.2` and `glm-5.1` — on those four it is *larger* than both catalog fields. The Anthropic shape enforces the same numbers (verified on four models) but reports them as `{"code":"InvalidParameter"}` instead of the OpenAI envelope.
- **Responses does not reject, it silently truncates — and keeps head and tail while dropping the middle.** Marker experiment on `qwen3.5-35b-a3b`: at 80k sent the model saw head, middle and tail; at 160k and 240k it saw head and tail only, with `input_tokens` pinned at ~90 000. An over-budget Responses request therefore produces a confident answer over a transcript with a hole in it, and kills the cached prefix for every later turn.
- **The documented "~80 % of the context window" is only sometimes true.** Measured Responses caps: 800 056 (qwen3.8-flash), 792 945 (qwen3.8-max-0902), 792 907 (qwen3.7-plus/-flash, qwen3.6-flash), 754 977 (deepseek-v4.1-flash) — but **89 127 / ~90 000 for the qwen3.5 generation**, i.e. 9 % of a 1 M window, which no catalog field predicts. Cards now declare the measured cap per model and shape; unmeasured models fall back to `min(ctx, max_input, reasoning_max_input)` for the request shapes (never above a measurement in the 15-model sample) and to `0.78 × min(requestCap, ctx)` on Responses, with `^qwen3.5-` taking the flat 90 000 and `^deepseek-v4` the measured 0.755. `MEASURED_INPUT_CAPS` is dated and re-measurable with the committed probe (the request caps come free from the 400 text; a Responses cap costs one truncated request).
- `/alibaba → Status` prints the declared window **and its source** (`measured` / `derived` / `your override` / `catalog`), so an unmeasured model is visibly a guess. `Context Window — Override` still wins outright; `responsesInputGuard: false` (menu: `Cloud — Responses Input Guard: On / Off`) re-declares the full window.
- Measurements propagate through the catalog's own `equivalent_snapshot` links in both directions, so a dated snapshot inherits its alias's cap instead of a derived one (`qwen3.7-plus-2026-05-26` → 792 907, not 767 220). For the qwen3.7/3.8 generations the derived request cap is exact anyway (983 616 = `min(ctx, max_input, reasoning_max_input)`), and the derived Responses cap sits 3–4 % under the measured 792 907–800 056 — early compaction, never truncation.
- **Output caps:** `maxTokens` now folds in `reasoning_max_output_tokens`, because `qwen3-max` (and its two snapshots) answers `Range of max_tokens should be [1, 32768]` to the 65 536 its own catalog row advertises whenever thinking is on — previously a hard 400 on every turn. A card cannot express "unless the level is off", so the lower ceiling is declared.

### Cache support verified per family, and warming gated on it

- Measured on 2026-10-07 across the non-qwen line (`docs/notes/2026-10-07-dashscope-cache-families.md`):
  **explicit** caching works on `glm-5.1`, `kimi-k2.5`, `kimi-k2.6`, `kimi-k2.7-code`, `deepseek-v3.2`
  through our injected markers (`creation=N` then `cached=N`, exact), and **implicit** caching on
  `glm-4.6`, `glm-5.3`, `kimi-k3`, `deepseek-v4-pro`, `deepseek-v4.1-flash` — 128-token quanta on
  GLM/DeepSeek-4.1, 1024 on `kimi-k3` and `deepseek-v4-pro`. The session-cache header is a confirmed
  no-op without explicit rows (`glm-5.3` returns the same implicit hit with `enable` and `disable`).
  The 5-minute TTL renewed on a hit was re-measured on Kimi's explicit block, so one `refreshSeconds`
  is correct for every family and no per-family TTL table is needed. On the Anthropic shape pi-ai's
  own markers produce explicit blocks for the families that support them and are silently ignored by
  the ones that do not, which is what the price declarations already assume.
- **`MiniMax` is the exception**: no caching at ~1.9k tokens, and at ~7.6k it hit once and missed
  again 30 s later on an identical prefix — consistent with a per-replica cache. Warming there is a
  bet, not a guarantee, and the 20k default prompt floor is what keeps it from being pure waste.
- **`modelCachesPrompt()`**: the engine no longer warms a model with no cache rows in the catalog
  (`explicitCache || implicitRead > 0`), falling back to the family table when a boot was served from
  the compatible-mode listing, which carries no rows. The open-weight `qwen3-<size>b` line and unknown
  families are skipped instead of spending quota on a block that is never created.

### Status, docs and tests

- `/alibaba → Status` gains four lines: `Markers`, `Warming` (engine, interval, horizon, floor, next refresh, warm counters), `Prices` (unit, tier probe, thinking-output convention) and `Model` (the current model's cache economics and tier), plus the `Cache log` roll-up. A model switch that silently loses explicit caching is now visible.
- New config keys: `cacheWarm.{mode,refreshSeconds,horizonMinutes,minPromptTokens,telemetry}`, `cloudCacheControl`, `costCurrency`, `cnyPerUsd`, `priceTierTokens`, `priceThinkingOutput`, `responsesInputGuard`. `PI_ALIBABA_CACHE_DEBUG=1` logs every warm to stderr. `/alibaba` gains two entries: `Cloud — Cache Warming` and `Cloud — Responses Input Guard: On / Off`.
- README: new **Prompt cache & warming** section (mechanism, settings table, what a cached turn costs, keeping the prefix stable, the measured context-window table) and a rewritten caching bullet in Limitations. CONTEXT.md: vocabulary for the warm engine, warm template, cache telemetry, price tier, cost unit and cache marker.
- Tests: 270 (from 183) — price parsing against verbatim catalog rows (the `/input/i` regression, tiers, time bands, thinking rows, batch rows), cap resolution against the measured table (per shape, derived fallbacks, equivalence links, overrides, output caps), warm scheduling (interval, horizon, prompt floor, in-flight, backoff), payload/URL/usage mapping for all three wire shapes, the telemetry log and its trim, the engine end-to-end against a fake transport, marker injection, and the new `buildCloudModels` options object. Live verification recorded in the spec.

## 2.0.1

Re-verified against pi **1.0.4** (2026-10-06): `tsc --noEmit` clean (tsc 6.0.3), 183/183 tests green, and `pi -ne -e <repo> --offline --list-models alibaba-cloud` registers the provider on a dummy key. The 1.0.1–1.0.4 patch releases changed no API this extension relies on — the extension-API delta in 1.0.4 is additive (`registerToolRenderer`, `samplingParamsByThinkingLevel`, `getPromptGuidelines`). Only the host-floor error message follows the package version.

## 2.0.0

**Requires pi 1.0.0 or newer.** Adds DashScope image models and a dedicated image tool, makes tool exposure configurable (default `codemode`, a behaviour change for `alibaba_tools`), classifies stream errors by structure, and drops the pre-1.0.0 compatibility shim. See `docs/adr/0001-drop-pre-1.0.0-hosts.md` and `docs/specs/2.0.0-pi-1.0-frontier.md`.

### Breaking changes

- **Host floor is pi 1.0.0.** The hand-written `ChatModelConfig` exclusion type is replaced by the chat member of pi's model-config union (`Extract<ProviderModelConfig, { type?: "chat" }>`), and the dual-host verification ritual is gone. On a pre-1.0.0 host the config type has no `type` discriminant, so image models have nowhere to live and `exposure` does not exist — 1.5.3 is the last line for those hosts. The floor is enforced at load (`hostVersionSupported(VERSION)` throws with a clear message); `peerDependencies` stays `*` per pi's packaging guidance for host-provided modules.
- **`alibaba_tools` default exposure is now `codemode`, not `direct`.** The 1.5.x `cloudSidecarTools` boolean is replaced by `alibabaToolsExposure` / `alibabaImageExposure` with the vocabulary `codemode` (default) / `direct` / `deferred` / `off`; an explicit `cloudSidecarTools: false` migrates to `off`, and `cloudSidecarTools` itself is removed. With both tools left at the default and `codemode` disabled in pi, neither is reachable and the only Alibaba generation path is `/alibaba image <prompt>`.

### Image models (Cloud)

- DashScope's prompt-driven image families (`qwen-image-3.0-pro`, `qwen-image-3.0`, `qwen-image-max`, `qwen-image-plus`, `qwen-image`, `qwen-image-2.0`, `z-image-turbo`, `wan2.7-image-pro`, `wan2.6-t2i`, plus the `qwen-image-edit-*` editors) are registered as pi **image models** on the `alibaba-cloud` provider, in the same mixed `models` list as the chat cards (`custom-provider.md`: supplying `models` replaces every operation). They come from the Cloud Domain's native `/api/v1/models?capabilities=IG` listing — a **separate fetch** from the chat catalogue, which deliberately excludes image ids by pattern — filtered to that curated allow-list; vertical products and third-party ids are never registered. Each card declares its true input modalities (`["text"]` for generators, `["text", "image"]` for editors) and `output: ["image"]`, uses `api: "dashscope-images"`, and carries zero cost (DashScope bills per image, not per token). A new `cloudImages` section in the private catalog snapshot, plus the image rows of pi's persisted store (`ownedRows()`), keep image models registered on an offline start; the Sidecar's model picker still receives chat ids only (`chatRows()`). The Plan provider registers no image models.
- **One synchronous endpoint** covers the curated list: `POST /api/v1/services/aigc/multimodal-generation/generation`. The response's `output.choices[0].message.content[]` carries `{ type: "image", image: <url> }`; the URL expires in 24 hours, so the implementation downloads the bytes and returns image blocks. Token usage is mapped when the model reports it and left unset otherwise.

### `alibaba_image` tool and `/alibaba image`

- **`alibaba_image`** takes `model`, `task` (prompt), `images` (0–3 local paths or `data:` URLs to edit), `size`, `n`, `seed`, `negative_prompt`, `watermark`, `prompt_extend`, `prompt_extend_mode`, `enable_thinking`, and `save`. It calls the model registry with the remaining parameters in `options.metadata` (the host forwards them unchanged), and returns the image blocks **twice**: `content` so a direct caller and the TUI see the image, and a declared `outputSchema`/`structuredContent` (`{ images, model, size?, usage? }`) because a codemode script receives only structured content from a nested call. A provider failure becomes an `isError` result with the structured detail, never an empty success. `save` is the only file write; omitted means nothing is written. Annotations: `readOnlyHint: false`, `openWorldHint: true`, `idempotentHint: false`, `destructiveHint: true` (`save` can overwrite).
- **`/alibaba image <prompt> [flags]`** is the no-codemode path (prompt plus the same parameters) and works with a Cloud key and `codemode` off. It reports elapsed seconds while the model works (6–57 s measured) and emits the result as a custom message carrying image content.

### Tool exposure

- Both tools default to `codemode` exposure and share one namespace `alibaba` with longer `instructions` a script reads through `describeNamespace("alibaba")`. The Sidecar's result gains a declared `outputSchema` and matching `structuredContent` (`{ action, result, sources, calls, retries }`). A `before_agent_start` section — present only while at least one tool is codemode-exposed — tells the model which tools scripts can call and to prefer `qwen-image-*`. The recommended image family carries a `(recommended)` marker in its display name.

### Stream-error classification

- A `provider_stream_event` handler records the raw parsed event per provider/model and classifies it by structure (HTTP 429, throttling/rate-limit phrasings, 5xx, `Backend buffer overflow`) rather than by the finished message's wording; it is notification-only, so `message_end` still enters pi through the finalized assistant message. The wording-based matchers stay as the fallback for turns where no raw event was seen, and an `InternalError.Algo.InvalidParameter` is never classed retryable.

### Configuration and state

- New config keys: `imageModel` (default image model) and `alibabaToolsExposure` / `alibabaImageExposure`; all live in `alibaba-config.json`, are written atomically, and are cleared by `/alibaba → Reset all`. `/alibaba → Status` reports the chat and image model counts, the default image model, and both exposures. `/alibaba → Tools — Exposure` sets each tool; `/alibaba → Image — Default model` sets the default image model.
- Tests: the pure image surface (catalogue parser, curated filter, card builder, request-body builder, response parser, tool mapping, command parser), the stream-error classifier, the ownership/chat/image snapshot views, and the factory boot (registration, exposure, namespace, annotations, outputSchema, the prompt section, and the image tool's metadata mapping, structured content, `save` on/off, and error results).

## 1.5.3

Runs on pi 1.0.0 — the host's model-list type became a union, and this extension reads it as chat.

- **Chat-only model config.** pi 1.0.0 turned `ProviderModelConfig` into a discriminated union (`chat | image | classifier`, `dist/core/provider-composer.d.ts`), so the chat-only fields this file reads — `compat`, `promptCache`, `maxTokens`, `reasoning`, `contextWindow` — are no longer reachable through the union: `npm run build` failed with 7 `TS2339`s (measured 2026-10-03 against pi 1.0.0 / pi-ai 1.0.0). Both providers register chat models only — DashScope serves no image or classifier operation on these endpoints and none is implemented here — so the catalog types are the chat member of that union. The narrowing is written as a distributive `extends infer` exclusion, **not** as `Extract<…, { type?: "chat" }>`: on a pre-1.0.0 host the config type has no `type` field at all and `Extract` collapses to `never` (measured against the 0.87.0 types this tree used to pin). No runtime effect: pi loads the `.ts` sources with Node's type stripping (pi 1.0.0 dropped `tsx`), which erases types.
- **pi's persisted snapshot is read chat-only.** `ModelsStoreEntry.models` is `readonly AnyModel[]` in 1.0.0 — "persisted models of every type" — so the offline re-serve in `planRefreshModels`/`cloudRefreshModels` now drops rows whose `type` is neither absent nor `"chat"` (`chatRows()`) before re-deriving cards. A non-chat row has no `contextWindow`/`maxTokens` to re-derive, and re-registering one as a chat model would put a model in the picker that cannot stream.
- **Host pin raised to `^1.0.0`** in `devDependencies`; `peerDependencies` stays `*` per pi's packaging guidance for host-provided modules.
- **Coverage for the filter.** `chatRows` is exported and pinned by three tests in `tests/model-compat.test.ts` (chat kept, type-less kept — pi's own rule and every pre-1.0.0 snapshot — image and classifier dropped, missing snapshot reads as empty). Mutation control: replacing the filter body with `(models ?? [])` turns exactly that test red.
- Measured against pi **1.0.0**: `tsc --noEmit` clean and 119/119 tests green (2026-10-03; 116 before these three tests); provider registration checked by loading under `pi -ne -e … --offline --list-models alibaba-cloud`. (Before this release the same source also ran on 0.87.0; 2.0.0 drops that host — see the 2.0.0 section.)

## 1.5.2

A second installed copy of this plugin can no longer silently shadow the first.

- **Duplicate-install guard.** Two configured copies (typically a local checkout *and* `npm:pi-alibaba-models`) both call `registerProvider("alibaba-cloud", …)`, and pi keeps whichever loads last — so the other's wire format, `maxTokens` and endpoint are replaced with no diagnostic. Observed 2026-09-25: a stale npm 1.1.1 overrode the 1.5.1 fork, `cloudApiFormat: "openai-responses"` was ignored, requests went to the Anthropic path at `maxTokens: 8192`, and pi's `max_tokens = thinking + answer` split left 1024 tokens for the answer — long replies ended mid-sentence with `stopReason: length` ("Response was truncated before completion"). The factory now scans every source pi itself loads (user/project `packages`, auto-discovered extension dirs, `-e` arguments), resolves each the way pi's `PackageManager` does (npm managed layout, git `host/path`, local relative to the agent dir or `<cwd>/.pi`), dedupes by real path, and refuses to start when another copy is present. pi reports a factory failure as a fatal startup diagnostic in every mode, so the session never begins half-broken. `PI_ALIBABA_ALLOW_DUPLICATE=1` bypasses the check. Sources are matched by `package.json` `name`, never by directory name, so renamed forks and unrelated packages are ignored; object-form entries with `autoload: false` are not counted.

## 1.5.1

Replacing the Cloud API key re-derives the endpoint instead of inheriting the previous key's.

- **Key swap → endpoint re-derived, default first.** A corporate (workspace) endpoint belongs to the key it was derived from; keeping it after a key swap turned every request into `403`. pi's `/login` API-key write fires no extension hook, so the swap is caught the first time the extension observes an unseen key (boot, `session_start`, or a catalog refresh) and the endpoint is re-derived in a fixed order: (1) the key is verified against the **default** (shared regional) endpoints first — the current region's own default first (e.g. the Beijing default `dashscope.aliyuncs.com`), then the other sites' defaults, since CN ↔ International ↔ US keys do not cross-authenticate — and the endpoint lands on whichever default accepts it; (2) only then is the verified default upgraded to the **corporate (workspace) endpoint** of the new key's own WorkspaceId.
- **One derivation per key, positive evidence only.** The binding is a key fingerprint in `alibaba-config.json` (the key itself stays in `auth.json`); the derivation runs at most once per key and costs nothing afterwards. Endpoints switch only on live probes — offline or an invalid key leaves the config untouched and retries on the next run. The stale `cloudWorkspaceId` cache is dropped so the new key cannot be parked under the old workspace, the 24h probe backoff resets for the new key, a same-workspace swap keeps the workspace's home region (Tokyo / Frankfurt don't drift to another region's suffix), and the auto-upgrade opt-out is respected (verified default only). Hong Kong and custom domains are key-independent and never touched. `Re-login Cloud` clears the binding so the replacement key is re-derived immediately. Tests cover the pure binding decision, the fingerprint, and the default-endpoint ordering (`tests/key-rebind.test.ts`).

## 1.5.0

**The default Cloud wire format is now `openai-responses`** — a deliberate MINOR bump: the API surface is unchanged and per-model fallbacks remain, but what you get out of the box changes.

- **Responses by default.** Session-cache economics (predictable multi-turn prefix hits: reads ~10% vs the implicit cache's 20–25%), agent-native features (built-in DashScope tools with source URLs, `previous_response_id`), and none of the Anthropic path's `max_tokens = thinking + answer` budget squeeze. The `supportsCloudResponses` gate keeps models without Responses support (kimi-k2.x, MiniMax-M2.5, glm-5.1/5, glm-4.5, qwen-max) on Chat Completions automatically.
- **The resolved format is pinned into `alibaba-config.json` at first boot.** An unset format used to mean `anthropic-messages`; silently flipping wire protocols under existing installs is exactly what tickets are made of. If you explicitly chose a format, nothing changes for you.
- **`cloudSessionCache` toggle** (`/alibaba → Cloud — Session Cache: On / Off`, default on): session-cache writes are billed at 125% of input and re-reads at ~10% — a net win for multi-turn agent sessions, a small premium for one-shot `pi -p` usage. Turn it off if your usage is one-shot-heavy.
- **Status shows what the format hides**: `Format: openai-responses (N model(s) fall back to Chat Completions)` plus the session-cache state.
- The default lives in one place now (`DEFAULT_CLOUD_FORMAT`); the format picker recommends Responses. Plan stays on its Anthropic/OpenAI-compatible endpoints as before.

## 1.4.7

The "plan C" hybrid for model catalogs: independence from pi's store semantics.

- **Private, versioned catalog snapshot.** `alibaba-models.cache.json` (`{v: 2, plan?, cloud?}`) is written only after a real fetch and seeds provider registration at boot with **zero network** — `pi --list-models` and `enabledModels` validation see real ids immediately. It is a seed, never proof of freshness: the shared 10-minute timestamp remains the only freshness signal and the lockfile the only writer serializer. Anything but v2 is ignored in code (the 1.4.5 "old cache rows pose as catalog data" lesson, now enforced by `parseCatalogCache`).
- **pi's models store is a bonus channel, not a dependency.** `refreshModels` still serves and publishes there, but a pi contract change can no longer leave us without models — the1.4.6 investigation showed the legacy `ProviderConfig` form does not persist returns at all.
- **All JSON writes are atomic** (tmp + rename): config, auth and caches — one torn write can no longer break 30 pi instances sharing the agent dir.
- **Missing bundle → force-refresh at startup.** When the private snapshot is absent (first run, fresh agent dir, right after `Reset all`), the extension force-fetches before registering providers instead of booting an empty catalog and waiting for `session_start`; the lockfile keeps a fleet from all fetching at once. When the bonus store is empty while a catalog is held, `refreshModels` catches it up with one publish.

## 1.4.6

Caching and cache warming move onto pi 0.86+ built-ins.

- **Model catalogs use pi's models store instead of private cache files.** Both providers expose `refreshModels(context)`: the stored snapshot is served during pi's cache-only startup phase (verified on pi 0.87.1 — pi calls it with `allowNetwork=false`), and a fresh catalog is **published** to `models-store.json` exactly once per real fetch (measured: the legacy `ProviderConfig` form does not persist returns on its own, so the extension calls `context.publish({persist})` itself — restores never write the store). The 4h-TTL JSON caches, `isCacheFresh` and the `rehydrate*` loaders are gone; a failed fetch keeps the previous list, and with no credential nothing is served at all, so "Reset all" leaves no ghosts behind. Card capabilities are now derived in one place (`deriveCard`) and therefore re-derived even for a store snapshot — extension updates and context-window overrides apply without waiting for a network fetch. `/alibaba → Refresh model lists` goes through `ctx.modelRegistry.refresh({force: true})`; legacy cache files are deleted on sight.
- **Prompt-cache warming (pi `cacheWarming`).** Caching-capable families declare `promptCache: {short: 300}` — the conservative end of DashScope's documented 5-minute ephemeral window (renewed on hit; no `long` tier is published) — which makes them eligible for pi's idle/streaming prompt-cache warming. The open-weight `qwen3-<size>b` line has no documented caching and is never warmed.
- **DashScope session cache on Cloud Responses.** Requests carry `x-dashscope-session-cache: enable`, giving predictable multi-turn prefix hits server-side (reads ~10% vs the implicit cache's 20–25%, writes 125%, 5-min window renewed on hit; the client still sends the full history). Documented for the Responses endpoint only — models re-routed to Completions stay unmarked.
- **Many pi instances, one agent dir.** Catalog fetches coordinate on an `alibaba-catalog.lock` lockfile (atomic `wx` creation, 60s stale-lock steal): one fetcher at a time, the others skip and get pi's stored snapshot — so parallel instances neither hammer the endpoint nor race on writing `models-store.json`. A shared 10-minute freshness timestamp in `alibaba-config.json` collapses the herd to about one fetch (and one store write) per window; `/alibaba → Refresh model lists` forces as before. The login seed no longer shadows a stored snapshot in the cache-only phase. Measured on a warm start: 153 models restored from the store with zero store writes.

## 1.4.5

- **`max_tokens` resolves in one place, and a guess can no longer pose as a catalog row.** Plan and Cloud share `resolveMaxTokens()`: the catalog's own `max_output_tokens` is authoritative (clamped at 131072) wherever a real row exists, `0` means "no catalog row" and takes the conservative fallback (32768; 8192 for non-reasoning ids and the open-weight `qwen3-<size>b` line, measured at 8192). Until now the producers wrote id-based OpenAI guesses into the very field the Anthropic path then trusted (`glm-5.1` → 128000, `kimi-k3` → 1048576 → 131072 clamp), so `Range of max_tokens should be [1, N]` could recur — and the twin Plan/Cloud builders had already drifted (Plan silently dropped the caller's ceiling). Cloud caches move to `alibaba-cloud-models.cache.v2.json`, so pre-upgrade rows cannot keep masquerading as catalog data until the 4h TTL.
- **Per-family thinking maps follow each family's *distinct* efforts.** DeepSeek splits: `deepseek-v4-pro/flash` keeps `high`/`max` only, `deepseek-v4.1-*` gains `low` and an `off` (`none`) — the 1.4.4 map ignored the split. `glm-5.1`/`glm-5` stop advertising `max` (they reject it) instead of falling through to the universal map. Where the docs publish a coercion (deepseek-v4 low/medium → high, xhigh → max; glm-5.3 medium → high, xhigh → max), the coerced level is hidden and pi's own `clampThinkingLevel` lands on exactly that documented value.
- **Responses effort maps are derived from each family's Completions map** (the docs state Responses accepts the same subset per family), with `off` as the literal effort `none`. Four hand-kept Responses maps are gone and the disagreement the review flagged disappears: `qwen3.7-max` no longer sends `max` on Responses where Completions says it is rejected. Two measured-narrower families keep explicit overrides — qwen3.5–3.7 cap at `medium`, `qwen-plus`/`flash` accept only `none`.
- **Reasoning detection ignores the catalog `Reasoning` tag** (it flagged `qwen-turbo` and missed `qwen3-30b-a3b`; OR-ing it back in reintroduced both bugs), and the `-character` exclusion now covers every family's roleplay variants. `qwen3-coder`/`qwen3-next` count as reasoning: the old id heuristic missed them even though the maps already knew them.
- **Corrections to the 1.4.4 notes.** (a) The failure example was wrong: `qwen-plus`, `qwen-turbo` and `qwen3-30b-a3b` took the 8192 branch in 1.4.3 and sat at or below their own ceilings — the real failure mode is a reasoning-flagged id whose ceiling is below the 32768 guess (`glm-5` = 16384 rejects it with `Range of max_tokens should be [1, 16384]`; the open-weight `qwen3-30b-a3b` = 8192 would have too, once the broader detection flagged it). (b) `thinking: {type: "disabled"}` is serialized pi-side: what the map controls is `off` being **non-null** — `thinkingLevelMap.off !== null` gates the Anthropic serialization, and on Completions pi sends `enable_thinking: false` without ever using the map's `off` value.
- **Simplification, with more of pi's built-ins doing the work.** Four regex ladders over the model id (Completions maps, Responses maps, Responses capability, reasoning) collapse into one capability table (`capsFor`) with one row per family; eleven hand-written 7-key level maps collapse into a `levels()` constructor plus one map per distinct shape (the four byte-identical copies are gone); both builders share `resolveMaxTokens()`/`mergeCompat()`. Level hiding and clamping are delegated to pi (`getSupportedThinkingLevels`/`clampThinkingLevel`) instead of duplicated coercion entries. Known gap, now documented: MiniMax switches thinking through `thinking.type: "adaptive" | "disabled"`, which pi's OpenAI paths never emit, so `--thinking off` stays hidden (`off: null`) on those ids. devDependency pinned to pi `^0.87.0` (the release is built and tested against it).

## 1.4.4

- **Correct per-model `max_tokens` on the Anthropic path.** The extension used to send a flat id-based guess (32768 for reasoning models, 8192 otherwise). DashScope enforces a *per-model* ceiling and rejects anything larger with `Range of max_tokens should be [1, N]`, so prompts failed outright on models below the guess — `qwen-plus`, `qwen-turbo` (16384), `qwen3-30b-a3b` (8192). The catalog's own `max_output_tokens` is now authoritative, clamped at 131072; models with no catalog row keep the conservative fallback.
- **Thinking can be switched off on the Anthropic path again.** `thinkingLevelMap.off` was `null`, and pi *clamps an unsupported level upward* — so `--thinking off` silently became `low` and always paid for thinking. `off` now maps to a real value that serializes as `thinking: {type: "disabled"}`.
- **Per-family thinking levels on both OpenAI paths.** Each family accepts a different `reasoning_effort` subset and some require `enable_thinking` alongside it; the previous maps offered levels the endpoint rejects (e.g. `max` on Qwen 3.5–3.7, `none`/`minimal` on GLM-5.3, `max` on MiniMax-M2.5) and hid ones it accepts. The maps are now per-family and were verified against the live endpoint. GLM-4.5 no longer advertises `supportsReasoningEffort` (it rejects the field outright).
- **Stop advertising Responses for models that cannot serve it.** With the Cloud format set to OpenAI Responses, models such as `kimi-k2.6`, `glm-5.1`, `MiniMax-M2.5` and `qwen-max` answered `Agent capabilities are not enabled` on every request. They now stay on Chat Completions automatically; the Responses-capable set is measured per family.
- **Reasoning detection matches the real catalogs.** `qwen-plus`/`qwen-flash` and the open-weight `qwen3-<size>b` line are reasoning; `qwen-turbo` and the `-character` variants are not.

## 1.4.3

- **DashScope `Backend buffer overflow` handling:** this transient inference-backend failure arrives like the wrapped 429 — an SSE `server_error` event, usually over HTTP 200. Chat path: `message_end` prefixes a bare `Backend buffer overflow.` error with `server_error` so pi's retry classifier matches it (paths that keep the `server_error:` code were already retried). `alibaba_tools` retries it inside the tool on the same budget as 429s; the retry notice shows `server_error, retrying n/3…`.

## 1.4.2

- **DashScope 429-as-`server_error`:** rate limits that arrive as an SSE error event (`server_error: <429> InternalError.Algo: ... [Too many requests.]`) are treated as HTTP 429. On the main chat path, `message_end` prefixes the assistant `errorMessage` with `429` so modern pi auto-retries with backoff (the model never sees the failed turn). `alibaba_tools` copies that retry loop internally: the tool card shows `429, retrying n/3…`, and a recovered call returns only the sidecar result to the model.

## 1.4.1

- **Honor relocated pi config directories:** paths are now resolved through pi's `getAgentDir()` instead of hardcoding `~/.pi/agent`. Under a `PI_CODING_AGENT_DIR` override (e.g. Nix/Guix setups) the extension previously missed `/login` credentials entirely, wrote config/caches to the wrong place, and `/alibaba → Reset all` scrubbed a phantom `settings.json` while leaving the real one pointing at a removed provider.
- Regression tests boot the extension in a child process under a `PI_CODING_AGENT_DIR` override (credential read + Reset-all scrub).

## 1.4.0

- **Workspace-domain auto-upgrade (Cloud):** on boot and `session_start`, when the Cloud endpoint is a shared regional domain (`dashscope.aliyuncs.com`, `dashscope-intl.aliyuncs.com`, `dashscope-us.aliyuncs.com`), the extension discovers the key's WorkspaceId from `GET /api/v1/models/limits` (returned even on shared domains, although the docs call the ID console-only), probes `{WorkspaceId}.{region}.maas.aliyuncs.com`, and switches the Cloud domain **only if the probe succeeds**. Failed probes change nothing and back off for 24h; Hong Kong, custom, and workspace domains are never touched. Explicitly picking a shared domain in `Cloud — Change Domain` opts out; the new `/alibaba → Cloud — Auto workspace domain` menu detects on demand and toggles the behavior; the discovered ID pre-fills the manual workspace-domain prompt; `Status` shows the new `Auto-WS` state. `Detect & upgrade now` also recovers a swapped key: it verifies the current key against the configured workspace domain and, when rejected (key from another site), rediscovers the workspace across all shared domains and switches — or, as a last resort, demotes to a shared domain that positively accepts the key (auto-upgrade then opts out so it cannot flip back). Boot never demotes: fallback requires an explicit menu action.

## 1.3.1

- Sidecar SSE parser splits frames on LF or CRLF blank lines, so CRLF streams no longer glue events and drop JSON.
- An already-aborted input `AbortSignal` cancels `postSidecar` immediately instead of waiting out the timeout.
- README Cloud auth matches the API-key provider (`$DASHSCOPE_API_KEY` / `{ type: "api_key", key }`), not the old OAuth-shaped registration.

## 1.3.0

- **Leaner `alibaba_tools` prompt:** removes repeated guidance while making the cost and latency trade-offs explicit. Quick current-web lookups use `search`; page extraction and multi-source synthesis can go directly to the slower, costlier `research` action.
- **Clearer tool boundaries:** the model is told to skip the sidecar for local/repository work and when equivalent results are already available from another tool.
- **Simpler calls:** `action` is now optional and defaults to `search`; the legacy Completions-only `strategy` is explicitly marked as normally unnecessary.

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
