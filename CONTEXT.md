# pi-alibaba-models

A pi extension that registers Alibaba's model services as chat providers and adds a billed
DashScope sidecar tool. This glossary fixes the vocabulary the code, README and CHANGELOG share.

## Language

### Providers

**Plan**:
The `alibaba-plan` provider: a Model Studio Coding Plan subscription reached with a pasted token.
_Avoid_: subscription, coding plan, plan mode

**Cloud**:
The `alibaba-cloud` provider: pay-per-token DashScope reached with an API key from `/login` or `$DASHSCOPE_API_KEY`.
_Avoid_: DashScope (that is the host, not the provider), API mode, payg

### Cloud addressing

**Domain**:
The single Cloud host every Cloud request goes to, chosen by the user.
_Avoid_: endpoint, region, base URL

**Shared regional domain**:
One of Alibaba's common Cloud hosts — `dashscope.aliyuncs.com`, `dashscope-intl.aliyuncs.com`,
`dashscope-us.aliyuncs.com`, or Hong Kong — which serves keys from any workspace.
_Avoid_: public domain, default endpoint

**Workspace domain**:
A Cloud host of the form `{WorkspaceId}.{region}.maas.aliyuncs.com`, tied to one business space.
_Avoid_: corporate endpoint, private domain

**Key binding**:
The recorded pairing of the current Cloud key with the domain derived for that key. A key the
extension has not seen before invalidates the binding and forces re-derivation.
_Avoid_: key fingerprint (that is the field that stores the binding), rebind

Plan keeps two base URLs — Anthropic and OpenAI — and neither is called a "domain".

### Catalogs

**Catalog snapshot**:
The private, versioned `alibaba-models.cache.json`, written only after a real fetch, that seeds
provider registration at boot with no network. A seed, never proof of freshness.
_Avoid_: cache, model cache

**Freshness stamp**:
The shared timestamp in `alibaba-config.json` that decides whether a fetch is due. A catalog
snapshot does not carry one.
_Avoid_: TTL

### Model limits

**Request cap**:
The input size Chat Completions and the Anthropic shape enforce, with a `400 Range of input length
should be [1, N]` above it. Per model, and equal to no single catalog field.
_Avoid_: context limit, max input

**Responses cap**:
Where the Responses endpoint stops accepting and starts **silently truncating** — keeping the head and
the tail of the transcript and dropping the middle. Not an error, and not the documented "~80 %" for
every model.
_Avoid_: truncation limit, 80 % rule

