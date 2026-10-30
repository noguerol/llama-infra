// End-to-end behavior test for the self-healing thinking-budget retry.
//
// A strict engine (vLLM fork whose "native worker" validates request fields)
// answers HTTP 400 `not supported by the native worker: thinking_token_budget`
// when pi sends the budget field. The
// provider stream must then: remember the opt-out, retry ONCE without the
// field, and still deliver the answer — instead of surfacing the error.
//
// Run: node --experimental-strip-types test/thinking-heal.test.ts

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, setActiveConfig, shared } from "../src/core.ts";
import { createLongTimeoutOpenAICompletionsStream } from "../src/runtime.ts";
import type { InfraConfig } from "../src/types.ts";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
	if (cond) console.log(`  ✓ ${label}`);
	else {
		failures++;
		console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

const REJECTION_MESSAGE =
	"not supported by the native worker: thinking_token_budget";

/** Error body in the shape strict engines actually return (OpenAI SDK parses it,
 *  so pi-ai emits `start` and THEN the `error` event — the case that matters). */
function strictError(res: ServerResponse, message: string, body = true): void {
	res.writeHead(400, { "content-type": "application/json" });
	res.end(body ? JSON.stringify({ error: { message, type: "BadRequestError", code: 400 } }) : "");
}

/** Minimal OpenAI-compatible SSE chat-completion response. */
function streamAnswer(res: ServerResponse, text: string): void {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	const chunk = (delta: unknown, finish: string | null) =>
		`data: ${JSON.stringify({
			id: "chatcmpl-test",
			object: "chat.completion.chunk",
			created: 1,
			model: "strict-worker",
			choices: [{ index: 0, delta, finish_reason: finish }],
		})}\n\n`;
	res.write(chunk({ role: "assistant", content: text }, null));
	res.write(chunk({}, "stop"));
	res.write("data: [DONE]\n\n");
	res.end();
}

interface Seen {
	bodies: Array<Record<string, unknown>>;
}

const seen: Seen = { bodies: [] };
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
	let raw = "";
	req.on("data", (piece) => {
		raw += piece;
	});
	req.on("end", () => {
		let body: Record<string, unknown> = {};
		try {
			body = JSON.parse(raw || "{}");
		} catch {
			// ignore
		}
		seen.bodies.push(body);
		const asked = JSON.stringify(body.messages ?? "");
		const hasBudget =
			body.thinking_token_budget !== undefined || body.thinking_budget_tokens !== undefined;
		if (asked.includes("context-overflow")) {
			// A 400 that has nothing to do with the budget field: dropping it cannot
			// help, so the retry must fail too and the original error must surface.
			strictError(res, "prompt is too long: 140000 tokens > 98304 maximum");
			return;
		}
		if (asked.includes("no-body-400") && hasBudget) {
			// Strict engine behind a transport that drops the response body: pi-ai
			// reports "400 status code (no body)", so the field name is nowhere in the
			// message. The retry (no field) succeeds below.
			strictError(res, "", false);
			return;
		}
		if (hasBudget && !asked.includes("no-body-400")) {
			// Exactly the strict-worker rejection: HTTP 400 + the field name.
			strictError(res, REJECTION_MESSAGE);
			return;
		}
		streamAnswer(res, "hola");
	});
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const baseUrl = `http://127.0.0.1:${port}/v1`;

// Point the config persistence at a throwaway dir: the self-healing opt-out must
// be written to disk, but never to the developer's real ~/.pi/agent file.
const tmpAgentDir = mkdtempSync(join(tmpdir(), "llama-infra-heal-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = tmpAgentDir;

const modelId = `strict-worker (127.0.0.1:${port})`;
const config: InfraConfig = {
	servers: [],
	settings: { ...DEFAULT_SETTINGS },
	modelOptions: {},
};
setActiveConfig(config);
shared.serverModelIds.clear();
shared.compactModelIds.clear();
shared.modelBaseUrls.clear();
shared.endpointKinds.clear();
shared.serverModelIds.set(modelId, "strict-worker");
shared.compactModelIds.set("strict-worker", modelId);
shared.modelBaseUrls.set(modelId, baseUrl);
shared.endpointKinds.set(baseUrl, "vllm");

let providerPid = "";

try {
	console.log("thinking-heal: strict worker rejects thinking_token_budget");

	const model: any = {
		id: modelId,
		name: "strict-worker",
		api: "openai-completions",
		provider: "llama-infra",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 98_304,
		maxTokens: 8_192,
		compat: {
			maxTokensField: "max_tokens",
			supportsUsageInStreaming: true,
			supportsStrictMode: false,
			thinkingTokenBudgetField: "thinking_token_budget",
			supportsThinkingTokenBudget: false,
		},
	};
	shared.lastModels = [model];

	const events: any[] = [];
	const stream = createLongTimeoutOpenAICompletionsStream(
		model,
		{ messages: [{ role: "user", content: "hola" }] },
		{ apiKey: "no-auth", reasoning: "medium", thinkingBudgets: { medium: 1024 } },
	);
	for await (const event of stream) events.push(event);
	await stream.result();

	const errorEvents = events.filter((e) => e?.type === "error");
	check("the turn completes despite the rejection", errorEvents.length === 0, JSON.stringify(errorEvents).slice(0, 300));
	check(
		"the answer is streamed after the retry",
		events.some((e) => e?.type === "text_delta" && e.delta === "hola"),
		JSON.stringify(events.map((e) => e.type)),
	);
	check("two requests were sent (original + one retry)", seen.bodies.length === 2, String(seen.bodies.length));
	check(
		"the first request carried the budget field",
		seen.bodies[0]?.thinking_token_budget === 1024,
		JSON.stringify(seen.bodies[0] ?? {}).slice(0, 200),
	);
	check(
		"the retry carried no budget field at all",
		seen.bodies[1]?.thinking_token_budget === undefined &&
			seen.bodies[1]?.thinking_budget_tokens === undefined,
		JSON.stringify(seen.bodies[1] ?? {}).slice(0, 200),
	);
	check(
		"the retry keeps the rest of the request intact",
		seen.bodies[1]?.model === "strict-worker" && Array.isArray(seen.bodies[1]?.messages),
		JSON.stringify(seen.bodies[1] ?? {}).slice(0, 200),
	);
	check(
		"the in-memory model remembers the opt-out (no re-fail next turn)",
		model.compat?.thinkingTokenBudgetField === false && model.compat?.supportsThinkingTokenBudget === false,
		JSON.stringify(model.compat),
	);
	check(
		"the opt-out is persisted for the next scan",
		config.modelOptions[modelId]?.thinkingBudgetField === false,
		JSON.stringify(config.modelOptions),
	);
	let persisted: any;
	try {
		persisted = JSON.parse(readFileSync(join(tmpAgentDir, "llama-infra.json"), "utf-8"));
	} catch {
		persisted = undefined;
	}
	check(
		"the opt-out reached the config file",
		persisted?.modelOptions?.[modelId]?.thinkingBudgetField === false,
		JSON.stringify(persisted?.modelOptions),
	);

	// Second turn: no field, no rejection, a single request.
	seen.bodies.length = 0;
	const events2: any[] = [];
	const stream2 = createLongTimeoutOpenAICompletionsStream(
		model,
		{ messages: [{ role: "user", content: "otra vez" }] },
		{ apiKey: "no-auth", reasoning: "medium", thinkingBudgets: { medium: 1024 } },
	);
	for await (const event of stream2) events2.push(event);
	check("the second turn streams normally", events2.some((e) => e?.type === "text_delta" && e.delta === "hola"));
	check("the second turn sends exactly one request", seen.bodies.length === 1, String(seen.bodies.length));
	check(
		"the second turn sends no budget field",
		seen.bodies[0]?.thinking_token_budget === undefined,
		JSON.stringify(seen.bodies[0] ?? {}).slice(0, 200),
	);
	// ── Negative path: an unrelated 400 is NOT healed ──────────────────────
	console.log("thinking-heal: unrelated client errors still surface");

	const otherId = `overflow-model (127.0.0.1:${port})`;
	const otherConfig: InfraConfig = { servers: [], settings: { ...DEFAULT_SETTINGS }, modelOptions: {} };
	setActiveConfig(otherConfig);
	shared.serverModelIds.set(otherId, "overflow-model");
	shared.compactModelIds.set("overflow-model", otherId);
	shared.modelBaseUrls.set(otherId, baseUrl);

	const otherModel: any = {
		id: otherId,
		name: "overflow-model",
		api: "openai-completions",
		provider: "llama-infra",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 98_304,
		maxTokens: 8_192,
		compat: {
			maxTokensField: "max_tokens",
			supportsUsageInStreaming: true,
			thinkingTokenBudgetField: "thinking_token_budget",
		},
	};
	seen.bodies.length = 0;
	const events3: any[] = [];
	const stream3 = createLongTimeoutOpenAICompletionsStream(
		otherModel,
		{ messages: [{ role: "user", content: "context-overflow please" }] },
		{ apiKey: "no-auth", reasoning: "medium", thinkingBudgets: { medium: 1024 } },
	);
	for await (const event of stream3) events3.push(event);
	check("the unrelated 400 still surfaces as an error", events3.some((e) => e?.type === "error"));
	check("the turn did not stream an answer", !events3.some((e) => e?.type === "text_delta"));
	check("the retry ran once (field dropped) before surfacing", seen.bodies.length === 2, String(seen.bodies.length));
	check(
		"no opt-out was persisted for the unrelated error",
		otherConfig.modelOptions[otherId]?.thinkingBudgetField === undefined,
		JSON.stringify(otherConfig.modelOptions),
	);
	check(
		"the model still keeps its budget field for the next turn",
		otherModel.compat?.thinkingTokenBudgetField === "thinking_token_budget",
		JSON.stringify(otherModel.compat),
	);

	// ── Body-less 400: still healed (the field name is nowhere in the error) ──
	console.log("thinking-heal: body-less 400 is healed too");

	const noBodyId = `no-body-model (127.0.0.1:${port})`;
	const noBodyConfig: InfraConfig = { servers: [], settings: { ...DEFAULT_SETTINGS }, modelOptions: {} };
	setActiveConfig(noBodyConfig);
	shared.serverModelIds.set(noBodyId, "no-body-model");
	shared.compactModelIds.set("no-body-model", noBodyId);
	shared.modelBaseUrls.set(noBodyId, baseUrl);

	const noBodyModel: any = {
		id: noBodyId,
		name: "no-body-model",
		api: "openai-completions",
		provider: "llama-infra",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 98_304,
		maxTokens: 8_192,
		compat: {
			maxTokensField: "max_tokens",
			supportsUsageInStreaming: true,
			thinkingTokenBudgetField: "thinking_token_budget",
		},
	};
	seen.bodies.length = 0;
	const events4: any[] = [];
	const stream4 = createLongTimeoutOpenAICompletionsStream(
		noBodyModel,
		{ messages: [{ role: "user", content: "no-body-400 please" }] },
		{ apiKey: "no-auth", reasoning: "medium", thinkingBudgets: { medium: 1024 } },
	);
	for await (const event of stream4) events4.push(event);
	check("the body-less 400 did not surface as an error", !events4.some((e) => e?.type === "error"));
	check(
		"the answer streamed after the retry",
		events4.some((e) => e?.type === "text_delta" && e.delta === "hola"),
		JSON.stringify(events4.map((e) => e.type)),
	);
	check("a single retry was enough", seen.bodies.length === 2, String(seen.bodies.length));
	check(
		"the retry dropped the field",
		seen.bodies[1]?.thinking_token_budget === undefined,
		JSON.stringify(seen.bodies[1] ?? {}).slice(0, 200),
	);
	check(
		"the opt-out was persisted after the successful retry",
		noBodyConfig.modelOptions[noBodyId]?.thinkingBudgetField === false,
		JSON.stringify(noBodyConfig.modelOptions),
	);
	check(
		"the model remembers the opt-out",
		noBodyModel.compat?.thinkingTokenBudgetField === false,
		JSON.stringify(noBodyModel.compat),
	);

} finally {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(tmpAgentDir, { recursive: true, force: true });
}

if (failures > 0) {
	console.error(`\nthinking-heal tests failed: ${failures}`);
	process.exit(1);
}
console.log("\nAll thinking-heal checks passed ✅");
