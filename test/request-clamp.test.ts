// Standalone behavior test for the tools-aware request-time max_tokens clamp.
// Run: node --experimental-strip-types test/request-clamp.test.ts

import {
	PROMPT_SAFETY_RATIO,
	REQUEST_SAFETY_TOKENS,
	clampMaxTokensToFit,
	composeOnPayload,
	estimatePromptTokens,
	requestReserveTokens,
} from "../src/runtime.ts";

let failures = 0;

function check(label: string, cond: boolean, detail?: string): void {
	if (cond) console.log(`  ✓ ${label}`);
	else {
		failures++;
		console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

console.log("request-clamp: tools-aware max_tokens clamp");

// ── estimatePromptTokens ──────────────────────────────────────────────────
const shortEstimate = estimatePromptTokens({ messages: [{ role: "user", content: "hi" }] });
const longEstimate = estimatePromptTokens({ messages: [{ role: "user", content: "x".repeat(4000) }] });
check(
	"estimate scales with message text length (≈chars/3.5)",
	longEstimate - shortEstimate >= 1100 && longEstimate - shortEstimate <= 1200,
	`short=${shortEstimate} long=${longEstimate}`,
);

const baseMessages = { messages: [{ role: "user", content: "hello world" }] };
const bigTools = Array.from({ length: 40 }, (_, i) => ({
	type: "function",
	function: {
		name: `tool_${i}`,
		description: "d".repeat(200),
		parameters: { type: "object", properties: { arg: { type: "string", description: "y".repeat(100) } } },
	},
}));
const toolsJsonChars = JSON.stringify(bigTools).length;
const withToolsEstimate = estimatePromptTokens({ ...baseMessages, tools: bigTools });
const toolsDelta = withToolsEstimate - estimatePromptTokens(baseMessages);
check(
	"adding a large tools array raises the estimate by ≈JSON chars/3",
	Math.abs(toolsDelta - Math.ceil(toolsJsonChars / 3)) <= 2,
	`delta=${toolsDelta} json/3=${Math.ceil(toolsJsonChars / 3)}`,
);

const imageMessage = {
	messages: [
		{
			role: "user",
			content: [
				{ type: "text", text: "hi" },
				{ type: "image_url", image_url: { url: "data:image/png;base64," + "A".repeat(50000) } },
			],
		},
	],
};
const imageEstimate = estimatePromptTokens(imageMessage);
check(
	"base64 image data URL does not inflate the estimate (image charged flat)",
	imageEstimate < 5000,
	`estimate=${imageEstimate}`,
);

// ── clampMaxTokensToFit ───────────────────────────────────────────────────

// Already fits: large context, tiny prompt, modest max_tokens → no-op.
check(
	"no-op when prompt + max_tokens already fits",
	clampMaxTokensToFit({ ...baseMessages, max_tokens: 100 }, 100_000) === undefined,
);

// Does not fit: must shrink and satisfy prompt + max_tokens + safety <= ctx.
const oversized = { messages: [{ role: "user", content: "x".repeat(40_000) }], max_tokens: 20_000 };
const oversizedCtx = 20_000;
const oversizedEstimate = estimatePromptTokens(oversized);
const oversizedNext = clampMaxTokensToFit(oversized, oversizedCtx);
check(
	"returns a smaller value when the request does not fit",
	oversizedNext !== undefined && oversizedNext < 20_000,
	String(oversizedNext),
);
check(
	"clamped request satisfies est + next + reserve <= contextWindow",
	oversizedNext !== undefined && oversizedEstimate + oversizedNext + requestReserveTokens(oversizedEstimate) <= oversizedCtx,
	`est=${oversizedEstimate} next=${oversizedNext} ctx=${oversizedCtx}`,
);

// Historical incident shape: ~250k-char tool-heavy prompt, 80k context,
// 8192 requested output. The estimator (chars/3.5 + 256) reports ~71685
// tokens, so the clamp must shrink max_tokens for the request to fit.
const incident = { messages: [{ role: "user", content: "x".repeat(250_000) }], max_tokens: 8192 };
const incidentCtx = 80_000;
const incidentEstimate = estimatePromptTokens(incident);
check(
	"incident payload estimates ~71685 tokens",
	Math.abs(incidentEstimate - 71_685) <= 100,
	`estimate=${incidentEstimate}`,
);
const incidentNext = clampMaxTokensToFit(incident, incidentCtx);
check(
	"incident: max_tokens shrinks below 8192",
	incidentNext !== undefined && incidentNext < 8192,
	String(incidentNext),
);
check(
	"incident: est + next + reserve <= 80000",
	incidentNext !== undefined && incidentEstimate + incidentNext + requestReserveTokens(incidentEstimate) <= incidentCtx,
	`est=${incidentEstimate} next=${incidentNext}`,
);

// The reserve must scale with the prompt: a fixed 4096 was consumed whole by the
// estimator's own error on a long tool-heavy turn.
check(
	"small prompt → flat floor reserve",
	requestReserveTokens(1_000) === REQUEST_SAFETY_TOKENS,
	String(requestReserveTokens(1_000)),
);
check(
	"large prompt → reserve grows with the estimate",
	requestReserveTokens(80_000) === Math.ceil(80_000 * PROMPT_SAFETY_RATIO) &&
		requestReserveTokens(80_000) > REQUEST_SAFETY_TOKENS,
	String(requestReserveTokens(80_000)),
);
check("no estimate → floor reserve", requestReserveTokens(0) === REQUEST_SAFETY_TOKENS);
check("invalid estimate → floor reserve", requestReserveTokens(Number.NaN) === REQUEST_SAFETY_TOKENS);

// Reported vLLM rejection (2026-11): ctx 98304, the server counted 75318 input
// tokens where the estimator said 71221 (+5.8%), so a request clamped to 22987
// output tokens landed at 98305 — one over. The clamp must now keep room for a
// tokenizer that is denser than the estimate.
const reportedCtx = 98_304;
const reportedRealPrompt = 75_318;
const reportedPayload = { messages: [{ role: "user", content: "x".repeat(248_378) }], max_tokens: 32_768 };
const reportedEstimate = estimatePromptTokens(reportedPayload);
const reportedNext = clampMaxTokensToFit(reportedPayload, reportedCtx);
check(
	"reported incident: the estimate reproduces ~71221 tokens",
	Math.abs(reportedEstimate - 71_221) <= 5,
	`est=${reportedEstimate}`,
);
check(
	"reported incident: clamped output + the real prompt count fits the window",
	reportedNext !== undefined && reportedRealPrompt + reportedNext <= reportedCtx,
	`next=${reportedNext} total=${reportedRealPrompt + (reportedNext ?? 0)}`,
);

// Same guarantee across window sizes: a tokenizer that counts 6% more tokens
// than the estimate (the observed bias) must still fit after the clamp.
{
	let ok = true;
	let detail = "";
	for (const ctx of [8_192, 32_768, 98_304, 200_000]) {
		for (const chars of [10_000, 100_000, 200_000, 240_000]) {
			const payload = { messages: [{ role: "user", content: "x".repeat(chars) }], max_tokens: 32_768 };
			const est = estimatePromptTokens(payload);
			const next = clampMaxTokensToFit(payload, ctx) ?? 32_768;
			const realPrompt = Math.ceil(est * 1.06);
			if (realPrompt + 1 > ctx) continue; // prompt alone already overflows
			if (realPrompt + next > ctx) {
				ok = false;
				detail = `ctx=${ctx} chars=${chars} est=${est} next=${next} real=${realPrompt}`;
			}
		}
	}
	check("a 6% denser tokenizer still fits after the clamp (all windows)", ok, detail);
}

// Never increases, even with ample room.
check(
	"never increases max_tokens (ample room → undefined)",
	clampMaxTokensToFit({ ...baseMessages, max_tokens: 1000 }, 100_000) === undefined,
);

// Absent / invalid max_tokens.
check("missing max_tokens → undefined", clampMaxTokensToFit({ ...baseMessages }, 8000) === undefined);
check(
	"non-finite max_tokens → undefined",
	clampMaxTokensToFit({ ...baseMessages, max_tokens: Number.NaN }, 8000) === undefined,
);
check(
	"non-positive contextWindow → undefined",
	clampMaxTokensToFit({ ...baseMessages, max_tokens: 1000 }, 0) === undefined,
);

// ── composeOnPayload ──────────────────────────────────────────────────────
// pi-ai calls onPayload with the final request body (tool schemas included),
// so this wrapper must preserve pi's own onPayload and clamp on top of it.

const clampCtx = 20_000;
const clampModel = { id: "test-model", contextWindow: clampCtx };
const needsClamp = () => ({ messages: [{ role: "user", content: "x".repeat(40_000) }], max_tokens: 20_000 });
const fits = () => ({ messages: [{ role: "user", content: "hello world" }] });

void (async () => {
	// 1. no prev -> clamps.
	{
		const p = needsClamp();
		const est = estimatePromptTokens(p);
		const out = await composeOnPayload(undefined, clampCtx)(p, clampModel);
		check(
			"composeOnPayload: no prev clamps max_tokens",
			typeof out.max_tokens === "number" && out.max_tokens < p.max_tokens,
			String(out.max_tokens),
		);
		check(
			"composeOnPayload: clamped result satisfies est + next + reserve <= ctx",
			est + out.max_tokens + requestReserveTokens(est) <= clampCtx,
			`est=${est} next=${out.max_tokens}`,
		);
	}

	// 2. prev rewrites the model and returns params -> rewrite preserved AND clamped.
	{
		const p = needsClamp();
		const prev = async (params: any) => ({ ...params, model: "rewritten-model" });
		const out = await composeOnPayload(prev, clampCtx)(p, clampModel);
		check("composeOnPayload: prev model rewrite preserved", out.model === "rewritten-model", String(out.model));
		check(
			"composeOnPayload: prev rewrite plus clamped max_tokens",
			typeof out.max_tokens === "number" && out.max_tokens < 20_000 && out !== p,
			String(out.max_tokens),
		);
		check("composeOnPayload: original params not mutated", p.max_tokens === 20_000 && p.model === undefined);
	}

	// 3. prev returns undefined -> original params clamped.
	{
		const p = needsClamp();
		const out = await composeOnPayload(async () => undefined, clampCtx)(p, clampModel);
		check(
			"composeOnPayload: prev undefined falls back to original params, still clamped",
			typeof out.max_tokens === "number" && out.max_tokens < 20_000 && out.messages === p.messages,
			String(out.max_tokens),
		);
	}

	// 4. missing / non-finite contextWindow -> unchanged.
	{
		const p = needsClamp();
		const out = await composeOnPayload(undefined, undefined)(p, clampModel);
		check("composeOnPayload: undefined contextWindow leaves params unchanged", out.max_tokens === 20_000 && out === p);
		const outNan = await composeOnPayload(undefined, Number.NaN)(p, clampModel);
		check("composeOnPayload: non-finite contextWindow leaves params unchanged", outNan.max_tokens === 20_000 && outNan === p);
		const outNull = await composeOnPayload(undefined, clampCtx)(null, clampModel);
		check("composeOnPayload: null params returned unchanged (no throw)", outNull === null);
		const outPrimitive = await composeOnPayload(undefined, clampCtx)("str", clampModel);
		check("composeOnPayload: primitive params returned unchanged (no throw)", outPrimitive === "str");
	}

	// 5. already-fitting prompt -> unchanged, no max_tokens injected when absent.
	{
		const p = fits();
		const out = await composeOnPayload(undefined, 100_000)(p, { id: "m", contextWindow: 100_000 });
		check("composeOnPayload: fitting prompt with no max_tokens -> no key injected", out === p && !("max_tokens" in out));
	}

	// 6. async prev is awaited.
	{
		const p = needsClamp();
		const prev = (params: any) => new Promise((resolve) => setTimeout(() => resolve({ ...params, model: "from-async" }), 5));
		const out = await composeOnPayload(prev, clampCtx)(p, clampModel);
		check("composeOnPayload: async prev awaited and its result adopted", out.model === "from-async", String(out.model));
		check(
			"composeOnPayload: async prev result still clamped",
			typeof out.max_tokens === "number" && out.max_tokens < 20_000,
			String(out.max_tokens),
		);
	}

	if (failures > 0) {
		console.error(`request-clamp tests failed: ${failures}`);
		process.exit(1);
	}
	console.log("request-clamp tests passed");
})();