**Declared window**:
The `contextWindow` a card carries: the effective cap for the shape that card rides, so pi compacts
before the endpoint rejects or hollows out the transcript. The catalog's `context_window` is an input
to it, never the value itself.
_Avoid_: context window (that is the catalog's number)

**Measured / derived**:
A cap from `MEASURED_INPUT_CAPS` (probed against the endpoint, dated) versus one computed from the
catalog rows for a model nobody probed. Status prints which is which, so a guess is visible as a
guess.
_Avoid_: known/unknown, exact/approximate

### Prompt cache

**Explicit cache**:
The DashScope cache block a request opts into — the `x-dashscope-session-cache` header on Responses,
`cache_control: {"type": "ephemeral"}` markers elsewhere. Deterministic, exact-sized, 5 minutes,
renewed by a hit; reads at 8.3–10 % of input, the first write at 125 %.
_Avoid_: session cache (that is the header, not the store), prompt cache

**Implicit cache**:
The cache DashScope keeps without an opt-in: indeterminate lifetime, 128-token granularity, reads at
12.5–25 %. A separate store from the explicit one — the two never serve the same request.
_Avoid_: default cache, background cache

**Warm engine**:
`extensions/cache-warm.ts`, which keeps a Cloud block alive by replaying the last request. Owns the
schedule whenever `cacheWarm.mode` is `extension` (the default); `pi` hands it back to the host and
`off` warms nothing.
_Avoid_: cache warmer (that is pi's), keep-alive, refresher

**Warm template**:
The request the engine captured as pi dispatched it — payload plus resolved headers — and replays
verbatim. One per process, replaced by every real request, dropped when the transcript is rewritten.
_Avoid_: snapshot, payload copy, cached request

**Refresh**:
One replay, sent with a 16-token output cap. It either **hits** (the block was alive) or **rewrites**
it (the block had expired and this request re-created it) — a rewrite is not a failure, it is the
signal that the interval is too long for that prompt size.
_Avoid_: warm-up, ping, heartbeat

**Refresh interval / horizon**:
Seconds between refreshes (default 216, against a 300 s block) and how long the engine keeps going
after the last real request (default 240 min). The interval is ours to choose; the block's lifetime
is the provider's.
_Avoid_: TTL (that is the 5-minute block), period, window

**Cache telemetry**:
The `alibaba-cache.jsonl` records — one line per turn and per warm, carrying the provider's own
`cached_tokens` / `cache_creation_input_tokens`, which pi never sees.
_Avoid_: warm log, cache stats

**Price tier**:
The size band a tiered model is priced in, chosen by `priceTierTokens` (default 128k). pi holds one
price per model while DashScope bills per request size, so this is an estimate by construction.
_Avoid_: range, band, bracket

**Cost unit**:
What the declared `cost.*` numbers mean: `cny` (the catalog's own unit, which the Bailian console
bills) or `usd` (converted at `cnyPerUsd`). pi labels them dollars either way, so Status states the
unit.
_Avoid_: currency (ambiguous with the conversion rate)

**Cache marker**:
A `cache_control: {"type": "ephemeral"}` part this extension injects on the Chat Completions shape,
which has no session-cache header. Two per request at most: the system message and the last markable
message.
_Avoid_: breakpoint, cache point

### Sidecar

**Sidecar**:
A DashScope request this extension makes on its own, outside pi's chat stream, on behalf of
`alibaba_tools`. Its wire shape is independent of the Cloud format.
_Avoid_: built-in tools, DashScope tools, plugin tools

**Sidecar action**:
What a sidecar call does: `search`, `research`, `code`, or `image`.
_Avoid_: mode, operation

**Sidecar transport**:
The DashScope API shape a sidecar call uses: `responses` or `completions`.
_Avoid_: format (that word belongs to the Cloud chat API)

**Cloud format**:
The chat wire format of the Cloud provider: `openai-responses`, `anthropic-messages`, or
`openai-completions`.
_Avoid_: transport, protocol, API mode

### Images

**Image model**:
A `type: "image"` model registered on the Cloud provider and served by the synchronous
`/api/v1/services/aigc/multimodal-generation/generation` endpoint. Curated to prompt-driven
generators and editors; vertical products and third-party ids are never registered.
_Avoid_: vision model (that is a chat model that accepts image input)

**Generator / editor**:
A generator takes text only (`qwen-image-plus`, `z-image-turbo`, …); an editor additionally takes
1–3 reference images (`qwen-image-edit-*`, and the `qwen-image-3.0` / `qwen-image-3.0-pro` pair).
The distinction is the model's `input` modalities.
_Avoid_: t2i model, i2i model

**Recommended family**:
The `qwen-image-*` ids, marked `(recommended)` in their display name and preferred by the
system-prompt section. `z-image-*` and `wan*-image` are registered but not preferred.
_Avoid_: default family

### Tools

**Exposure**:
How a tool reaches the model: `codemode` (default; callable from scripts, not declared every
turn), `direct`, `deferred` (tool search), or `off` (not registered). Both Alibaba tools share the
`alibaba` namespace.
_Avoid_: visibility, mode

**Prompt section**:
The one `before_agent_start` section, present only while an Alibaba tool is codemode-exposed, that
tells the model the tools are callable from scripts and to prefer `qwen-image-*`. Since pi 1.2.0 the
handler serves both event kinds of the `messageType` union — user prompts and custom-message runs
started with `triggerTurn` — because both reach the same tools.
_Avoid_: prompt snippet (that is a per-tool declaration rendered only while a tool is active)

### Host

**Host floor**:
The oldest pi version this package supports.
_Avoid_: minimum version, peer version
