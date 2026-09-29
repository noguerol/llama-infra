// Standalone behavior test for the tools-aware request-time max_tokens clamp.
// Run: node --experimental-strip-types test/request-clamp.test.ts

import {
	REQUEST_SAFETY_TOKENS,
	clampMaxTokensToFit,
	estimatePromptTokens,
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
	"estimate scales with message text length (≈chars/4)",
	longEstimate - shortEstimate >= 900 && longEstimate - shortEstimate <= 1100,
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
	"adding a large tools array raises the estimate by ≈JSON chars/4",
	Math.abs(toolsDelta - toolsJsonChars / 4) <= 2,
	`delta=${toolsDelta} json/4=${toolsJsonChars / 4}`,
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
	"clamped request satisfies est + next + REQUEST_SAFETY_TOKENS <= contextWindow",
	oversizedNext !== undefined && oversizedEstimate + oversizedNext + REQUEST_SAFETY_TOKENS <= oversizedCtx,
	`est=${oversizedEstimate} next=${oversizedNext} ctx=${oversizedCtx}`,
);

// Reported incident: ~71809-token prompt, 80k context, 8192 requested output.
// content length 286208 + role "user" (4) = 286212 chars → ceil/4 = 71553,
// + 256 overhead = 71809 estimated prompt tokens.
const incident = { messages: [{ role: "user", content: "x".repeat(286_208) }], max_tokens: 8192 };
const incidentCtx = 80_000;
const incidentEstimate = estimatePromptTokens(incident);
check(
	"incident payload estimates ~71809 tokens",
	Math.abs(incidentEstimate - 71_809) <= 1,
	`estimate=${incidentEstimate}`,
);
const incidentNext = clampMaxTokensToFit(incident, incidentCtx);
check(
	"incident: max_tokens shrinks below 8192",
	incidentNext !== undefined && incidentNext < 8192,
	String(incidentNext),
);
check(
	"incident: est + next + REQUEST_SAFETY_TOKENS <= 80000",
	incidentNext !== undefined && incidentEstimate + incidentNext + REQUEST_SAFETY_TOKENS <= incidentCtx,
	`est=${incidentEstimate} next=${incidentNext}`,
);

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

if (failures > 0) {
	console.error(`request-clamp tests failed: ${failures}`);
	process.exit(1);
}
console.log("request-clamp tests passed");
