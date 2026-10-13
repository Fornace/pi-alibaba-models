# TODO — deferred frontier work

Recorded 2026-10-03 alongside the 2.0.0 release (`docs/specs/2.0.0-pi-1.0-frontier.md`).
Each item states what it is, why it is deferred, and what would unblock it.

## Classifier models on the Cloud provider

**What.** pi 1.0.0 has a first-class `classifier` model type (`ProviderClassifierModelConfig`,
`ctx.modelRegistry.classify()`, `models.classify()` in codemode). DashScope's compatible-mode
chat completions can return `logprobs`, which is enough to build a real classifier implementation
(`{ choice, probabilities, confidence }`) instead of asking a chat model for JSON. Registering one
(or a small family) would let codemode scripts sort/score structured state without a chat turn.

**Why deferred.** The `logprobs` behaviour was only probed, not turned into an implementation: the
response-shape mapping from DashScope's `logprobs.content[].top_logprobs[]` to pi's every
`ClassifierAnswer` variant (`choice` / `score` / `bool`, with named `criteria`) needs a design pass,
and a classifier is only useful if the model's probabilities are meaningful for the question shapes
pi defines. Spending a release on it without that check risks a classifier that returns numbers
nobody should trust.

**What would unblock it.** One live experiment on a Cloud key: send a handful of representative
`ClassifierContext` questions (a 3-way choice, an ordered score, a bool) to a logprobs-capable
model, and confirm the top-logprob projection reproduces the same labels as a plain chat call. If it
does, implement `classifiers: { "dashscope-classify": { classify } }` on the Cloud provider with a
small `ClassifierModel` list, in the same mixed `models` array as chat and image.

## Virtual models / a router

**What.** pi's `registerVirtualModel()` lets one selectable catalog entry route each request to a
physical model by state. For this extension the natural use is a "cheap by default, escalate when
hard" router over the Alibaba catalog.

**Why deferred.** A useful router needs a signal for "this request is hard", and the cheapest such
signal is a classifier — which is the item above. Building the router first would mean inventing a
heuristic router (keyword/length based) that would be replaced the moment the classifier lands.

**What would unblock it.** A working classifier model on this provider, then a `route()` that
classifies the request (task type, difficulty) and maps it to a physical Cloud/Plan model. Until
then, `/model` plus the per-model thinking levels already cover the manual version.

## Not deferred, but worth watching

- **Video models.** Wan and HappyHorse video models are in the Alibaba catalogue; pi has no video
  model type. Blocked upstream, not here.
- **Asynchronous image endpoints.** `/text2image/image-synthesis`, the async
  `/image-generation/generation`, and the OpenAI-compatible `/compatible-mode/v1/images/generations`
  all work; the synchronous endpoint covers every curated model, so they stay unused.
- **Generation parameters through pi's own `models.generateImages()`.** The host's codemode API
  accepts a model and a context only. The dedicated `alibaba_image` tool exists precisely because of
  it; unblocked only by a host change.
- **Declaration tokens saved by `codemode` exposure.** The 2.0.0 default was decided qualitatively
  (a rarely needed sidecar should not ride in every request); the per-turn token cost of the
  `direct` declaration — description, prompt section and the four-action schema — was never counted
  against a real tokenizer. Free and offline to measure, and only worth it before anyone proposes
  flipping a default back.
- **Union members exported from the package root.** `ProviderChatModelConfig`,
  `ProviderImageModelConfig` and `ProviderClassifierModelConfig` are declared and exported inside
  `dist/core/extensions/types.d.ts`, but only the union `ProviderModelConfig` is re-exported from
  `dist/index.d.ts` and no specifier reaches the internal module — so this repo names its own
  `ChatModelConfig` / `ImageModelConfig` with `Extract`. Measured 2026-10-03 on two 1.0.0 installs,
  re-verified unchanged on 1.1.0: `docs/notes/2026-10-11-host-model-config-export-surface.md`. An
  upstream ask, not a task here; if the root ever re-exports the members (or pi-ai grows a
  config-union narrowing helper next to `assertChatModel`), each alias collapses into one import.

## Cache work from the 2026-10-07 long-session research

