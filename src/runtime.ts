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
// `prompt + max_tokens + REQUEST_SAFETY_TOKENS <= contextWindow`.

/** Extra tokens reserved for response overhead and estimation error. */
export const REQUEST_SAFETY_TOKENS = 4096;

/** Flat token cost charged per image part (base64 data is never counted). */
const IMAGE_TOKEN_COST = 1024;

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
 * Heuristic: text chars / 4, tool-schema JSON chars / 3.5 (tool JSON
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
	return Math.ceil(acc.chars / 4) + Math.ceil(acc.toolsChars / 3.5) + acc.images * IMAGE_TOKEN_COST + 256;
}

/**
 * Clamp a request's `max_tokens` so the estimated prompt plus the requested
 * output plus REQUEST_SAFETY_TOKENS still fit in the model context window.
 *
 * Returns the clamped value only when it is strictly smaller than the current
 * `max_tokens` (never increases, never forces a value when none was set);
 * otherwise returns undefined so the caller leaves the payload untouched.
 */
export function clampMaxTokensToFit(
	payload: Record<string, unknown>,
	contextWindow: number,
): number | undefined {
	const current = payload.max_tokens;
	if (typeof current !== "number" || !Number.isFinite(current)) return undefined;
	if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;
	const available = Math.floor(contextWindow - estimatePromptTokens(payload) - REQUEST_SAFETY_TOKENS);
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
 * applied on top of those params. Invalid inputs leave params untouched.
 */
export function composeOnPayload(
	prev: ((params: any, model: any) => unknown) | undefined,
	contextWindow: number | undefined,
	stripFields?: string[],
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
				if (clamped !== undefined) return { ...effective, max_tokens: clamped };
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
			const buildOptions = (stripFields?: string[]) => {
				const composed = composeOnPayload(options?.onPayload, contextWindow, stripFields);
				const onPayload = async (params: any, payloadModel: any) => {
					const final = await composed(params, payloadModel);
					sentBudgetFields =
						final && typeof final === "object"
							? THINKING_BUDGET_FIELDS.filter((field) => final[field] !== undefined)
							: [];
					return final;
				};
				return withLocalRuntimeDefaults({ ...options, onPayload }, activeRequestTimeoutMs());
			};

			let inner = streamSimple(requestModel, context, buildOptions());
			const iterator = inner[Symbol.asyncIterator]();

			// pi-ai emits `start` before the response is read, so an HTTP 400 arrives as
			// `start` → `error`. Buffer events until the stream either fails or really
			// starts producing content (a 400 never produces content), which keeps the
			// decision reversible without delaying visible output.
			const buffered: any[] = [];
			let rejection: string | undefined;
			for (;;) {
				const next = await iterator.next();
				if (next.done) break;
				const event = next.value;
				buffered.push(event);
				if (event?.type === "error") {
					// Self-healing: some engines (strict Python/vLLM-fork native workers)
					// reject the thinking-budget field with HTTP 400 instead of ignoring it.
					// Retry ONCE without any budget field, and only keep the opt-out when
					// the retry works — unrelated 400s (context overflow, bad tools) are
					// surfaced untouched.
					rejection = budgetFieldRejection(event, sentBudgetFields);
					break;
				}
				if (event?.type !== "start") break; // real content → no retry
			}

			if (rejection) {
				const configured = configuredBudgetField(requestModel) ?? configuredBudgetField(model);
				debugLog(`thinking-budget field rejected by ${model?.id} (${rejection}): ${errorTextOf(buffered[buffered.length - 1])}`);
				const retryModel = {
					...requestModel,
					compat: {
						...(requestModel?.compat ?? {}),
						thinkingTokenBudgetField: false,
						supportsThinkingTokenBudget: false,
					},
				};
				const strip = configured ? [...THINKING_BUDGET_FIELDS, configured] : THINKING_BUDGET_FIELDS;
				const retry = streamSimple(retryModel, context, buildOptions(strip));
				let retryErrored = false;
				for await (const event of retry) {
					if (event?.type === "error") retryErrored = true;
					out.push(event);
				}
				if (typeof retry.result === "function") out.end(await retry.result());
				else out.end();
				if (!retryErrored) {
					console.error(
						`[llama-infra] ${model?.id ?? "model"} rejected the thinking-budget field${configured ? ` (${configured})` : ""}; retried without it and saved the opt-out (\"thinkingBudgetField\": false).`,
					);
					disableThinkingBudgetField(model?.id);
					// The persisted config applies on the next scan; this keeps the current
					// session from resending (and re-failing) on every following turn.
					disableBudgetFieldOnModel(model);
				}
				return;
			}

			for (const event of buffered) out.push(event);
			for (;;) {
				const next = await iterator.next();
				if (next.done) break;
				out.push(next.value);
			}
			if (typeof inner.result === "function") out.end(await inner.result());
			else out.end();
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
