// Runtime request defaults for the OpenAI-compatible llama.cpp provider.
// pi owns the normal SDK stream options, but this provider is for slow local
// models where long generations are expected. Keep a local floor so llamacpp-
// infra models don't inherit too-small global/default request timeouts.

import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_PROVIDER_TIMEOUT_MS, debugLog, disableThinkingBudgetField, shared, stripThinkingBudgetFields } from "./core.ts";

type AssistantMessageEvent = any;
type AssistantMessage = any;
type StreamOptions = Record<string, any> | undefined;
type StreamSimple = (model: any, context: any, options?: Record<string, any>) => AsyncIterable<AssistantMessageEvent> & { result?: () => Promise<AssistantMessage> };

class ForwardedAssistantMessageEventStream implements AsyncIterable<AssistantMessageEvent> {
	private queue: AssistantMessageEvent[] = [];
	private waiting: Array<(result: IteratorResult<AssistantMessageEvent>) => void> = [];
	private done = false;
	private resolveFinal!: (value: AssistantMessage) => void;
	private readonly finalResult = new Promise<AssistantMessage>((resolve) => {
		this.resolveFinal = resolve;
	});

	push(event: AssistantMessageEvent): void {
		if (this.done) return;
		if (event?.type === "done") {
			this.done = true;
			this.resolveFinal(event.message);
		} else if (event?.type === "error") {
			this.done = true;
			this.resolveFinal(event.error);
		}

		const waiter = this.waiting.shift();
		if (waiter) waiter({ value: event, done: false });
		else this.queue.push(event);
	}

	end(result?: AssistantMessage): void {
		this.done = true;
		if (result !== undefined) this.resolveFinal(result);
		while (this.waiting.length > 0) this.waiting.shift()?.({ value: undefined, done: true });
	}

	async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
		for (;;) {
			if (this.queue.length > 0) {
				yield this.queue.shift();
			} else if (this.done) {
				return;
			} else {
				const next = await new Promise<IteratorResult<AssistantMessageEvent>>((resolve) => this.waiting.push(resolve));
				if (next.done) return;
				yield next.value;
			}
		}
	}

	result(): Promise<AssistantMessage> {
		return this.finalResult;
	}
}

let openAICompletionsStreamPromise: Promise<StreamSimple> | undefined;

async function loadOpenAICompletionsStreamSimple(): Promise<StreamSimple> {
	if (!openAICompletionsStreamPromise) {
		openAICompletionsStreamPromise = (async () => {
			try {
				// pi's extension loader aliases the pi-ai ROOT specifier to the compat
				// entry (which re-exports openAICompletionsApi), so this import works in
				// every pi runtime (jiti aliases / virtual modules / tsconfig paths).
				// Subpath specifiers like "@earendil-works/pi-ai/api/openai-completions"
				// are NOT aliased and only resolve inside a real node_modules install.
				const mod = await import("@earendil-works/pi-ai");
				const streams = (mod as { openAICompletionsApi?: () => { streamSimple: StreamSimple } }).openAICompletionsApi?.();
				if (typeof streams?.streamSimple === "function") return streams.streamSimple;
			} catch {
				// fall through to the nested-module lookup below
			}
			// In real pi package installs, pi-ai may be nested under pi-coding-agent
			// instead of hoisted as a top-level dependency of this extension.
			const piIndexUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
			const piPackageDir = dirname(dirname(fileURLToPath(piIndexUrl)));
			const nestedModule = join(piPackageDir, "node_modules", "@earendil-works", "pi-ai", "dist", "api", "openai-completions.js");
			const nestedMod = await import(pathToFileURL(nestedModule).href);
			return (nestedMod as { streamSimple: StreamSimple }).streamSimple;
		})();
	}
	return openAICompletionsStreamPromise;
}

export function activeRequestTimeoutMs(): number {
	const configured = shared.activeConfig?.settings?.requestTimeoutMs;
	return typeof configured === "number" && Number.isFinite(configured) && configured > 0
		? configured
		: DEFAULT_PROVIDER_TIMEOUT_MS;
}

