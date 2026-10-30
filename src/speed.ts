// Client-side speed tracker: measures prefill and generation speed of the
// active model straight from pi's stream events and updates the footer line
// (via setStatus, so no extra terminal row is taken) ~every 100 ms while
// tokens arrive.
//
//   prefill = UNCACHED prompt tokens / time-to-first-token, but only when that
//             time-to-first-token is long enough for compute to dominate (a
//             prefix-cache hit answers 80k tokens in 0.5 s, so the division
//             would report six figures). Otherwise the footer shows the
//             time-to-first-token itself: `⚡ 561ms`.
//   gen     = generated tokens / time since the first token (whole-request
//             average, like trimegisto's ↓t/s). Live samples use the streamed
//             characters calibrated with a tokens-per-character ratio learned
//             from the provider's real `usage.output`.
//
// Footer format (kept ultra-compact so it coexists with other extensions on
// pi's single status line, which is truncated at the end):
//
//   ⚡ {prefill} t/s | ⚡ {ttft}ms   🔥 {gen} t/s
//
// The server-side /metrics polling (metrics.ts) only supplements this:
// when the client is idle but the server reports other clients processing,
// their rate is shown as `▶{n} ⚡ … t/s 🔥 … t/s`. The client measurement
// works even when the server has no --metrics endpoint.

import { debugLog, METRICS_STATUS_KEY } from "./core.ts";
import type { AssistantMessageEvent, ExtensionContext, ServerMetricsState, ThemeFg } from "./types.ts";

const safeFg: ThemeFg = (_color, text) => text;

/** Max time between footer updates while a stream is live. */
const RENDER_THROTTLE_MS = 100;
/** Minimum decode span before a generation rate is trusted (avoid startup spikes). */
const GEN_MIN_SPAN_MS = 400;
/**
 * A prefill sample is only reported as a throughput when the prompt was big
 * enough for compute to dominate the round trip. Short prompts (and prompts
 * served from the engine's prefix cache) measure latency, not throughput, so
 * they are reported as a time-to-first-token instead. Same thresholds as
 * trimegisto's ↑t/s telemetry.
 */
const PREFILL_MIN_SAMPLE_MS = 1_000;
const PREFILL_MIN_SAMPLE_TOKENS = 500;
/** Below this, a measured time-to-first-token is just noise → keep the previous reading. */
const MIN_TTFT_MS = 60;
/** Typical tokens-per-character for prose/code streams; refined per model from usage. */
const DEFAULT_TOK_PER_CHAR = 0.35;
const TOK_PER_CHAR_MIN = 0.05;
const TOK_PER_CHAR_MAX = 2;
/** Smoothing between successive measured samples (same as trimegisto). */
const EMA_ALPHA = 0.35;
/** Hard ceiling against nonsense (a real local engine never exceeds this). */
const MAX_SPEED = 1_000_000;

const DELTA_EVENT_TYPES: ReadonlySet<string> = new Set(["text_delta", "thinking_delta", "toolcall_delta"]);

export interface SpeedDeps {
	/** Whether the extension is still active (post-shutdown guard). */
	isActive: () => boolean;
	/** Whether the ctx has a UI (with stale-ctx safety). */
	hasUI: (ctx: ExtensionContext | undefined) => ctx is ExtensionContext;
	/** Whether the current session model belongs to this provider. */
	isOurs: (ctx: ExtensionContext | undefined) => boolean;
	/** Whether the widget is enabled in settings. */
	enabled: () => boolean;
}

type SpeedState = "idle" | "prefill" | "streaming" | "done";

/** What the ⚡ slot shows: a trusted throughput, or just the TTFT of the last call. */
interface PrefillReading {
	/** Tokens/s, only for samples big/long enough to be a throughput. */
	tps?: number;
	/** Time-to-first-token of the last call, in ms. */
	ttftMs?: number;
}

function formatRate(rate: number): string {
	return rate >= 100 ? String(Math.round(rate)) : rate.toFixed(1);
}