Option IDs are those of `docs/notes/2026-10-07-long-session-cache-provider-data-and-options.md`.
Implemented in **2.1.0** (`docs/specs/2.1.0-cache-warming-and-prices.md`): P0-A/B/C (exact price
rows, cache read/write declarations, currency), P1-D/E (refresh interval as a setting, latency rule
in `cache_warming_decision`), P1-F (cache telemetry), P2-J/L (per-model economics in Status,
Responses input guard), P3-M (extension-owned warm engine) and P3-N (`cache_control` markers on
Completions). What is left is decisions and other people's code:

### P2-K — Adaptive session-cache header: decided against "Auto"

**Decision.** The header stays a manual on/off. The arithmetic (note §4, P2-K) only favours
`disable` for a *whole burst* of ≤ 6 turns, never for the single request after a gap: modes are
exclusive per request, so a burst that starts implicit and flips to explicit pays the 125 % creation
twice. And once the warm engine keeps the explicit block alive, determinism is worth more than the
12.5 %-vs-8.3 % read spread. Revisit only for human-chat usage (a few turns per burst, long gaps),
and only with the implicit-TTL curve below in hand.

### P2-G / P2-H — Prefix stability and rewrite timing: review rules, not code

**What.** Tool definitions ride in the system message, so any change to them invalidates the whole
prefix; compaction, context edits and persona switches do the same. Together that is 38 % of measured
cold-miss spend, and no warmer can fix it.

**Why not code.** The only enforceable part is ours: the `before_agent_start` section stays static
(no timestamps, counters or volatile strings) — that is a review rule for this repo, and the codemode
exposure default (2.0.0) already removed two tool declarations from every request. The rest lives in
pi-debi (role/persona switches) and in user habits (compact right after a long idle, when the cache is
already dead, rather than mid-run).

### P2-I — Child/fork prefix alignment (upstream: pi-subagents)

**What.** The cache is prefix-scoped, not session-scoped (probe C10), so a subagent whose system
prompt + tool block + transcript prefix is byte-identical to its parent's could inherit the parent's
block instead of paying a cold create. Measured: 47 of 51 "first big request of a session" cases were
cold on Responses (~32k tokens each for the pi-subagents children of Oct 2), while the 4
Anthropic-format ones hit.

**Why here and not there.** The fork path that would keep the prefix identical belongs to
pi-subagents. The experiment to run first is in the note (§6.5): two children, one with the parent's
exact system prompt and tools, one with a modified section, compare `cached_tokens` on the first
request — now cheap to read, because 2.1.0's telemetry records creation and cached tokens per turn.

### P3-O — Server-side context (`previous_response_id`) and PTU

**What.** DashScope's Responses endpoint stores responses for 7 days and can rebuild context
server-side; PTU (预置吞吐) deployment supports context cache with discount coefficients.

**Why deferred.** pi-ai hardcodes `store: false` and rebuilds the full context every turn (compaction,
branching and context edits all assume it), so `previous_response_id` is an upstream conversation, not
an extension change. PTU is a purchasing decision — worth pricing once the telemetry shows a stable
monthly token volume.

### Watch list (needs data, not design)

- **Self-healing input caps.** The 400 text already states the cap (`Range of input length should be
  [1, N]`), so a `stream-errors`-style classifier could parse it, persist `N` next to
  `contextWindowOverrides`, and re-register the card — the measured table would then extend itself on
  first contact instead of waiting for a probe run. Needs care: one failed turn is the price, and a
  misparse would shrink a window permanently.
- **Cap drift.** `MEASURED_INPUT_CAPS` is per deployment and dated 2026-10-07. Re-running the free
  half of `docs/notes/2026-10-07-dashscope-input-caps-probe.py` (`--mode request,output`) costs
  nothing and covers 15 models in about two minutes; the Responses half costs one truncated request
  per model.
- **Per-level output caps.** `qwen3-max` declares 32 768 because thinking-on rejects 65 536, so
  thinking-off users lose half the ceiling. pi 1.0.4 added `samplingParamsByThinkingLevel`; if pi-ai
  applies `maxTokens` from it, the card could carry both.
