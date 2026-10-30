# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