export function withLocalRuntimeDefaults(options: StreamOptions, floorMs?: number): Record<string, any> {
	const floor = typeof floorMs === "number" && Number.isFinite(floorMs) && floorMs > 0 ? floorMs : DEFAULT_PROVIDER_TIMEOUT_MS;
	const currentTimeout = typeof options?.timeoutMs === "number" && Number.isFinite(options.timeoutMs) ? options.timeoutMs : undefined;
	return {
		...(options ?? {}),
		timeoutMs: currentTimeout === undefined ? floor : Math.max(currentTimeout, floor),
	};
}

/**
 * Map a pi-visible model to the model object sent to the server.
 *
 * pi-visible ids are decorated with a "(host:port)" tag to disambiguate
 * across machines, but OpenAI-compatible servers (vLLM/SGLang/TGI/AMDahl)
 * only know the raw served model id and answer 404 "model does not exist"
 * for the decorated one. The main session rewrites this in the
 * `before_provider_request` hook, but nested calls made by other extensions
 * through ctx.modelRegistry.complete()/streamSimple() never traverse that
 * hook — so the rewrite must also happen inside the provider stream itself.
 */
export function toServerRequestModel<T extends { id?: string }>(
	model: T,
	ids: Map<string, string> = shared.serverModelIds,
): T {
	const id = typeof model?.id === "string" ? model.id : undefined;
	const raw = id !== undefined ? ids.get(id) : undefined;
	return raw !== undefined && raw !== id ? { ...model, id: raw } : model;
}

// ── Request-time max_tokens clamp ─────────────────────────────────────────
//
// pi's own `estimateContextTokens` is tokenizer-exact for the chat text but
// ignores tool schemas entirely. On tool-heavy setups those schemas can add
// tens of thousands of tokens, so pi happily sends a request whose
// prompt + max_tokens exceeds the served context window. Strict engines (vLLM)
// answer HTTP 400 in that case. The estimate + clamp below keep
// `prompt + max_tokens + requestReserveTokens(estimate) <= contextWindow`.

/** Minimum tokens reserved for response overhead and estimation error. */
export const REQUEST_SAFETY_TOKENS = 4096;

/** Share of the ESTIMATED PROMPT also kept free on top of the flat reserve.
 *
 * The divisors in `estimatePromptTokens` are heuristics, and their error grows
 * with the payload: on a real vLLM turn the server counted 75318 prompt tokens
 * where the estimator said 71221 (+5.8%), so the flat 4096-token reserve was
 * consumed exactly and the request left as `prompt + max_tokens = context + 1`
 * — the very HTTP 400 this clamp exists to prevent. Reserving a share of the
 * prompt makes the headroom grow with the quantity being mis-measured, instead
 * of a fixed budget that one long tool-heavy prompt can eat whole. */
export const PROMPT_SAFETY_RATIO = 0.1;

/** Headroom to reserve on top of an estimated prompt size: the flat floor, or
 *  `PROMPT_SAFETY_RATIO` of the estimate, whichever is larger. */
export function requestReserveTokens(estimate: number): number {
	const scaled = Number.isFinite(estimate) && estimate > 0 ? Math.ceil(estimate * PROMPT_SAFETY_RATIO) : 0;
	return Math.max(REQUEST_SAFETY_TOKENS, scaled);
}

/** Opening line of pi's compaction / branch-summarization system prompt (see
 *  `SUMMARIZATION_SYSTEM_PROMPT` in pi's `core/compaction/utils`). It is the one
 *  stable marker of a checkpoint request: pi builds it as a fresh context with a
 *  single user message holding the serialized transcript and no tools. */
export const SUMMARIZATION_SYSTEM_PROMPT_MARKER = "You are a context summarization assistant";

/** Concatenate the text of a message `content` (string or array of parts). */
function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const part of content) {
		if (typeof part === "string") text += part;
		else if (part !== null && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
			text += (part as { text: string }).text;
		}
	}
	return text;
}

/** True when the payload is pi's compaction/branch summarization request.
 *
 *  Detected by pi's own summarization system prompt, which no chat request can
 *  carry by accident (a normal turn's system prompt is pi's agent prompt, even
 *  when the user pastes text about summarization). Deliberately independent of
 *  the user payload: the transcript lives in a plain user message. */