- **Warm rewrites.** A nonzero `arrived after expiry` count in `/alibaba → Cloud — Cache Warming →
  Cache statistics` means the refresh interval is too long for that prompt size. If it shows up on
  500k+ prompts, scale the interval with the prompt estimate instead of using one constant.
- **Blind replays.** Since 2.1.3 three replays that report neither a hit ≥ 5 % of the prompt nor a
  creation end the run for that context; `/alibaba → Cache statistics` counts them separately. What
  is *not* known is why a context goes blind: `deepseek-v4.1-flash` did at 149 794 and 376 453
  tokens (27 probes, 1 h 37 m, no real request waiting) while `glm-5.3` renewed 31 of 31 at
  265 259 and the same deepseek model renewed at 6 350 in a live probe — both implicit-cache models,
  so cache mode and size are risk factors, not verdicts
  (`docs/notes/2026-10-11-cache-warm-blind-probes.md` §7). The data that would decide it: the `ctx`
  field now on every record, plus one size sweep (same context replayed at 50k / 150k / 300k) on a
  model that went blind. If blind streaks turn out to correlate with size, the floor belongs in
  `resolveContextWindow`-style per-model data rather than in a streak counter.
- **Per-context warm slots.** One warmer per pi process keeps exactly one captured request, so a
  process that serves two Cloud contexts (parent + child agent, or a sidecar call on the same
  provider) refreshes whichever spoke last and lets the other expire. `notePromptTokens(n, ctx)`
  already refuses a size from a foreign context, which removes the worst of it (a 4k child turn
  could stop a 150k context's warming). Whether the rest is worth per-context slots is now
  measurable instead of guessable: group `alibaba-cache.jsonl` by `ctx` and look for two ids alive
  in one process's time window with interleaved turns.
- **Implicit-TTL survival curve** (note §6.6): one fixed prefix, header `disable`, re-sent after
  6/10/20/40/60 min. Decides whether P2-K is worth reopening.
- **Quota-aware interval.** `/alibaba → Rate limits (Cloud)` already reads `usage_limit` per model;
  the engine could stay under a fraction of it instead of relying on 429 backoff.

## New host surfaces worth adopting (pi 1.0.1 / 1.0.2)

- **`samplingParamsByThinkingLevel`** (pi 1.0.2) is accepted on the **models.json**
  `ProviderChatModelConfig`, not on the extension-facing one exported from
  `@earendil-works/pi-coding-agent` — re-checked in 1.1.0: `core/extensions/types.d.ts` still
  lists only `samplingParams`. The runtime spreads every field of an extension model definition
  (`extensionModelFromDefinition` → `{ ...definition }`), so setting it behind a cast would reach
  pi-ai, but that is an undocumented host path rather than a supported surface. Not adopted: the
  spec never asked for sampling control, the right values are model-specific and unmeasured, and
  the field is optional (unset = current behaviour). Unblocked by a measurement pass over the
  families that accept sampling — and worth an upstream type fix first.
- **`pi.registerToolRenderer()`** (pi 1.0.1) draws calls to tools that are not registered. The
  `/alibaba image` result already renders through its custom message and the default image renderer,
  so this is polish only. Since 1.1.0 the render context also carries `durationMs` and `outputPad`,
  which is what a sidecar renderer (elapsed time, source count, retry line) would read.
- **pi 1.0.1 retries "Selected model is at capacity" provider errors** on its own. That complements
  this extension's wording-based rewrites rather than replacing them; no code change follows.

## New host surfaces worth adopting (pi 1.1.0)

Verified 2026-10-08 against the installed 1.1.0 (`tsc --noEmit` clean, 270/270 tests, one live
Cloud turn). Nothing in 1.1.0 breaks this extension; the items below are what the release adds that
we do not use yet.

- **Request-wide price tiers (`cost.tiers`).** `ModelCost` accepts
  `tiers: { inputTokensAbove, input, output, cacheRead, cacheWrite }[]`, where the highest threshold
  the request's input exceeds prices the **whole request** — the same shape as DashScope's
  `32k<输入<=128k` ranges, and accepted on extension-registered models since pi 0.80.6 (1.1.0 fixed
  tier accounting for several built-in providers, so the path is exercised). `parseRangeTokens`
  already parses every catalog range; `parseCatalogPrices` then collapses them into one flat cost
  picked at `priceTierTokens` (default 128k), so a 30k session and a 400k session are both priced at
  the 128k rate. Adopting tiers means declaring the lowest range as `cost.*` and each higher range
  as a tier, with the currency conversion and the cache-row policy applied per range. This is the
  one change that would make pi's cost figures — and therefore its warming gate, if the engine is
  ever set to `pi` — match the Bailian bill instead of estimating it. Needs a decision on how
  `priceTierTokens` survives (it becomes the tie-breaker for models with no banded ranges) and a
  Status line that says "tiered".
- **`agent_settled` carries `aborted`.** The warm engine clears `inFlight` from `agent_end` because
  an aborted turn fires no `message_end`; `aborted` would say *why* it cleared, which is worth a
  telemetry field, not a behaviour change.
- **Classifier `images`.** `ClassifierContext.images` (1.1.0, also forwarded by codemode's
  `models.classify()`) lets a classifier judge pictures. Relevant to the deferred classifier item
  above: a DashScope classifier would inherit the field for free, but only a model whose `input`
  includes `"image"` may receive it.
- **`--tools +name`/`-name`** (1.1.0) and the `*` patterns of 1.0.4: `pi -t +alibaba_tools` now
  enables the sidecar for one run without listing every default tool. The persistent switch stays
  `alibabaToolsExposure` / `alibabaImageExposure`; the CLI form is per-run and does not conflict.
- **Deliberately not adopted: syncing `RETRYABLE_MARKER` with the host's list.** pi-ai 1.1.0 also
  retries `server_busy` and `servers are currently busy`. Both marker regexes (`stream-errors.ts`,
  `sidecar.ts`) stay a *narrower* subset of the host's on purpose: they only suppress our own prefix,
  so a marker missing here costs a redundant `server_error ` prefix on an already-retryable message,
  while a marker present here but not in a 1.0.x host would silently stop that host retrying. The
  host floor is 1.0.0, so the list follows the oldest supported host, not the newest.

## New host surfaces worth adopting (pi 1.2.0)

Verified 2026-10-13 against the installed 1.2.0 (`tsc --noEmit` clean, 284/284 tests, offline boot
via `pi -ne -e <repo> --offline --list-models alibaba-cloud`). The release's one breaking change for
extensions — `before_agent_start` becoming a union on `messageType` that also fires for
`pi.sendMessage(..., { triggerTurn: true })` runs — is handled by design (the codemode-tools section
applies to both kinds; see the 2.1.4 changelog). The items below are what 1.2.0 adds that we do not
use yet.

- **A `$schema` for `alibaba-config.json`.** pi 1.2.0 publishes generated schemas for its own files
  (`https://pi.dev/schemas/*.schema.json`, referenced from `settings.json`, `models.json`, keybindings
  and themes). They do not cover our config, which we write ourselves, but the pattern is the one
  thing worth copying: a checked-in schema plus a `$schema` pointer in the default config would give
  `alibaba-config.json` the same editor validation the host now gets. Needs a decision on hosting
  (raw file from the repo) and on keeping the schema honest against `loadConfig()`'s fallback rules.
- **Tool-namespace aliases.** `describeNamespace()` and `searchTools({ namespace })` now match
  aliases, and MCP namespaces use the server name. A `dashscope` alias for `alibaba` is the only
  candidate and nothing asks for it; recorded so the idea is not rediscovered.
- **`reachesTools` on tool definitions** declares which tools a call may reach (codemode and
  `tool_search` set it; the MCP extension waits on the servers a call needs). Both Alibaba tools
  call DashScope HTTP directly and reach nothing, so there is nothing to declare — the entry exists
  to record that the field was checked, not missed.
- **No action on the rest.** Codemode rows showing elapsed/total time, `@`-tag input constraints in
  codemode declarations, per-key OpenRouter model lists, `PI_CLIPBOARD_OSC52`, the published theme
  schema, and `pi mcp list --json` reporting `resources: true` are all host-side surfaces this
  extension never touches; the removal of `@earendil-works/chord` and the experimental
  server/client stack removed no import of ours (typecheck against 1.2.0 would have flagged one).