function formatElapsed(ms: number): string {
	if (ms < 1_000) return `${Math.round(ms)}ms`;
	return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

function rateColor(rate: number, kind: "prefill" | "gen"): string {
	const success = kind === "prefill" ? 500 : 100;
	const warning = kind === "prefill" ? 20 : 10;
	return rate > success ? "success" : rate > warning ? "warning" : "muted";
}

function clampSpeed(n: number): number | undefined {
	if (!Number.isFinite(n) || n <= 0) return undefined;
	return Math.min(n, MAX_SPEED);
}

function ema(prev: number | undefined, sample: number): number {
	const clamped = Math.min(sample, MAX_SPEED);
	if (prev === undefined || prev <= 0) return clamped;
	return clamped * EMA_ALPHA + prev * (1 - EMA_ALPHA);
}

export function createSpeedTracker(deps: SpeedDeps) {
	let state: SpeedState = "idle";
	/** before_provider_request timestamp: when prompt processing starts. */
	let requestStart: number | undefined;
	let firstTokenAt: number | undefined;
	/** Characters streamed for this request (all delta kinds). */
	let deltaChars = 0;
	/** Output tokens reported live by the provider for this request, if any. */
	let liveOutputTokens = 0;
	/** Learned characters→tokens ratio for the model (carried across requests). */
	let tokPerChar = DEFAULT_TOK_PER_CHAR;
	/** Last trusted prefill reading (rate and/or TTFT). */
	let prefill: PrefillReading | undefined;
	/** Smoothed generation rate of finished requests. */
	let lastGenTps: number | undefined;
	let lastRenderAt = 0;
	let statusActive = false;
	/** Last text sent to the footer (skip redundant updates → fewer re-renders). */
	let lastSentText = "";
	let server: ServerMetricsState | null = null;
	/** Most recent live ctx (used when a callback arrives without one). */
	let lastCtx: ExtensionContext | undefined;
	/** Model the current measurements belong to (rates are model properties). */
	let modelId: string | undefined;

	function rememberCtx(ctx: ExtensionContext | undefined): void {
		if (!ctx || !deps.hasUI(ctx)) return;
		lastCtx = ctx;
		const id = (ctx as { model?: { id?: unknown } }).model?.id;
		if (typeof id === "string" && id !== modelId) {
			// Different model → previous prefill/decode/ratio do not apply.
			modelId = id;
			prefill = undefined;
			lastGenTps = undefined;
			tokPerChar = DEFAULT_TOK_PER_CHAR;
		}
	}

	function targetCtx(ctx: ExtensionContext | undefined): ExtensionContext | undefined {
		if (ctx && deps.hasUI(ctx)) return ctx;
		return lastCtx;
	}

	function fg(ctx: ExtensionContext | undefined): ThemeFg {
		if (!deps.hasUI(ctx)) return safeFg;
		try {
			return (ctx.ui.theme?.fg as ThemeFg | undefined)?.bind(ctx.ui.theme) ?? safeFg;
		} catch {
			return safeFg;
		}
	}

	function clearStatus(ctx: ExtensionContext | undefined): void {
		if (!deps.hasUI(ctx) || !statusActive) return;
		try {
			ctx.ui.setStatus(METRICS_STATUS_KEY, undefined);
		} catch (err) {
			debugLog(`speed status clear failed: ${err}`);
		}
		statusActive = false;
		lastSentText = "";
	}

	function resetInternal(): void {
		state = "idle";
		requestStart = undefined;
		firstTokenAt = undefined;
		deltaChars = 0;
		liveOutputTokens = 0;
		lastGenTps = undefined;
		server = null;
		statusActive = false;
		lastSentText = "";
	}

	/** Tokens generated so far: live provider usage when available, else chars → tokens. */
	function generatedTokens(): number {
		if (liveOutputTokens > 0) return liveOutputTokens;
		return deltaChars * tokPerChar;
	}

	/**
	 * Live generation rate: whole-request average since the first token (stable
	 * against bursty arrival), never a window over event timestamps — a window
	 * counts stream chunks, which is not the same as tokens.
	 */
	function liveGenRate(now: number): number | undefined {
		if (firstTokenAt === undefined) return undefined;
		const elapsedMs = now - firstTokenAt;
		if (elapsedMs < GEN_MIN_SPAN_MS) return undefined;
		const tokens = generatedTokens();
		if (tokens <= 0) return undefined;
		return clampSpeed(tokens / (elapsedMs / 1000));
	}

	function prefillPart(ctx: ExtensionContext | undefined): string | undefined {
		const f = fg(ctx);
		if (prefill?.tps !== undefined) return f(rateColor(prefill.tps, "prefill"), `⚡ ${formatRate(prefill.tps)} t/s`);
		if (prefill?.ttftMs !== undefined) {
			const slow = prefill.ttftMs > 2_000;
			return f(slow ? "warning" : "muted", `⚡ ${formatElapsed(prefill.ttftMs)}`);
		}
		return undefined;
	}

	function buildLine(ctx: ExtensionContext | undefined, now: number): string {
		const f = fg(ctx);
		const parts: string[] = [];

		// The measured rates are the backbone: they persist across requests and
		// turns so the footer never flickers back to placeholders once known.
		// A live rate is only computed while a stream is actually running.
		const live = state === "streaming" ? liveGenRate(now) : undefined;
		const gen = live ?? lastGenTps;

		const prefillText = prefillPart(ctx);
		if (prefillText !== undefined) {
			parts.push(prefillText);
		} else if (state === "prefill") {
			parts.push(f("warning", "⚡…"));
		}

		// Generation: live whole-request average while streaming, smoothed value
		// of the last finished request otherwise. Placeholder only while a stream
		// is pending its first computable rate.
		if (gen !== undefined) {
			parts.push(f(rateColor(gen, "gen"), `🔥 ${formatRate(gen)} t/s`));
		} else if (state === "prefill" || state === "streaming") {
			parts.push(f("muted", "🔥…"));
		}

		// Idle keeps the measured rates and supplements with server-side activity
		// from *other* clients. The paused icon only appears when there is
		// neither a rate nor server activity to show.
		if (state === "idle") {
			if (server && server.processing > 0) {
				parts.push(f("success", `▶${server.processing}`));
				if (server.promptTps !== undefined && server.promptTps > 0) {
					parts.push(f(rateColor(server.promptTps, "prefill"), `⚡ ${Math.round(server.promptTps)} t/s`));
				}
				if (server.genTps !== undefined && server.genTps > 0) {
					parts.push(f(rateColor(server.genTps, "gen"), `🔥 ${formatRate(server.genTps)} t/s`));
				}
				// vLLM extras: drafter acceptance + prefix-cache reuse (lifetime ratios).
				if (server.specAcceptRate !== undefined && server.specAcceptRate > 0) {
					parts.push(f("muted", `🎯 ${Math.round(server.specAcceptRate * 100)}%`));
				}
				if (server.prefixCacheHitRate !== undefined && server.prefixCacheHitRate > 0) {
					parts.push(f("muted", `♻️ ${Math.round(server.prefixCacheHitRate * 100)}%`));
				}
			} else if (parts.length === 0) {
				parts.push(f("muted", "⏸"));
			}
		}

		// Nothing measurable yet (fresh idle session).
		if (parts.length === 0) parts.push(f("muted", "⏸"));
		return parts.join(" ");
	}

	function render(ctx: ExtensionContext | undefined, now: number, force = false): void {
		if (!deps.isActive() || !deps.enabled()) {
			clearStatus(ctx);
			return;
		}
		if (!deps.hasUI(ctx) || !deps.isOurs(ctx)) return;
		const line = buildLine(ctx, now);
		if (!force && now - lastRenderAt < RENDER_THROTTLE_MS) return;
		lastRenderAt = now;
		// No visual change → skip (avoids a full UI re-render on the footer).
		if (line === lastSentText && statusActive) return;
		lastSentText = line;
		try {
			ctx.ui.setStatus(METRICS_STATUS_KEY, line);
			statusActive = true;
		} catch (err) {
			debugLog(`speed status update failed: ${err}`);
		}
	}

	return {
		/** before_provider_request: a new LLM call starts (prefill pending). */
		onRequest(ctx: ExtensionContext | undefined, at: number): void {
			if (!deps.isActive()) return;
			rememberCtx(ctx);
			if (!deps.isOurs(ctx) || !deps.enabled()) {
				clearStatus(targetCtx(ctx));
				resetInternal();
				return;
			}
			state = "prefill";
			requestStart = at;
			firstTokenAt = undefined;
			deltaChars = 0;
			liveOutputTokens = 0;
			render(ctx, at, true);
		},

		/** message_update: per-token stream events. */
		onToken(ctx: ExtensionContext | undefined, ev: AssistantMessageEvent, at: number): void {
			if (!deps.isActive() || !deps.enabled()) return;
			rememberCtx(ctx);
			if (!deps.isOurs(ctx)) return;
			if (ev.type === "error") {
				// Stream failed/aborted: finalize what we have.
				state = "done";
				render(ctx, at, true);
				return;
			}
			if (!DELTA_EVENT_TYPES.has(ev.type)) return;
			if (firstTokenAt === undefined) {
				// First visible token: prompt processing is over.
				firstTokenAt = at;
				state = "streaming";
			}
			// Stream chunks are not tokens (one chunk can carry many tokens, and a
			// tool-call fragment is a JSON slice), so count characters and convert
			// with the ratio learned from real usage.
			const text = (ev as { delta?: unknown }).delta;
			if (typeof text === "string") deltaChars += text.length;
			const partialOutput = (ev as { partial?: { usage?: { output?: unknown } } }).partial?.usage?.output;
			if (typeof partialOutput === "number" && partialOutput > liveOutputTokens) {
				liveOutputTokens = partialOutput;
			}
			render(ctx, at);
		},

		/** message_end (assistant only): finalize the call, compute prefill + decode. */
		onMessageEnd(ctx: ExtensionContext | undefined, message: unknown, at: number): void {
			if (!deps.isActive() || !deps.enabled()) return;
			rememberCtx(ctx);
			if (!deps.isOurs(ctx)) return;
			const role = (message as { role?: string } | undefined)?.role;
			if (role !== "assistant") return;
			const usage = (
				message as
					| {
							usage?: {
								input?: unknown;
								cacheRead?: unknown;
								cacheWrite?: unknown;
								output?: unknown;
								prompt_tokens?: unknown;
							};
					  }
					| undefined
			)?.usage;
			const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
			// Prompt tokens that actually had to be processed: pi's `input` already
			// excludes cache reads/writes, so add the cache writes back (those tokens
			// were processed too). OpenAI-style `prompt_tokens` is the last fallback.
			const input = num(usage?.input) || num(usage?.prompt_tokens);
			const processedPrompt = input + num(usage?.cacheWrite);
			const outputTokens = num(usage?.output);

			if (firstTokenAt !== undefined) {
				const ttftMs = firstTokenAt - (requestStart ?? firstTokenAt);
				if (ttftMs >= MIN_TTFT_MS) {
					const trusted =
						ttftMs >= PREFILL_MIN_SAMPLE_MS && processedPrompt >= PREFILL_MIN_SAMPLE_TOKENS;
					if (trusted) {
						// Real prompt processing: report (and smooth) the throughput.
						const sample = processedPrompt / (ttftMs / 1000);
						const smoothed = ema(prefill?.tps, sample);
						prefill = { tps: smoothed, ttftMs };
						debugLog(
							`prefill ${Math.round(smoothed)} t/s (${processedPrompt} tok / ${(ttftMs / 1000).toFixed(3)}s)`,
						);
					} else {
						// Too fast/short to be a throughput: a prefix-cache hit or a small
						// prompt. Report the TTFT instead of an absurd six-figure rate.
						prefill = { ttftMs };
						debugLog(
							`prefill not measurable (${processedPrompt} tok in ${ttftMs}ms → cache hit or short prompt); showing TTFT`,
						);
					}
				}

				// Decode: authoritative whole-request average.
				const genMs = at - firstTokenAt;
				if (genMs >= GEN_MIN_SPAN_MS && outputTokens > 0) {
					lastGenTps = ema(lastGenTps, (outputTokens * 1000) / genMs);
					// Calibrate the live estimator with what the stream really cost.
					if (deltaChars > 0) {
						const ratio = outputTokens / deltaChars;
						if (ratio >= TOK_PER_CHAR_MIN && ratio <= TOK_PER_CHAR_MAX) {
							tokPerChar = ema(tokPerChar, ratio);
						}
					}
					debugLog(
						`gen ${formatRate(lastGenTps)} t/s (${outputTokens} tok / ${(genMs / 1000).toFixed(3)}s)`,
					);
				}
			}
			state = "done";
			render(ctx, at, true);
		},

		/** turn_end: back to idle. */
		onTurnEnd(ctx: ExtensionContext | undefined): void {
			rememberCtx(ctx);
			if (!deps.isActive() || !deps.enabled()) {
				clearStatus(targetCtx(ctx));
				resetInternal();
				return;
			}
			if (!deps.isOurs(ctx)) {
				clearStatus(targetCtx(ctx));
				resetInternal();
				return;
			}
			state = "idle";
			firstTokenAt = undefined;
			requestStart = undefined;
			deltaChars = 0;
			liveOutputTokens = 0;
			render(ctx, Date.now(), true);
		},

		/** Server-side /metrics state (from metrics.ts poller). */
		onServerState(ctx: ExtensionContext | undefined, st: ServerMetricsState | null): void {
			server = st;
			if (!deps.isActive() || !deps.enabled()) return;
			const target = targetCtx(ctx);
			if (!target || !deps.isOurs(target)) return;
			// Only worth a render when idle (the supplement is only shown then).
			if (state === "idle") render(target, Date.now(), true);
		},

		/** Render the current (idle) state on session start / model select. */
		start(ctx: ExtensionContext | undefined): void {
			if (!deps.isActive()) return;
			rememberCtx(ctx);
			const target = targetCtx(ctx);
			if (!deps.enabled() || !target || !deps.isOurs(target)) {
				clearStatus(targetCtx(ctx));
				return;
			}
			state = "idle";
			render(target, Date.now(), true);
		},

		/** Hide the footer metrics (session shutdown, toggle off, foreign model). */
		stop(ctx: ExtensionContext | undefined): void {
			clearStatus(targetCtx(ctx));
			resetInternal();
			prefill = undefined;
			tokPerChar = DEFAULT_TOK_PER_CHAR;
		},
	};
}

export type SpeedTracker = ReturnType<typeof createSpeedTracker>;
