# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Compaction failed with a context-overflow 400: `Compaction failed: Turn prefix summarization failed: … requested 215045 output tokens and your prompt contains at least 47100 input tokens … please reduce …`.** Two independent mistakes on the summarization path, both client-side (the server still announced its 262144-token window):
  - *The checkpoint was allowed to grow into the whole window.* `clampMaxTokensToFit` sized a summarization request to `contextWindow − estimate − reserve` with no ceiling, so pi's request for a ~42800-token transcript became **215045** output tokens, leaving 47100 for a prompt the estimator had under-counted — one token more and the request is rejected. `summarizationOutputCeiling()` now bounds a checkpoint at `max(generation policy, estimated transcript)`: a summary is a distillation of the transcript it summarizes, so asking for more output tokens than the transcript itself is never useful. The 2026-11 incident shape now asks for ~42817 instead of 215045 and keeps half the window unused; normal turns and the generation-policy cap are unchanged.
  - *The overflow retry treated a lower bound as an exact count.* vLLM reports `your prompt contains at least N input tokens`, but `overflowRetryMaxTokens()` fitted the retry to `contextWindow − N − 4096` as if the prompt were exactly N tokens, so a retry could overflow again and the single attempt was already spent. The report now carries `lowerBound`, and a lower-bound retry keeps `OVERFLOW_LOWER_BOUND_SHARE` (25%) of the remaining room free; retries are a bounded loop (`OVERFLOW_MAX_RETRIES`, 2) where every attempt re-reads the fresh report and grows its flat reserve, so the request converges on a size that fits. A prompt that already exceeds the window by itself is no longer retried (asking for less output cannot fix it — the error surfaces immediately instead of spending a request with `max_tokens=1`).
- **Compaction could never finish on a local model: `Summarization failed: generation hit the token cap and the summary is incomplete`.** pi sizes a compaction checkpoint with `model.maxTokens`, and for a server that does not announce its own limit that is llama-infra's generation policy (`min(contextWindow, settings.maxOutputTokens)`, 32768). pi's cumulative summary grows on every compaction (it preserves all previous information), so once it needed more than 32768 output tokens the response stopped on `length`, pi rejected the partial checkpoint and the session was stuck. Measured on a real session with a 98304-token window: summaries of 12510 → 22044 → 29800 → 31557 → 32396 output tokens, then the failure. `clampMaxTokensToFit` now recognises pi's summarization request (its own summarization system prompt, no tools) and sizes `max_tokens` to the room the window actually has — `contextWindow − estimate − reserve`, which can be **above** the configured cap (59630 in that turn) — instead of truncating at the generation policy. Normal turns keep the policy ceiling untouched, and the summarization request is still clamped down when the transcript plus the reserve no longer fit, so the strict-engine 400 protection is unchanged.
- **The request clamp's flat 4096-token reserve was consumed whole by the estimator's own bias, so the turn still ended at `prompt + max_tokens = context + 1`.** Reported against a 98304-token vLLM model: the clamp lowered `max_tokens` to 22987 from a 71221-token estimate, the server counted 75318 prompt tokens (+5.8% — the estimate is a `chars/N` heuristic, not a tokenizer), and 75318 + 22987 = 98305 was rejected with `you requested 22987 output tokens and your prompt contains at least 75318 input tokens, for a total of at least 98305`. The reserve is now `max(REQUEST_SAFETY_TOKENS, 10% of the estimate)` (`requestReserveTokens()` in `src/runtime.ts`), so the headroom grows with the prompt that is being mis-measured instead of being a fixed budget one long tool-heavy prompt can eat whole; on the reported turn the clamp now sends ~19960 and the real token count fits with ~3000 tokens to spare. The `4096` retry reserve after a server-reported overflow is unchanged (that count is exact).
- **HTTP 400 context overflow on strict engines (vLLM/SGLang) right at the window ceiling.** A tool-heavy turn could send `max_tokens=32768` with a 167233-token prompt against a 200000-token model: the server rejected it with `your prompt contains at least 167233 input tokens, for a total of at least 200001 tokens` and the turn was lost. The tools-aware clamp uses a heuristic estimate (`chars/3.5` text, `chars/3` tool JSON), and no heuristic is tokenizer-exact for web-search/tool JSON — the estimate said the request fit while the real prompt was 1 token over. The provider stream now parses the prompt size out of the server's overflow body (vLLM `input tokens` / `parameter=input_tokens`, SGLang `prompt is too long`, `max_model_len`, thousands separators), and retries **once** with `max_tokens = contextWindow - reported prompt - 4096`, which fits by construction. The retry only fires when it actually shrinks `max_tokens`; unrelated 400s (budget field, bad tools, auth) are still surfaced untouched. The estimator also uses more conservative divisors to make the pre-emptive clamp fire earlier.
- **Speed footer reported impossible numbers** (e.g. `⚡ 97964 t/s`, `🔥 67.3 t/s`) that did not match trimegisto's `↑prefill ↓decode` telemetry for the same agents. Two independent bugs:
  - *Prefill* divided the full `prompt_tokens` by a tiny time-to-first-token, so a **prefix-cache hit** exploded the rate: an 80k-token prompt answered in 0.56 s was reported as `142489 t/s` (measured: 142489 vs a real 9029 t/s for the uncached call). It now uses the *uncached* prompt tokens (`usage.input + usage.cacheWrite`) and only reports a throughput when the sample is dominated by prompt processing (TTFT ≥ 1 s and ≥ 500 tokens, the same thresholds as trimegisto); otherwise the footer shows the TTFT itself (`⚡ 561ms`). Trusted samples are EMA-smoothed (α = 0.35).
  - *Generation* counted stream **chunks** as tokens and took a 1.5 s moving window over their arrival times. It now counts generated tokens over the whole request (`usage.output ÷ time since first token`), estimates live samples from streamed characters with a tokens-per-character ratio learned from real usage, requires a ≥ 400 ms span, and smooths with the same EMA.