export function isSummarizationPayload(payload: Record<string, unknown>): boolean {
	const messages = payload.messages;
	if (!Array.isArray(messages) || messages.length === 0) return false;
	// Compaction never offers tools; a tool-carrying request is a normal turn.
	if (Array.isArray(payload.tools) && payload.tools.length > 0) return false;
	if (typeof payload.system === "string" && payload.system.includes(SUMMARIZATION_SYSTEM_PROMPT_MARKER)) return true;
	for (const message of messages) {
		if (message === null || typeof message !== "object") continue;
		const record = message as { role?: unknown; content?: unknown };
		if (record.role !== "system" && record.role !== "developer") continue;
		if (messageText(record.content).includes(SUMMARIZATION_SYSTEM_PROMPT_MARKER)) return true;
	}
	return false;
}

/** Extra headroom kept when retrying an overflow using the prompt size the
 *  server itself reported (a lower bound: "at least N input tokens"). */
export const OVERFLOW_SAFETY_TOKENS = 4096;

/** How many times ONE request may be retried after an overflow rejection.
 *
 *  Strict engines report the prompt size they counted, but only as a LOWER
 *  BOUND (see `OVERFLOW_LOWER_BOUND_SHARE`), so a retry sized from that number
 *  can still not fit. Each attempt re-reads the fresh report and keeps more
 *  room free, so a small budget converges instead of surfacing the 400 after
 *  one try. */
export const OVERFLOW_MAX_RETRIES = 2;

/** Share of the remaining room kept FREE on a retry whose report is only a
 *  lower bound for the prompt size.
 *
 *  Filling the window exactly is only safe when the count is exact. On a lower
 *  bound the true prompt is unknown ("at least N"), so the retry must leave a
 *  fraction of the window unused or it is one longer prompt away from the very
 *  same 400. The 2026-11 compaction incident: window 262144, report "at least
 *  47100 input tokens", requested output 215045 — a single retry would still
 *  have asked for 210948 output tokens. */
export const OVERFLOW_LOWER_BOUND_SHARE = 0.25;

/** Flat token cost charged per image part (base64 data is never counted). */
const IMAGE_TOKEN_COST = 1400;

/** Chars per token for prose and for tool-schema JSON. pi itself uses 3.5 for
 *  text; tool JSON tokenizes denser (names, keys, punctuation), so it gets a
 *  lower divisor. Both are deliberately conservative: over-estimating only
 *  trims max_tokens, under-estimating lets a strict engine answer HTTP 400. */
const TEXT_CHARS_PER_TOKEN = 3.5;
const TOOLS_CHARS_PER_TOKEN = 3.0;

interface PromptEstimate {
	chars: number;
	toolsChars: number;
	images: number;
}

/**
 * Recursively walk a payload fragment, counting text characters and image
 * parts. Image objects (whose `type` is an image marker) are counted and NOT
 * recursed, so multi-megabyte base64 data URLs never inflate the estimate.
 */
function walkPrompt(value: unknown, acc: PromptEstimate): void {
	if (typeof value === "string") {
		acc.chars += value.length;
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) walkPrompt(item, acc);
		return;
	}
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		const type = record.type;
		if (type === "image" || type === "image_url" || type === "input_image") {
			acc.images += 1;
			return;
		}
		for (const item of Object.values(record)) walkPrompt(item, acc);
	}
}

/**
 * Rough prompt-size estimate in tokens for an OpenAI-compatible request.
 *
 * Heuristic: text chars / 3.5, tool-schema JSON chars / 3 (tool JSON
 * tokenizes denser than plain prose — names/keys/punctuation), plus a flat
 * cost per image part, plus a fixed 256-token overhead for chat framing /
 * role markers.
 */
