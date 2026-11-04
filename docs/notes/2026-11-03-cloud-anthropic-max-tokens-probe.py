#!/usr/bin/env python3
"""Does `max_tokens` include the chain of thought on the Anthropic path?

Companion to 2026-11-03-cloud-anthropic-max-tokens-semantics.md. The extension's
README claims "max_tokens is a total budget shared between thinking and the
answer"; the provider's own parameter reference says that is true only for some
families. This probe measures it per family instead of trusting either text.

Reads DASHSCOPE_API_KEY (or ALIBABA_CLOUD_KEY) and PI_ALIBABA_DOMAIN
(default `dashscope-intl.aliyuncs.com`).

    DASHSCOPE_API_KEY=sk-… python3 docs/notes/2026-11-03-cloud-anthropic-max-tokens-probe.py

Each case is one small request: a fixed ask whose answer is longer than the
ceiling, and a `max_tokens` small enough that the two semantics differ visibly.
`out` is the endpoint's own `output_tokens`; a value above `max_tokens` means the
CoT was billed on top, and an `out` equal to `max_tokens` with an empty answer
means the CoT ate the shared budget.
"""
import json, os, ssl, time, urllib.error, urllib.request

try:
    import certifi
    SSL = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL = ssl.create_default_context()

KEY = os.environ.get("DASHSCOPE_API_KEY") or os.environ.get("ALIBABA_CLOUD_KEY")
DOMAIN = os.environ.get("PI_ALIBABA_DOMAIN", "dashscope-intl.aliyuncs.com")
ANTHROPIC = f"https://{DOMAIN}/apps/anthropic/v1/messages"
ASK = "Write 200 words of continuous prose about prompt caching. No lists, no headings."


def post(body, timeout=240):
    req = urllib.request.Request(
        ANTHROPIC,
        data=json.dumps(body).encode(),
        headers={
            "x-api-key": KEY,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        },
    )
    started = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=SSL) as r:
            return json.loads(r.read()), round(time.time() - started, 1), None
    except urllib.error.HTTPError as e:
        return None, round(time.time() - started, 1), f"{e.code}: {e.read().decode()[:180]}"


def run(label, model, max_tokens, thinking, ask=ASK):
    body = {"model": model, "messages": [{"role": "user", "content": ask}], "max_tokens": max_tokens}
    if thinking is not None:
        body["thinking"] = thinking
    j, secs, err = post(body)
    if not j:
        print(f"  {label:<52} {secs}s {err}", flush=True)
        return
    u = j.get("usage", {})
    text = "".join(b.get("text", "") for b in j.get("content", []) if b.get("type") == "text")
    think = sum(len(b.get("thinking") or "") for b in j.get("content", []))
    print(
        f"  {label:<52} stop={str(j.get('stop_reason')):<11} out={u.get('output_tokens'):<6} "
        f"text_tokens={round(len(text) / 4):<5} thinking_chars={think}",
        flush=True,
    )


if __name__ == "__main__":
    print(f"== {DOMAIN} (Anthropic path)")
    # qwen: documented as "max_tokens = the answer's max, CoT excluded".
    run("qwen3.6-plus mt=64, thinking disabled", "qwen3.6-plus", 64, {"type": "disabled"})
    run("qwen3.6-plus mt=64, budget=1024", "qwen3.6-plus", 64, {"type": "enabled", "budget_tokens": 1024})
    # glm-5.2: documented as total WITHOUT thinking_budget, answer-only WITH it.
    run("glm-5.2 mt=64, budget=1024", "glm-5.2", 64, {"type": "enabled", "budget_tokens": 1024})
    run("glm-5.2 mt=256, no thinking field", "glm-5.2", 256, None)
    # glm-5.3: documented as total, thinking_budget ignored.
    run("glm-5.3 mt=64, budget=1024", "glm-5.3", 64, {"type": "enabled", "budget_tokens": 1024})
    # kimi-k3: documented as rejecting thinking_budget outright.
    run("kimi-k3 mt=64, budget=1024", "kimi-k3", 64, {"type": "enabled", "budget_tokens": 1024})
