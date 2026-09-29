# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.6.1]: https://github.com/noguerol/llama-infra/compare/v1.6.0...v1.6.1
[1.6.0]: https://github.com/noguerol/llama-infra/compare/v1.5.4...v1.6.0