### Tests

- `test/context-overflow.test.ts` — extended for the lower-bound recovery: the report flags vLLM's "at least" wording (and not an exact SGLang count), a lower-bound retry keeps a share of the room free, a second retry shrinks further, the retry budget is finite, a prompt already over the window is never retried, and a new end-to-end case reproduces the compaction incident (window 262144, reports "at least 47100" then "at least 60000") where the turn now completes after two retries with strictly decreasing `max_tokens` instead of surfacing the 400.
- `test/request-clamp.test.ts` — new checkpoint-ceiling cases: the 2026-11 incident shape (262144-token window, ~42800-token transcript) never asks for more output than the transcript estimate, keeps most of the window free and is idempotent on a second pass; a short transcript keeps the generation policy cap; `summarizationOutputCeiling` never drops below the policy and tolerates invalid input.
- `test/context-overflow.test.ts` — new: parses the real vLLM body (200000 ctx, 167233 prompt), computes the retry cap and asserts `reported prompt + cap + safety <= ctx`, covers SGLang phrasing/thousands separators/fallback window, verifies unrelated 400s and body-less errors are never retried, and checks the `composeOnPayload` hard ceiling applies even when the estimate says the request fits.
- `test/no-private-data.test.ts` — new guard for this public repo, wired into CI (`.github/workflows/guard.yml`, runs on every push to `main` and before publishing): fails when a tracked file carries an absolute home path, a Tailscale hostname, an API-key literal, a personal e-mail address, or any name listed in the optional **git-ignored** `sanitize-denylist.local.json` (the developer's own hostnames/model names, which therefore never enter the tree). Verified by probe: appending a private hostname, a private model name and an absolute home path to `README.md` fails the guard with all three reasons.
- `test/request-clamp.test.ts` — new summarization cases: `isSummarizationPayload` detects pi's checkpoint request (and not a normal turn, not a tool-carrying request, not a user message that merely mentions summarization), the checkpoint gets more room than the generation cap while still satisfying `est + next + reserve <= ctx`, an already-fitting checkpoint is left untouched, and an oversized transcript is still clamped down.
- `test/request-clamp.test.ts` — updated for the conservative divisors (`chars/3.5` text, `chars/3` tools) and the hard-ceiling path, and extended with the proportional reserve: the reported 98304/75318/22987 turn is reproduced and must now fit, plus a sweep asserting that a tokenizer counting 6% more than the estimate still fits across window sizes.
- `test/speed.test.ts` — new cases for the cache-hit prefill (80k tokens in 500 ms → `⚡ 500ms`, never a six-figure rate), a real prefill sample (18k tokens in 2 s → 9000 t/s), cache-write accounting (only uncached tokens count), the whole-request decode average, chunk→token calibration and tool-call fragments.
- Verified end-to-end against a live OpenAI-compatible engine: cold 80k prompt → `⚡ 9047 t/s` (independently measured 9029 t/s); the same prompt again (prefix cache) → `⚡ 560ms`; decode `🔥 157 t/s` matching the measured 157 t/s.

### Changed

- **Artwork is generated, and carries only the current name and generic labels.** `docs/banner.jpeg` and `docs/preview.jpeg` still said `pi-llamacpp-infra` and labelled a model icon with a specific model family, and being binaries they could not be reviewed or audited by the private-data guard. Both are now produced by `docs/generate-artwork.py` (Pillow, offline, deterministic, system fonts) in the same dark/neon style, with the current `llama-infra` name and generic `model-a.gguf` / `model-b.gguf` / `model-c.gguf` labels; `preview.jpeg` keeps the banner's aspect ratio so the npm card has no empty band. The diagram copy now lives in the diff, so a future change is reviewable and the guard's blind spot shrinks to "whatever the generator prints".
- `speed.ts` rewritten around per-request state (`requestStart`, `firstTokenAt`, `deltaChars`, live `usage.output`) instead of an arrival-sample window; `⚡` shows a smoothed t/s or a TTFT, `🔥` shows the whole-request average. Measurements (and the learned chars→tokens ratio) are now reset when the active model changes instead of being inherited by the next model.

## [1.8.2] - 2026-10-30

### Added

- **Self-healing for servers that reject the thinking-budget field.** Strict engines (e.g. a vLLM fork served by a custom *native worker*) answer HTTP 400 `not supported by the … native worker: thinking_token_budget` instead of ignoring the field. The provider stream now detects that error — pi-ai emits `start` before it, so the stream is buffered until the error or the first real content event — or a body-less `400 status code` while a budget field was actually sent, retries the request **once** without any budget field, and — only when the retry succeeds — persists `modelOptions[id].thinkingBudgetField: false` so neither the running session nor later scans send it again. Unrelated 4xx errors (context overflow, bad tools) are surfaced untouched and never persisted; dropping the field on such a retry is harmless because a 400 generates nothing.
- **Manual opt-out: `modelOptions[id].thinkingBudgetField: false`** (also `none` / `off` / `disabled` typed in **🧠 Thinking budgets → 🔤 Budget field**). The model is registered with `compat.thinkingTokenBudgetField: false` + `supportsThinkingTokenBudget: false`, so pi never sends a level budget, llama-infra stops renaming `thinking_budget_tokens` into the engine field, and the `before_provider_request` hook strips any leftover budget field from foreign clients.

### Changed

- `CompatProfile` accepts `thinkingTokenBudgetField: string | false` and the new `supportsThinkingTokenBudget: boolean` alias; `ModelOptions.thinkingBudgetField` is `string | false`.
- `makeCompat()`, `resolveThinkingBudgetField()` and the persisted-config loader understand the opt-out (`false`, `none`, `off`, `disabled`, `-`), and blank values still mean “auto per engine”.
- `modelOptionsKeyFor()` extracted from `modelOptionsFor()` so the self-healing opt-out is written to the key that already matches the model (raw id, compact id, display id or legacy `host:port/<id>`).

### Tests

- `test/thinking-heal.test.ts` — end-to-end against a local HTTP server: the 400 is healed by one retry, the answer streams, the opt-out reaches the model `compat`, the config file and the next turn (single request, no field); an unrelated 400 still surfaces and persists nothing.
- `test/vllm-thinking.test.ts` — opt-out parsing/resolution, `makeCompat(kind, false)`, registration, payload stripping and config persistence.

## [1.8.1] - 2026-10-14

### Changed

- Removed a hardcoded wrapper process name from the vLLM/OpenAI-compatible engine detection heuristic. Renamed launchers are still detected by their flag surface (`--served-model-name` together with `--max-model-len`, `--tensor-parallel-size`, `--gpu-memory-utilization`, `--kv-cache-dtype`, `--limit-mm-per-prompt` or `--language-model-only`).
- Cleaned setup-specific names out of the tests and documentation examples (neutral placeholders only).

No behavior change.

## [1.8.0] - 2026-10-14

### Added

- **halogen vision detection** — the extension already read `GET /health` for the context window; it now also reads `vision.enabled`, so a halogen model that serves images registers as image-capable (👁️ badge, `input: ["text", "image"]`) with no `modelOptions[id].vision` override.
- **Thinking on/off on llama.cpp-family servers (halogen included)** — `makeCompat()` now exposes `thinkingFormat: "qwen-chat-template"`, so pi sends `chat_template_kwargs: { enable_thinking, preserve_thinking }`. This is what lets halogen's default `reasoning_effort="xhigh"` be turned **off** at the `off` level (answers were otherwise all reasoning with empty content); thinking levels still send the per-level `thinking_budget_tokens`.

### Changed

- `fetchEngineHealth()` extracted from the halogen `/health` probe and now returns `{ context, vision }`; `applyHalogenHealth()` grafts the context (sticky per `host:port`) and returns the health so the vision flag reaches `buildModelMetadata()`.
- `CompatProfile` gained the `thinkingFormat` field (currently `qwen-chat-template`).

### Tests

- `test/halogen.test.ts` — `/health` parsing, sticky context, vision in metadata (and manual override), the new compat thinking format, and end-to-end halogen registration.

## [1.7.0] - 2026-09-30

### Added

- Per-model `modelOptions[id].thinkingBudgetField` to override the top-level request field that carries the thinking budget, plus a **🔤 Budget field** entry in the `🧠 Thinking budgets` config menu. Use it to force vLLM's `thinking_token_budget` on a server whose kind cannot be detected (renamed wrapper, remote SGLang/TGI).

### Fixed

- vLLM **silently ignored** llama.cpp's `thinking_budget_tokens` (the name pi puts on the payload by default), so changing the thinking level looked like a no-op. llama-infra now renames that field to the engine's field (`thinking_token_budget` on vLLM) inside the `before_provider_request` hook, and `makeCompat()` exposes the right `thinkingTokenBudgetField` per server kind — including the per-model override — so pi sends the correct field directly.
- `test/vllm.test.ts` tag regression: the fixture mixed a server host of `other-host:9000` with a model id embedding `gpu-host:8000`, so the double-tag assertions could never pass; the fixture now matches the implementation.

### Tests

- `test/vllm-thinking.test.ts`

## [1.6.3] - 2026-09-29

### Fixed

- The footer speed reading (⚡ prefill / 🔥 generation) no longer flickers — llama-infra keeps the last measured rates on the status line between requests and turns instead of resetting them and blinking through `⚡…`/`🔥…` placeholders and the idle `⏸`; the placeholders only appear before the first measurement.

### Tests

- `test/speed-footer.test.ts`

## [1.6.2] - 2026-09-29

### Fixed

- The tools-aware `max_tokens` clamp now runs on the final request body via the provider's `options.onPayload` (which includes tool schemas), not only the `before_provider_request` hook, so tool-heavy requests to strict engines (vLLM/SGLang) no longer overflow the context window (`prompt + max_tokens = max_model_len + 1`); tool-schema JSON is estimated at ~3.5 chars/token; this also covers nested `ctx.modelRegistry.streamSimple()` calls.

### Tests

- `test/request-clamp.test.ts`

## [1.6.1] - 2026-09-29

### Fixed

- pi's `estimateContextTokens()` ignores tool schemas, so tool-heavy requests could exceed the served context and strict engines (vLLM/SGLang) returned HTTP 400 right after compaction; llama-infra now recomputes `max_tokens` in a `before_provider_request` hook from a full-payload estimate (messages + tool schemas, images at a flat cost, base64 skipped) with a 4096-token reserve, lowering the requested output only when needed and never raising it above `modelOptions[id].maxTokens`.

### Tests

- `test/request-clamp.test.ts`

## [1.6.0] - 2026-09-28

### Added

- Per-model output cap via `modelOptions[id].maxTokens`. The per-model cap wins over the server-reported `max_tokens` and over `settings.maxOutputTokens`, and is clamped to the model's `contextWindow`.
- 📏 **Output caps** config menu to view and edit per-model output caps from the native config UI.

### Fixed

- vLLM vision detection now treats local engine args as ground truth: `--language-model-only` and `--limit-mm-per-prompt {"image":N}` are honored.
- OpenAI-compatible wrappers not named `vllm` are now recognized via `looksLikeOpenAiEngine`, so image-capable vLLM models register with `input: ["text", "image"]`.

### Tests

- `test/maxtokens.test.ts`
- `test/outputcaps.test.ts`
- `test/vllm-vision.test.ts`

[1.7.0]: https://github.com/noguerol/llama-infra/compare/v1.6.3...v1.7.0
[1.6.3]: https://github.com/noguerol/llama-infra/compare/v1.6.2...v1.6.3
[1.6.2]: https://github.com/noguerol/llama-infra/compare/v1.6.1...v1.6.2
[1.6.1]: https://github.com/noguerol/llama-infra/compare/v1.6.0...v1.6.1
[1.6.0]: https://github.com/noguerol/llama-infra/compare/v1.5.4...v1.6.0
