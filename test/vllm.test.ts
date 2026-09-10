// Behavior tests for vLLM support: server-kind detection, the thinking-budget
// compat field, /metrics normalization for the `vllm:` namespace, and provider
// registration (contextWindow from max_model_len). No external network:
// detection + registration run in-process; metrics use a local fake /metrics
// server, mirroring test/metrics.test.ts.
// Run: node --experimental-strip-types test/vllm.test.ts

import * as http from "node:http";
import { DEFAULT_SETTINGS, supportsThinkingBudget, thinkingBudgetField } from "../src/core.ts";
import { createMetrics } from "../src/metrics.ts";
import { buildAndRegisterProvider } from "../src/registration.ts";
import { detectServerKind } from "../src/scan.ts";
import type { InfraConfig, LlamaCppModel, ScanResult, ServerMetricsState } from "../src/types.ts";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
	if (cond) console.log(`  ✓ ${label}`);
	else {
		failures++;
		console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

// ── 1) Detection (src/scan.ts::detectServerKind) ───────────────────────────
console.log("vllm: server-kind detection");

const vllmPayload = {
	object: "list",
	data: [
		{
			id: "example-vllm-model",
			object: "model",
			owned_by: "vllm",
			max_model_len: 262144,
			root: "/srv/models/target",
		},
	],
};
check(
	"vLLM /v1/models payload → vllm",
	(await detectServerKind(
		"http://127.0.0.1:8081/v1",
		vllmPayload.data as LlamaCppModel[],
		undefined,
	)) === "vllm",
);

const llamaPayload = {
	object: "list",
	data: [
		{
			id: "/srv/models/example-q4_k_m.gguf",
			object: "model",
			owned_by: "llamacpp",
			meta: { n_ctx: 120064, n_ctx_train: 262144 },
		},
	],
};
check(
	"llama.cpp /v1/models payload → llamacpp (regression)",
	(await detectServerKind(
		"http://127.0.0.1:8082/v1",
		llamaPayload.data as LlamaCppModel[],
		undefined,
	)) === "llamacpp",
);

// ── 2) Thinking-budget compat field (src/core.ts) ──────────────────────────
console.log("vllm: thinking budget field per kind");

check("thinkingBudgetField('vllm') → thinking_token_budget", thinkingBudgetField("vllm") === "thinking_token_budget");
check(
	"thinkingBudgetField('llamacpp') → thinking_budget_tokens",
	thinkingBudgetField("llamacpp") === "thinking_budget_tokens",
);
check("thinkingBudgetField('lmstudio') → undefined", thinkingBudgetField("lmstudio") === undefined);
check("supportsThinkingBudget('vllm') → true", supportsThinkingBudget("vllm") === true);

// ── 3) /metrics normalization (src/metrics.ts) ─────────────────────────────
// parsePrometheusMetrics() is module-private (not exported) and changing
// metrics.ts is out of scope, so we exercise the real exported path instead:
// createMetrics() polls a fake /metrics server and reports ServerMetricsState.
// Absolute t/s values are timing-based, so the label-aggregation check uses the
// ratio promptTps/genTps — deltaSec cancels, making it timing-independent.
console.log("vllm: /metrics `vllm:` namespace normalization");

async function collectStates(
	server: http.Server,
	count: number,
	intervalMs: number,
): Promise<ServerMetricsState[]> {
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
	const port = (server.address() as { port: number }).port;
	const baseUrl = `http://127.0.0.1:${port}/v1`;
	const states: ServerMetricsState[] = [];
	const ctx: any = { model: { provider: "llama-infra", id: "vllm-metrics-test", baseUrl } };
	const poller = createMetrics({
		isActive: () => true,
		pollIntervalMs: () => intervalMs,
		enabled: () => true,
		onServerState: (_ctx, st) => {
			if (st) states.push(st);
		},
	});
	poller.start(ctx);
	const deadline = Date.now() + 6000;
	while (states.length < count && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
	poller.stop(ctx);
	await new Promise<void>((r) => server.close(() => r()));
	return states;
}

function metricsServer(body: () => string): http.Server {
	return http.createServer((req, res) => {
		if (req.url === "/metrics") {
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end(body());
			return;
		}
		res.writeHead(404, { "Content-Type": "text/plain" });
		res.end("not found");
	});
}

// Two label series of vllm:generation_tokens_total (+100 and +300 per scrape →
// 400 when summed, 300 if only the last series wins) plus one prompt series
// (+200). Correct aggregation gives promptTps/genTps ≈ 200/400 = 0.5 for any
// deltaSec; a broken parser gives 200/300 ≈ 0.667 or 200/100 = 2.
let genA = 1000;
let genB = 3000;
let promptVllm = 500;
const vllmStates = await collectStates(
	metricsServer(() => {
		genA += 100;
		genB += 300;
		promptVllm += 200;
		return [
			`vllm:generation_tokens_total{engine="0",model_name="example-vllm-model"} ${genA}`,
			`vllm:generation_tokens_total{engine="0",model_name="example-vllm-model-copy"} ${genB}`,
			`vllm:prompt_tokens_total{engine="0",model_name="example-vllm-model"} ${promptVllm}`,
			`vllm:num_requests_running{engine="0",model_name="example-vllm-model"} 2`,
		].join("\n");
	}),
	3,
	150,
);

check("vllm:num_requests_running → processing 2", vllmStates[0]?.processing === 2, String(vllmStates[0]?.processing));

const vllmRate = vllmStates.find((s) => s.genTps !== undefined && s.promptTps !== undefined);
check(
	"vllm: namespace stripped → generation/prompt counters recognized",
	vllmRate !== undefined && (vllmRate.genTps ?? 0) > 0 && (vllmRate.promptTps ?? 0) > 0,
	JSON.stringify(vllmRate),
);
const vllmRatio = vllmRate?.genTps ? (vllmRate.promptTps ?? 0) / vllmRate.genTps : NaN;
check(
	"two label series of the same metric aggregate (prompt/gen ≈ 200/400)",
	Number.isFinite(vllmRatio) && vllmRatio > 0.45 && vllmRatio < 0.55,
	`ratio=${vllmRatio}`,
);

// llama.cpp regression: unlabeled `llamacpp:` lines must still parse.
// +200 / +60 → ratio 200/60 ≈ 3.33; requests_processing is read bare.
let promptLlamacpp = 3000;
let predictedLlamacpp = 120;
const llamaStates = await collectStates(
	metricsServer(() =>
		[
			`llamacpp:prompt_tokens_total ${(promptLlamacpp += 200)}`,
			`llamacpp:predicted_tokens_total ${(predictedLlamacpp += 60)}`,
			`llamacpp:requests_processing 3`,
		].join("\n"),
	),
	3,
	150,
);
check("llama.cpp unlabeled lines still parse (processing 3)", llamaStates[0]?.processing === 3, String(llamaStates[0]?.processing));

const llamaRate = llamaStates.find((s) => s.genTps !== undefined && s.promptTps !== undefined);
const llamaRatio = llamaRate?.genTps ? (llamaRate.promptTps ?? 0) / llamaRate.genTps : NaN;
check(
	"llama.cpp unlabeled counters parse (prompt/gen ≈ 200/60)",
	Number.isFinite(llamaRatio) && llamaRatio > 3.0 && llamaRatio < 3.7,
	`ratio=${llamaRatio}`,
);

// ── 4) Registration (src/registration.ts::buildAndRegisterProvider) ────────
console.log("vllm: provider registration");

let registeredProvider: any;
const pi: any = {
	unregisterProvider: () => undefined,
	registerProvider: (_name: string, config: any) => {
		registeredProvider = config;
	},
};

const config: InfraConfig = {
	servers: [{ id: "vllm-local", host: "127.0.0.1", ports: [8081], enabled: true }],
	settings: { ...DEFAULT_SETTINGS },
	modelOptions: {},
};

const scan: ScanResult = {
	totalModels: 1,
	serversUp: 1,
	serversTotal: 1,
	endpoints: [
		{
			ok: true,
			serverId: "vllm-local",
			label: "vLLM local",
			host: "127.0.0.1",
			port: 8081,
			baseUrl: "http://127.0.0.1:8081/v1",
			server: "vllm",
			mode: "single",
			latencyMs: 1,
			models: [
				{
					id: "example-vllm-model",
					object: "model",
					owned_by: "vllm",
					max_model_len: 262144,
					root: "/srv/models/target",
				},
			],
			meta: new Map(),
		},
	],
};

const models = buildAndRegisterProvider(pi, scan, config, { persistCache: false });
const vllmModel = models.find((m) => m.serverModelId === "example-vllm-model");

check(
	"contextWindow comes from max_model_len (no meta.n_ctx)",
	vllmModel?.contextWindow === 262144,
	String(vllmModel?.contextWindow),
);
check("reasoning enabled for vLLM", vllmModel?.reasoning === true);
check(
	"compat.thinkingTokenBudgetField === thinking_token_budget",
	vllmModel?.compat?.thinkingTokenBudgetField === "thinking_token_budget",
	String(vllmModel?.compat?.thinkingTokenBudgetField),
);
check("endpoint kind recorded as vllm", vllmModel?.endpoint?.kind === "vllm");
check("provider streamSimple still wired", typeof registeredProvider?.streamSimple === "function");

if (failures > 0) {
	console.error(`\nvllm tests failed: ${failures}`);
	process.exit(1);
}
console.log("\nAll vllm checks passed ✅");