export function estimatePromptTokens(payload: Record<string, unknown>): number {
	const acc: PromptEstimate = { chars: 0, toolsChars: 0, images: 0 };
	walkPrompt(payload.messages, acc);
	walkPrompt(payload.system, acc);
	walkPrompt(payload.prompt, acc);
	const tools = payload.tools;
	if (tools !== undefined) {
		try {
			acc.toolsChars += JSON.stringify(tools).length;
		} catch {
			// Non-serializable tools (cycles) — ignore rather than throw at request time.
		}
	}
	return (
		Math.ceil(acc.chars / TEXT_CHARS_PER_TOKEN) +
		Math.ceil(acc.toolsChars / TOOLS_CHARS_PER_TOKEN) +
		acc.images * IMAGE_TOKEN_COST +
		256
	);
}

/** Prompt size and served window as reported by a strict engine's 400 body.
 *
 *  `inputTokens` is what the engine counted for the prompt, but when
 *  `lowerBound` is true the body only said "at least N input tokens": the real
 *  prompt may be longer, so `inputTokens` must never be treated as its size. */
export interface ContextOverflowReport {
	inputTokens: number;
	contextWindow?: number;
	lowerBound: boolean;
}

function toTokenCount(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	const value = Number(raw.replace(/,/g, ""));
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Parse a strict engine's context-overflow rejection. vLLM/SGLang answer:
 *
 *   This model's maximum context length is 200000 tokens. However, you
 *   requested 32768 output tokens and your prompt contains at least 167233
 *   input tokens, for a total of at least 200001 tokens. …
 *   (parameter=input_tokens, value=167233)
 *
 * Returns undefined for every other error, so unrelated 400s are never
 * retried with a modified payload.
 */
export function parseContextOverflow(errorText: unknown): ContextOverflowReport | undefined {
	if (typeof errorText !== "string" || errorText.length === 0) return undefined;
	// Rate limiting / transient errors are never overflow rejections, even when the
	// wording mentions tokens (e.g. "Throttling: too many tokens").
	if (/(?:rate limit|too many requests|throttl)/i.test(errorText)) return undefined;
	if (
		!/(?:maximum context length|context (?:length|window)|max[_ -]?(?:model[_ -]?len|context)|prompt is too long|too many (?:input )?tokens)/i.test(
			errorText,
		)
	) {
		return undefined;
	}
	const inputMatch =
		errorText.match(/([\d,]+)\s+input tokens/i) ??
		errorText.match(/(?:input_tokens|input tokens|prompt tokens)[^\d]{0,40}([\d,]+)/i) ??
		errorText.match(/prompt (?:is )?(?:too long|contains)[^\d]{0,30}([\d,]+)/i);
	const inputTokens = toTokenCount(inputMatch?.[1]);
	if (inputTokens === undefined) return undefined;
	const contextMatch =
		errorText.match(/maximum context length is\s*([\d,]+)/i) ??
		errorText.match(/max(?:imum)?[_ -]?(?:model[_ -]?len|context(?:\s*(?:length|window))?)[^\d]{0,24}([\d,]+)/i) ??
		errorText.match(/context (?:length|window) (?:of )?([\d,]+)/i) ??
		errorText.match(/([\d,]+)\s+max[_ -]?model[_ -]?len/i);
	// vLLM/SGLang phrase the prompt count as a floor: "your prompt contains at
	// least 167233 input tokens". Treating that number as exact is what made a
	// previous retry overflow again with a longer prompt.
	const lowerBound = /\bat least\b|\bminimum of\b|≥|>=/i.test(errorText);
	return { inputTokens, contextWindow: toTokenCount(contextMatch?.[1]), lowerBound };
}

/**
 * Compute the `max_tokens` to use for the NEXT retry after a context-overflow
 * 400.
 *
 * The server reports how many prompt tokens it counted, so the retry can be
 * sized from it: `reported prompt + max_tokens + reserve <= ctx`. Two details
 * keep that honest:
 *
 * - When the body said "at least N input tokens" the count is only a floor, so
 *   a share of the remaining room (`OVERFLOW_LOWER_BOUND_SHARE`) is kept free
 *   instead of filling the window to the last token.
 * - `attempt` (0 = the first retry) grows the flat reserve, so a retry that
 *   overflowed again lands strictly smaller and the remaining attempts
 *   (`OVERFLOW_MAX_RETRIES`) can converge.
 *
 * Returns undefined when the error is not an overflow, when no window is known,
 * when the retry budget is spent, or when the cap would not actually shrink the
 * request (nothing to gain).
 */
export function overflowRetryMaxTokens(
	errorText: unknown,
	contextWindow?: number,
	currentMaxTokens?: number,
	attempt = 0,
): number | undefined {
	const report = parseContextOverflow(errorText);
	if (report === undefined) return undefined;
	const tried = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
	if (tried >= OVERFLOW_MAX_RETRIES) return undefined;
	const ctx = report.contextWindow ?? contextWindow;
	if (typeof ctx !== "number" || !Number.isFinite(ctx) || ctx <= 0) return undefined;
	// A prompt that already exceeds the window on its own cannot be fixed by
	// asking for less output: the retry would be a guaranteed second 400, so the
	// error must surface and the prompt get shortened instead.
	if (report.inputTokens >= ctx) return undefined;
	const reserve = OVERFLOW_SAFETY_TOKENS * (tried + 1);
	const room = ctx - report.inputTokens - reserve;
	const usable = report.lowerBound ? Math.floor(room * (1 - OVERFLOW_LOWER_BOUND_SHARE)) : room;
	const cap = Math.max(1, usable);
	if (cap >= ctx) return undefined;
	if (typeof currentMaxTokens === "number" && Number.isFinite(currentMaxTokens) && cap >= currentMaxTokens) {
		// The request already asked for less than the fit: a retry would repeat it.
		return undefined;
	}
	return cap;
}

/**
 * Ceiling for a checkpoint's `max_tokens`.
 *
 * A summary is a distillation of the transcript it summarizes, so asking for
 * MORE output tokens than the (estimated) transcript is never useful. Without
 * this ceiling a checkpoint request grows to the last free token of the window
 * — on a 262144-token window the 2026-11 compaction asked for 215045 output
 * tokens, which left only 47100 for a prompt the estimator had under-counted at
 * ~42800; vLLM counted more and answered 400.
 *
 * The generation policy (`settings.maxOutputTokens`, what pi sends as
 * `model.maxTokens`) is always allowed: it is a deliberate choice, not an
 * estimate.
 */
export function summarizationOutputCeiling(currentMaxTokens: number, estimate: number): number {
	const policy = Number.isFinite(currentMaxTokens) && currentMaxTokens > 0 ? currentMaxTokens : 1;
	const transcript = Number.isFinite(estimate) && estimate > 0 ? estimate : 0;
	return Math.max(1, Math.max(policy, transcript));
}

/**
 * Clamp a request's `max_tokens` so the estimated prompt plus the requested
 * output plus `requestReserveTokens(estimate)` still fit in the model context
 * window.
 *
 * Two regimes:
 *
 * - Normal turns: only ever LOWERS `max_tokens` (never increases it, never
 *   forces a value when none was set), and returns undefined when the request
 *   already fits, so the caller leaves the payload untouched.
 * - Compaction checkpoints (`isSummarizationPayload`): the value is sized to the
 *   room the window actually has, which can be ABOVE the current `max_tokens`.
 *   pi sizes a summary with `model.maxTokens`, and for servers that do not
 *   announce their own limit that is llama-infra's generation policy
 *   (`settings.maxOutputTokens`, 32768 by default). A cumulative summary that
 *   needs more than that policy is cut mid-sentence, pi discards the partial
 *   checkpoint and the session can never compact again —
 *   "Summarization failed: generation hit the token cap and the summary is
 *   incomplete". For a checkpoint the limit is the window, bounded by
 *   `summarizationOutputCeiling` so it never swallows the whole of it.
 */
export function clampMaxTokensToFit(
	payload: Record<string, unknown>,
	contextWindow: number,
): number | undefined {
	const current = payload.max_tokens;
	if (typeof current !== "number" || !Number.isFinite(current)) return undefined;
	if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;
	const estimate = estimatePromptTokens(payload);
	const available = Math.floor(contextWindow - estimate - requestReserveTokens(estimate));
	if (isSummarizationPayload(payload)) {
		// Both directions: grow into the free room (never past the checkpoint
		// ceiling), shrink when the transcript plus the reserve no longer fit (the
		// same 400 protection as a normal turn).
		const fitted = Math.max(1, Math.min(available, summarizationOutputCeiling(current, estimate)));
		return fitted === current ? undefined : fitted;
	}
	const next = Math.max(1, Math.min(current, available));
	return next < current ? next : undefined;
}

/**
 * Wrap pi's own `onPayload` hook so the tools-aware clamp always runs on the
 * exact final request params.
 *
 * pi-ai invokes `onPayload` with the fully-composed request body (including
 * tool schemas) right before it is sent, so clamping here also covers nested
 * `ctx.modelRegistry.streamSimple()` calls, which bypass the
 * `before_provider_request` plugin hook entirely.
 *
 * `prev` (pi's own handler, e.g. id rewrite / thinking budget) runs first and
 * its returned params are adopted when not null/undefined; the clamp is then
 * applied on top of those params. `hardMaxTokens` is the ceiling used by the
 * context-overflow retry: it is applied even when the estimate says the
 * request fits, because the server already proved the estimate wrong. Invalid
 * inputs leave params untouched.
 */
export function composeOnPayload(
	prev: ((params: any, model: any) => unknown) | undefined,
	contextWindow: number | undefined,
	stripFields?: string[],
	hardMaxTokens?: number,
): (params: any, model: any) => Promise<any> {
	return async (params: any, model: any) => {
		let effective = params;
		if (typeof prev === "function") {
			const updated = await prev(params, model);
			if (updated !== null && updated !== undefined) effective = updated;
		}
		if (effective !== null && typeof effective === "object") {
			// Opt-out path (self-healing retry): drop every thinking-budget field.
			if (stripFields !== undefined) effective = stripFieldsFrom(effective, stripFields);
			if (
				typeof contextWindow === "number" &&
				Number.isFinite(contextWindow) &&
				contextWindow > 0 &&
				effective !== null &&
				typeof effective === "object"
			) {
				const clamped = clampMaxTokensToFit(effective as Record<string, unknown>, contextWindow);
				if (clamped !== undefined) effective = { ...effective, max_tokens: clamped };
			}
			if (typeof hardMaxTokens === "number" && Number.isFinite(hardMaxTokens) && hardMaxTokens > 0) {
				const current = (effective as Record<string, unknown>).max_tokens;
				const bounded =
					typeof current === "number" && Number.isFinite(current) ? Math.min(current, hardMaxTokens) : hardMaxTokens;
				effective = { ...(effective as Record<string, unknown>), max_tokens: Math.max(1, Math.floor(bounded)) };
			}
		}
		return effective;
	};
}

/** Drop the known thinking-budget fields plus any extra field name (a custom
 *  `thinkingBudgetField` the server rejected). */
function stripFieldsFrom(params: any, extra: string[]): any {
	let next = stripThinkingBudgetFields(params) ?? params;
	for (const field of extra) {
		if (!field || next[field] === undefined) continue;
		const { [field]: _drop, ...rest } = next;
		next = rest;
	}
	return next;
}

/** Field names used by pi / OpenAI-compatible engines for the thinking budget. */
const THINKING_BUDGET_FIELDS = ["thinking_token_budget", "thinking_budget_tokens", "thinking_budget"];

/** True when a provider error says the server REJECTED the thinking-budget
 *  field, e.g. `not supported by the … native worker: thinking_token_budget`. Only these errors trigger the self-healing retry, so
 *  unrelated 400s (context overflow, bad tool schema, …) are never retried. */
export function rejectsThinkingBudgetField(message: string | undefined): boolean {
	if (!message) return false;
	if (!THINKING_BUDGET_FIELDS.some((field) => message.includes(field))) return false;
	return /(not supported|unsupported|not supported by|unrecognized|unrecognised|not recognized|not recognised|unknown|unexpected|extra_forbidden|not allowed|invalid|no such field)/i.test(
		message,
	);
}

/** Concatenate every string a pi-ai error event exposes as its message. */
function errorTextOf(event: any): string {
	const err = event?.error;
	if (typeof err === "string") return err;
	return [err?.errorMessage, err?.message, event?.errorMessage, event?.message]
		.filter((part): part is string => typeof part === "string")
		.join("\n");
}

/** Decide whether an error event justifies ONE retry without the thinking-budget
 *  field. Returns the reason, or undefined to surface the error untouched.
 *
 *  - The message names the field and rejects it → clear evidence.
 *  - A validation error (400/422) while a budget field was actually sent → worth
 *    one probe, because some transports drop the body ("400 status code (no
 *    body)"); the opt-out is only persisted if the retry then succeeds. */
export function budgetFieldRejection(event: any, sentFields: string[]): string | undefined {
	if (!event || event.type !== "error") return undefined;
	const message = errorTextOf(event);
	if (rejectsThinkingBudgetField(message)) return "the error names the budget field";
	if (sentFields.length > 0 && /\b(400|422)\b/.test(message)) return "validation error while sending a budget field";
	return undefined;
}

/** Thinking-budget field configured on a registered model (compat), if any. */
function configuredBudgetField(model: any): string | undefined {
	const field = model?.compat?.thinkingTokenBudgetField;
	return typeof field === "string" && field ? field : undefined;
}

/** Stop pi from sending the thinking-budget field on FUTURE turns of this
 *  session (the registered model object is what pi serializes requests from;
 *  the persisted config only takes effect on the next scan/registration). */
function disableBudgetFieldOnModel(model: any): void {
	if (!model || typeof model !== "object") return;
	if (model.compat && typeof model.compat === "object") {
		model.compat.thinkingTokenBudgetField = false;
		model.compat.supportsThinkingTokenBudget = false;
	}
}

export function createLongTimeoutOpenAICompletionsStream(model: any, context: any, options?: Record<string, any>) {
	const out = new ForwardedAssistantMessageEventStream();
	void (async () => {
		try {
			const streamSimple = await loadOpenAICompletionsStreamSimple();
			const requestModel = toServerRequestModel(model);
			// pi-ai calls `onPayload` with the FINAL request body (tool schemas
			// included), so clamping there covers both normal turns and nested
			// ctx.modelRegistry.streamSimple() calls, which bypass the
			// before_provider_request plugin hook.
			const contextWindow = typeof model?.contextWindow === "number" ? model.contextWindow : undefined;
			// Which thinking-budget fields the payload actually carried, so a bare
			// "400 status code (no body)" is only retried when dropping a field can
			// plausibly be the fix.
			let sentBudgetFields: string[] = [];
			// Largest max_tokens actually sent, so an overflow retry only fires when it
			// can shrink the request below what already failed.
			let sentMaxTokens: number | undefined;
			const buildOptions = (stripFields?: string[], hardMaxTokens?: number) => {
				const composed = composeOnPayload(options?.onPayload, contextWindow, stripFields, hardMaxTokens);
				const onPayload = async (params: any, payloadModel: any) => {
					const final = await composed(params, payloadModel);
					sentBudgetFields =
						final && typeof final === "object"
							? THINKING_BUDGET_FIELDS.filter((field) => final[field] !== undefined)
							: [];
					sentMaxTokens =
						final && typeof final === "object" && typeof final.max_tokens === "number" && Number.isFinite(final.max_tokens)
							? final.max_tokens
							: undefined;
					return final;
				};
				return withLocalRuntimeDefaults({ ...options, onPayload }, activeRequestTimeoutMs());
			};

			// pi-ai emits `start` before the response is read, so an HTTP 400 arrives as
			// `start` → `error`. Every attempt buffers events until the stream either
			// fails or really starts producing content (a 400 never produces content),
			// which keeps the retry decision reversible without delaying visible output.
			// Each retry is sized from the LATEST error report and keeps more room free,
			// so an engine that only reported a lower bound cannot defeat it forever.
			let retryModel = requestModel;
			let hardMaxTokens: number | undefined;
			let stripFields: string[] | undefined;
			let overflowRetries = 0;
			let strippedBudgetField = false;
			let strippedFieldName: string | undefined;

			for (;;) {
				const stream = streamSimple(retryModel, context, buildOptions(stripFields, hardMaxTokens));
				const iterator = stream[Symbol.asyncIterator]();
				const buffered: any[] = [];
				/** Flush what was buffered, drain the rest and close the stream. */
				const finish = async () => {
					for (const event of buffered) out.push(event);
					for (;;) {
						const next = await iterator.next();
						if (next.done) break;
						out.push(next.value);
					}
					if (typeof stream.result === "function") out.end(await stream.result());
					else out.end();
				};

				let errorEvent: any;
				for (;;) {
					const next = await iterator.next();
					if (next.done) break;
					const event = next.value;
					buffered.push(event);
					if (event?.type === "error") {
						errorEvent = event;
						break;
					}
					if (event?.type !== "start") break; // real content → no retry
				}

				if (errorEvent !== undefined) {
					const errorText = errorTextOf(errorEvent);
					// Self-healing #1: strict engines (vLLM/SGLang) answer HTTP 400 when
					// prompt + max_tokens exceeds the served window. Their body reports the
					// prompt size they counted — usually as a lower bound — so retry with a
					// max_tokens that fits, keeping a share of the window free.
					const cap = overflowRetryMaxTokens(errorText, contextWindow, sentMaxTokens, overflowRetries);
					if (cap !== undefined) {
						overflowRetries += 1;
						hardMaxTokens = cap;
						debugLog(
							`context overflow on ${model?.id}: retry ${overflowRetries}/${OVERFLOW_MAX_RETRIES} with max_tokens ${sentMaxTokens ?? "?"} → ${cap}: ${errorText}`,
						);
						continue;
					}
					// Self-healing #2: some engines (strict Python/vLLM-fork native workers)
					// reject the thinking-budget field with HTTP 400 instead of ignoring it.
					// Retry ONCE without any budget field, and only keep the opt-out when
					// the retry works — unrelated 400s (bad tools) are surfaced untouched.
					const rejection = strippedBudgetField ? undefined : budgetFieldRejection(errorEvent, sentBudgetFields);
					if (rejection !== undefined) {
						const configured = configuredBudgetField(retryModel) ?? configuredBudgetField(model);
						debugLog(`thinking-budget field rejected by ${model?.id} (${rejection}): ${errorText}`);
						const strip = configured ? [...THINKING_BUDGET_FIELDS, configured] : THINKING_BUDGET_FIELDS;
						retryModel = {
							...retryModel,
							compat: {
								...(retryModel?.compat ?? {}),
								thinkingTokenBudgetField: false,
								supportsThinkingTokenBudget: false,
							},
						};
						stripFields = strip;
						strippedBudgetField = true;
						strippedFieldName = configured;
						continue;
					}
					// Nothing to heal: surface the error exactly as the engine sent it.
					await finish();
					return;
				}

				// Real content (or a clean end): stream it out and close.
				if (overflowRetries > 0) {
					console.error(
						`[llama-infra] ${model?.id ?? "model"} rejected the request (prompt + max_tokens exceed the context window); retried with max_tokens=${sentMaxTokens ?? "?"} (attempt ${overflowRetries}/${OVERFLOW_MAX_RETRIES}) and succeeded.`,
					);
				}
				if (strippedBudgetField) {
					console.error(
						`[llama-infra] ${model?.id ?? "model"} rejected the thinking-budget field; retried without it and saved the opt-out ("thinkingBudgetField": false).`,
					);
					disableThinkingBudgetField(model?.id);
					// The persisted config applies on the next scan; this keeps the current
					// session from resending (and re-failing) on every following turn.
					disableBudgetFieldOnModel(model);
				}
				await finish();
				return;
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			out.push({
				type: "error",
				reason: "error",
				error: {
					role: "assistant",
					content: [],
					api: model?.api ?? "openai-completions",
					provider: model?.provider ?? "llama-infra",
					model: model?.id ?? "unknown",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "error",
					errorMessage: message,
					timestamp: Date.now(),
				},
			});
		}
	})();
	return out;
}
