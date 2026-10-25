# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **gufo server support** ([gufo-org](https://github.com/gufo-org), a llama.cpp fork): detected by `owned_by: "gufo"` in `GET /v1/models` and registered as a new `gufo` kind. The context window comes from `context_length` (gufo's `/props` is a placeholder: **400** without `?model=`, `{template:"",model_info:{}}` with it), vision from `architecture.input_modalities`, and the speed footer reads gufo's `llamacpp:`-namespace metrics. gufo keeps llama.cpp's thinking contract, so models register with the `qwen-chat-template` thinking format and `thinking_budget_tokens`; `chat_template_kwargs.enable_thinking:false`, `reasoning_effort:"none"` and `thinking:{type:"disabled"}` were all verified to stop reasoning on a live endpoint (per-token budgets are accepted but not enforced by that build). The LM Studio catalog probes are skipped for gufo, and GGUF KV-cache badges stay hidden because gufo cannot report them. gufo publishes no max output length, so `maxTokens` remains the client cap (`min(context_length, settings.maxOutputTokens)`) and any future `max_tokens` on `/v1/models` wins automatically. Speculative decoding is read from `GET /slots` (`speculative: true` → the 🚀 drafter badge), because that is the only route that reports it: the `/props` placeholder cannot express it, gufo's `--speculative mtp --mtp-model` flags are unknown to the llama.cpp arg parser, and a containerized gufo is invisible to the local process scan. Prompt warmup stays enabled: gufo honours `cache_prompt` (`usage.prompt_tokens_details.cached_tokens` 62 on a repeat request vs 0 when disabled or omitted). Every gufo claim here is behavioural rather than status-code based, since gufo answers 200 to unknown request fields — including that per-token thinking budgets are ignored in both `thinking_budget_tokens` and gufo's own `reasoning_budget_tokens` spelling, so the budget field is kept for forward-compatibility only. `🎯` spec-accept renders from `llamacpp:spec_decode_*` (70.8% observed); `♻️` does not, because gufo exports no `prefix_cache_hits/queries_total`. Covered by `test/gufo.test.ts`.

- **`/llama-infra use <model>` — activate a discovered model from the command.** Discovery only ever registered models; switching was left entirely to pi's `/model` picker, so after starting a different model the session stayed on the previous id until you found it by hand. `use` resolves a fragment of the registered id, the display name or the raw served id (case- and separator-insensitive), rescans first when nothing matches, and activates through `pi.setModel()` with the model taken from `ctx.modelRegistry` — the same path `/model` uses, so the footer, the picker and the session log agree. Argument completion offers discovered ids as you type. Nothing is guessed: an ambiguous fragment lists its candidates and asks, an unknown one lists the closest ids.
- **The session follows a model swap.** If the model in use disappears from a server during a discovery pass and exactly one model replaced it on that endpoint, llama-infra switches the session onto the replacement and announces it (`🦙 using <id> → served as <raw id>`); with several candidates it names the endpoint and tells you to run `/llama-infra use`, and it never touches a selection belonging to another provider. Previously pi kept the vanished id, `shared.serverModelIds` no longer mapped it, and every request died with the server's own `404 model_not_found` naming an id you never typed.
- **`settings.rescanIntervalMs` (default `30000`, `0` = off)** — a background re-scan of every enabled endpoint. The poller only watches endpoints that are loading or failing, so swapping a model on a server that never went down was invisible until a manual scan or a new session; the served id is what changes, not the endpoint state. Discovery is idempotent (one cheap `GET /v1/models` per tick, nothing re-registered unless the signature changed), and the tick is skipped while the poll loop is busy. Configurable from `/llama-infra config` → ⚙️ Settings → **Background rescan**.
- **`/llama-infra list` marks the model this session is talking to** (`← in use`), so a swap that changed the server but not the selection is visible instead of implicit.
- Covered by `test/activate.test.ts` (a fake gufo endpoint plus a stubbed `ExtensionAPI`: discovery → swap → adoption, `use` activation, stale-id reporting, background rescan) and `test/model-switch.test.ts` (resolution, ambiguity, endpoint-scoped candidates). `test/naming.test.ts` pins the name-cleaning rules.

### Changed

- **An id this extension issued is never sent to a server it cannot map.** `before_provider_request` now recovers the raw served id when only the registered spelling changed on the same `host:port`, and otherwise reports `"<id>" is not served on <host:port> — /llama-infra use <model>` (once per id) instead of forwarding the decorated id and letting the server answer `model_not_found`. Ids are never rewritten across hosts and never by name similarity: an ambiguous guess about which model a request meant is worse than an explicit failure. Ids with no `(host:port)` tag are left exactly as pi sent them, so other providers are never touched.
- **Model flavor words are kept in registered names.** `cleanModelName()` stripped `-Uncensored`, `-Instruct`, `-Alpaca`, `-Chat`, `-Turbo`, `-Base`, `-MoE` and `-UD` as packaging suffixes, so `orcarouter/Example-Uncensored` registered as `Example` — indistinguishable from the base model it was tuned from, both in `/model` and as a `modelOptions` key. Only quantization tags (`-Q4_K_M`, `-F16`, …), file suffixes (`.gguf`, bare `-GGUF`) and version suffixes are stripped now. **Note:** if you pinned a `modelOptions` key to a display name that has now gained its flavor word, re-key it to the raw served id (`/v1/models` → `id`), which is stable and always resolves.

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
