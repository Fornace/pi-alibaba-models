# Is `max_tokens` shared with the chain of thought? Measured per family (2026-11-03)

Question: the README says `max_tokens` on the Anthropic path is a **total** budget shared by
thinking and the answer — the reason a card had to grow past 8192 in 2.0.0, because pi's high
thinking budget (16384) left `8192 − 7168 = 1024` tokens for the answer. The provider's own
parameter reference says something narrower:

> `max_tokens` … **deepseek-v4.1-flash, deepseek-v4-pro, deepseek-v4-pro-0813, deepseek-v4-flash-0731:** the max
> tokens of the answer **and the chain of thought together** … **glm-5.3:** the same, and glm-5.3 **ignores**
> `thinking_budget` … **glm-5.2:** total *when `thinking_budget` is not passed*; when it is, `max_tokens` caps
> **only the answer** … **all other models:** the max tokens of the answer (**chain of thought excluded**).

Source: `help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions` (`max_tokens`).

Answer: **both texts are half right.** Measured on `dashscope-intl.aliyuncs.com` and on the Coding
Plan host, `max_tokens` caps **the answer only** for Qwen, GLM-5/5.1, Kimi and MiniMax — thinking is
billed on top — and is a **total** budget for `glm-5.3` and for a `glm-5.2` call with no
`thinking_budget`. `output_tokens` includes the CoT in both cases.

Method: one small request per case, `max_tokens` chosen so the two semantics differ visibly, and the
endpoint's own `output_tokens` read back. `out > max_tokens` proves the CoT was added on top; `out`
equal to `max_tokens` with an empty answer proves the CoT consumed the shared budget.
[`-probe.py`](2026-11-03-cloud-anthropic-max-tokens-probe.py), no fixtures, ~6 requests.

## Anthropic path, `dashscope-intl.aliyuncs.com`

| case | `max_tokens` | thinking | `out` | answer | verdict |
|---|---|---|---|---|---|
| `qwen3.6-plus` | 64 | `disabled` | **64** | full, `stop=max_tokens` | answer-only, hard cap |
| `qwen3.6-plus` | 64 | `budget_tokens: 1024` | **1093** | 64 + 1029 thinking | CoT billed **on top** |
| `qwen3.6-plus` | 8192 | `budget_tokens: 7168` | 7208 | full, `end_turn` | no squeeze at pi's high |
| `glm-5.2` | 64 | `budget_tokens: 1024` | **1087** | full | answer-only **with** a budget |
| `glm-5.2` | 256 | *none* | **256** | **~2 tokens** | **total** without a budget — the old failure mode |
| `glm-5.3` | 64 | `budget_tokens: 1024` | **64** | ~1 token | **total**, budget ignored (as documented) |
| `kimi-k3` | 64 | `budget_tokens: 1024` | — | — | `400 … Parameter thinking_budget is not supported` |

The same three probes on the Coding Plan host (`coding.dashscope.aliyuncs.com/apps/anthropic`,
2026-11-03) gave the same numbers for `qwen3.6-plus`: 64 / 1093 / 7404. So the semantics is a
property of the family, not of the host.

## What this means for `maxTokens`

The 2.0.0 failure — an answer cut at 1024 tokens — needs **both** halves: a **total-budget family**
*and* a card below ~17408. Today's cards come from the catalog, so:

| family | `max_tokens` semantics | smallest card we register | worst answer at `high` |
|---|---|---|---|
| qwen3.x / qwen-plus / qwen-max | answer-only | 8192 (`qwen-max`) | 8192 |
| glm-5, glm-5.1 | answer-only | 16384 (`glm-5`) | 16384 |
| glm-5.2 | answer-only (pi always sends a budget) | 131072 | 114688 |
| glm-5.3 | **total** | 131072 | 114688 |
| deepseek-v4* | **total** | 131072 | 114688 |
| kimi-k2.x | answer-only (no thinking at all) | 16384 | 16384 |
| kimi-k3 | **total**, rejects `thinking_budget` → registered non-reasoning | 131072 | 131072 |

Every total-budget family carries a ≥131072 card, so the 1024 floor is unreachable by
construction — the catalog fix of 2.1.x closed the rake for the families where it can bite. The
exposure that remains is a **future** total-budget family with a small catalog row, and the
`resolveMaxTokens` fallback (32768 reasoning / 8192 non-reasoning) applied to one: 32768 → answer
16384 is safe, 8192 → answer 1024 is not.

## Reproduced with the extension itself

Isolated agent dir, Cloud key on `dashscope-intl.aliyuncs.com` (the extension derived the workspace
domain `ws-xz8ag67sw0796p9q.ap-southeast-1.maas.aliyuncs.com` from the key), `--mode json`:

| model | format | api | `out` | `cacheRead` |
|---|---|---|---|---|
| `qwen3.6-plus:high` | Responses (default) | `openai-responses` | 382 | 1588 |
| `qwen3.6-plus:high` | Anthropic | `anthropic-messages` | 382 | 1588 |
| `glm-5.3:high` | Anthropic | `anthropic-messages` | 35 | 1280 |
| `kimi-k3:high` | Anthropic | `anthropic-messages` | 49 | 0 |
| `qwen-plus:high` | Anthropic | `anthropic-messages` | 249 | 0 |
| `deepseek-v4-pro:high` | Anthropic → forced Completions | `openai-completions` | 30 | 0 |

`kimi-k3` answers on the Anthropic path **only** because the card is registered as non-reasoning:
any request carrying `thinking_budget` is rejected outright, so the family row
`[/^kimi/i, { reasoning: false }]` is load-bearing here, not conservative. `deepseek-v4-pro` still
lands on Completions, as designed.

## What to change in the docs

`README.md` §"Output budget vs. thinking budget" and the comment above `resolveMaxTokens` state the
shared-budget rule as universal. It holds for `glm-5.3` and `deepseek-v4*` only; for Qwen the answer
gets the whole card and the CoT is charged on top, which means a small card costs **less** than that
paragraph claims. The card policy itself (catalog `max_output_tokens`, `reasoning_max_output_tokens`
folded, clamp 131072) does not need to change — it is conservative under both semantics.
