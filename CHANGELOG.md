# Changelog

## 1.1.1

- Decode catalog responses that contain gzip bytes without encoding headers.
  Both Plan and Cloud refreshes use the same bounded JSON reader.
- Limit received catalog bodies to 1 MiB and gzip output to 4 MiB; cancel
  pending reads with the existing request deadline. Already-decoded JSON is
  accepted without decompressing it again. Existing cache fallback is unchanged.

## 1.1.0

> August 2026 generation: context-window heuristics for the newest models. Live catalogs already pick up the new ids automatically; these changes make their capability cards correct.

- Kimi K3: 1M context window (was 256K via the K2.x heuristic).
- MiniMax M3: 1M context window.
- DeepSeek V4 Pro (incl. the 0813 snapshot): 1M context window.
- Open-source Qwen 3.8 ids (qwen3.8-27b, qwen3.8-2.4t-a95b): 1M context window.
- Package description refreshed for the 3.8 generation.

## 1.0.14

- Include CHANGELOG.md in the published package.
