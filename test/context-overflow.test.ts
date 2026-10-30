// Standalone behavior test for the context-overflow self-healing retry.
// Run: node --experimental-strip-types test/context-overflow.test.ts

import {
	OVERFLOW_SAFETY_TOKENS,
	composeOnPayload,
	createLongTimeoutOpenAICompletionsStream,
	estimatePromptTokens,
	overflowRetryMaxTokens,
	parseContextOverflow,
} from "../src/runtime.ts";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { DEFAULT_SETTINGS, setActiveConfig, shared } from "../src/core.ts";
import type { InfraConfig } from "../src/types.ts";

let failures = 0;

function check(label: string, cond: boolean, detail?: string): void {
	if (cond) console.log(`  ✓ ${label}`);
	else {
		failures++;
		console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

console.log("context-overflow: parse + retry cap + hard max_tokens");

// ── Real vLLM rejection (luna:200000, prompt 167233, max_tokens 32768) ────
const vllmError =
	'400: {"message":"This model\'s maximum context length is 200000\n tokens. However, you requested 32768 output tokens and your prompt contains\n at least 167233 input tokens, for a total of at least 200001 tokens. Please\n reduce the length of the input prompt or the number of requested output\n tokens. (parameter=input_tokens,\n value=167233)","type":"BadRequestError","param":"input_tokens","code":400}';

const report = parseContextOverflow(vllmError);
check("parses the reported prompt size", report?.inputTokens === 167_233, String(report?.inputTokens));
check("parses the served context window", report?.contextWindow === 200_000, String(report?.contextWindow));

const cap = overflowRetryMaxTokens(vllmError, 200_000, 32_768);
check(
	"retry cap satisfies reported prompt + cap + safety <= ctx",
	cap !== undefined && 167_233 + cap + OVERFLOW_SAFETY_TOKENS <= 200_000,
	String(cap),
);
check("retry cap is below the max_tokens that failed", cap !== undefined && cap < 32_768, String(cap));

// Already asking for less than the fit → a retry would just repeat the request.
check(
	"no retry when the request already asks for less than the fit",
	overflowRetryMaxTokens(vllmError, 200_000, 2048) === undefined,
);

// ── Parsing variants ──────────────────────────────────────────────────────
const sglangError = "The prompt is too long: 210000 input tokens > 200000 max_model_len";
const sg = parseContextOverflow(sglangError);
check("parses '<N> input tokens' phrasing", sg?.inputTokens === 210_000, String(sg?.inputTokens));
check("parses max_model_len as the window", sg?.contextWindow === 200_000, String(sg?.contextWindow));

const commas = parseContextOverflow("maximum context length is 262,144 tokens; prompt tokens: 250,000");
check("parses thousands separators", commas?.inputTokens === 250_000 && commas.contextWindow === 262_144, JSON.stringify(commas));

// Missing window in the body → fall back to the registered model window.
const noWindow = overflowRetryMaxTokens("prompt is too long: 6000 input tokens", 16_384, 8192);
check(
	"falls back to the model contextWindow",
	noWindow !== undefined && 6000 + noWindow + OVERFLOW_SAFETY_TOKENS <= 16_384,
	String(noWindow),
);

// ── Must NOT retry unrelated errors ──────────────────────────────────────
const unrelated = [
	"400: not supported by the native worker: thinking_token_budget",
	"400 status code (no body)",
	"400: tool schema is invalid",
	"401: bad api key",
	"ThrottlingException: Too many tokens, please wait before trying again (rate limit)",
];
for (const text of unrelated) {
	check(`not an overflow: ${text.slice(0, 42)}`, parseContextOverflow(text) === undefined);
}
check("no window at all → no retry", overflowRetryMaxTokens("prompt is too long: 6000 input tokens", undefined, 4096) === undefined);
check("empty error → no retry", overflowRetryMaxTokens("", 200_000, 4096) === undefined);

// ── composeOnPayload hard ceiling (the retry's lever) ────────────────────
const fitting = { messages: [{ role: "user", content: "hello" }], max_tokens: 32_768 };
const ctx = 200_000;
void (async () => {
	const est = estimatePromptTokens(fitting);
	check("precondition: the estimate alone says the request fits", est + 32_768 + 4096 <= ctx, `est=${est}`);

	const forced = await composeOnPayload(undefined, ctx, undefined, 28_671)(fitting, { id: "m", contextWindow: ctx });
	check("hard cap is applied even when the estimate says it fits", forced.max_tokens === 28_671, String(forced.max_tokens));
	const smaller = await composeOnPayload(undefined, ctx, undefined, 28_671)({ ...fitting, max_tokens: 2048 }, { id: "m" });
	check("hard cap respects a smaller max_tokens", smaller.max_tokens === 2048, String(smaller.max_tokens));

	const absent = await composeOnPayload(undefined, ctx, undefined, 28_671)({ messages: fitting.messages }, { id: "m" });
	check("hard cap injects max_tokens when the payload had none", absent.max_tokens === 28_671, String(absent.max_tokens));

	const noCap = await composeOnPayload(undefined, ctx)({ ...fitting, max_tokens: 1000 }, { id: "m" });
	check("no hard cap → payload untouched", noCap.max_tokens === 1000);
	check("zero hard cap is ignored", (await composeOnPayload(undefined, ctx, undefined, 0)({ ...fitting, max_tokens: 5 }, { id: "m" })).max_tokens === 5);

	await endToEndOverflowRetry();

	if (failures > 0) {
		console.error(`context-overflow tests failed: ${failures}`);
		process.exit(1);
	}
	console.log("context-overflow checks passed ✅");
})();

// ── End-to-end: a real vLLM 400 is retried once and the turn succeeds ────
async function endToEndOverflowRetry(): Promise<void> {
	const seen: Array<Record<string, any>> = [];
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		let raw = "";
		req.on("data", (piece) => (raw += piece));
		req.on("end", () => {
			let body: Record<string, any> = {};
			try {
				body = JSON.parse(raw || "{}");
			} catch {
				// ignore
			}
			seen.push(body);
			if (seen.length === 1) {
				// Exactly what luna:200000 answered: prompt 167233 + 32768 > 200000.
				res.writeHead(400, { "content-type": "application/json" });
				// OpenAI SDK shape: pi-ai surfaces `error.error` as the 400 body, which is
				// how the real `400: {"message":…,"param":"input_tokens"}` reached the model.
				res.end(
					JSON.stringify({
						error: {
							message:
								"This model's maximum context length is 200000 tokens. However, you requested 32768 output tokens and your prompt contains at least 167233 input tokens, for a total of at least 200001 tokens. (parameter=input_tokens, value=167233)",
							type: "BadRequestError",
							param: "input_tokens",
							code: 400,
						},
					}),
				);
				return;
			}
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			const chunk = (delta: unknown, finish: string | null) =>
				`data: ${JSON.stringify({
					id: "chatcmpl-test",
					object: "chat.completion.chunk",
					created: 1,
					model: "qwen",
					choices: [{ index: 0, delta, finish_reason: finish }],
				})}\n\n`;
			res.write(chunk({ role: "assistant", content: "recortado" }, null));
			res.write(chunk({}, "stop"));
			res.write("data: [DONE]\n\n");
			res.end();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;

	try {
		const modelId = `qwen (127.0.0.1:${port})`;
		const config: InfraConfig = { servers: [], settings: { ...DEFAULT_SETTINGS }, modelOptions: {} };
		setActiveConfig(config);
		shared.serverModelIds.clear();
		shared.compactModelIds.clear();
		shared.modelBaseUrls.clear();
		shared.endpointKinds.clear();
		shared.serverModelIds.set(modelId, "qwen");
		shared.compactModelIds.set("qwen", modelId);
		shared.modelBaseUrls.set(modelId, `http://127.0.0.1:${port}/v1`);

		const model: any = {
			id: modelId,
			name: "qwen",
			api: "openai-completions",
			provider: "llama-infra",
			baseUrl: `http://127.0.0.1:${port}/v1`,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 32_768,
			compat: { maxTokensField: "max_tokens", supportsUsageInStreaming: true, supportsStrictMode: false },
		};
		shared.lastModels = [model];

		const events: any[] = [];
		const stream = createLongTimeoutOpenAICompletionsStream(
			model,
			{ messages: [{ role: "user", content: "hola" }] },
			{ apiKey: "no-auth", maxTokens: 32_768 },
		);
		for await (const event of stream) events.push(event);
		await stream.result();

		check(
			"e2e: the turn completes despite the overflow 400",
			events.filter((e) => e?.type === "error").length === 0,
			JSON.stringify(events.filter((e) => e?.type === "error")).slice(0, 300),
		);
		check(
			"e2e: the answer is streamed after the retry",
			events.some((e) => e?.type === "text_delta" && e.delta === "recortado"),
			JSON.stringify(events.map((e) => e.type)),
		);
		check("e2e: exactly two requests were sent", seen.length === 2, String(seen.length));
		check("e2e: the first request asked for the failing max_tokens", seen[0]?.max_tokens === 32_768, String(seen[0]?.max_tokens));
		check(
			"e2e: the retry asks for the max_tokens that fits the reported prompt",
			seen[1]?.max_tokens === 200_000 - 167_233 - OVERFLOW_SAFETY_TOKENS,
			String(seen[1]?.max_tokens),
		);
		check(
			"e2e: the retry keeps model and messages intact",
			seen[1]?.model === "qwen" && Array.isArray(seen[1]?.messages),
			JSON.stringify(seen[1] ?? {}).slice(0, 200),
		);
	} finally {
		server.close();
	}
}
