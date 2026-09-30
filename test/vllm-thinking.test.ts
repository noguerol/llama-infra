// Behavior tests for the per-model thinking-budget field (vLLM support without
// a proxy): the llama.cpp `thinking_budget_tokens` → `thinking_token_budget`
// rename, the `modelOptions[id].thinkingBudgetField` override, and the compat
// field pi uses to send its own level budget.
// Run: node --experimental-strip-types test/vllm-thinking.test.ts

import {
	DEFAULT_SETTINGS,
	makeCompat,
	renameThinkingBudgetField,
	resolveThinkingBudgetField,
	setActiveConfig,
	shared,
} from "../src/core.ts";
import { buildAndRegisterProvider } from "../src/registration.ts";
import type { InfraConfig, ScanResult } from "../src/types.ts";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
	if (cond) console.log(`  ✓ ${label}`);
	else {
		failures++;
		console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

// ── 1) resolveThinkingBudgetField: per-kind default + per-model override ───
console.log("vllm-thinking: field resolution");

setActiveConfig(undefined);
check("vLLM default → thinking_token_budget", resolveThinkingBudgetField(undefined, "vllm") === "thinking_token_budget");
check("llama.cpp default → thinking_budget_tokens", resolveThinkingBudgetField(undefined, "llamacpp") === "thinking_budget_tokens");
check("unknown kind, no override → undefined", resolveThinkingBudgetField("m", undefined) === undefined);

const config: InfraConfig = {
	servers: [],
	settings: { ...DEFAULT_SETTINGS },
	modelOptions: {
		"example-vllm-model": { thinkingBudgetField: "thinking_token_budget" },
		"force-custom-field": { thinkingBudgetField: "  reasoning_budget_tokens  " },
		"empty-override": { thinkingBudgetField: "   " },
	},
};
setActiveConfig(config);

check(
	"override wins over the per-kind default (unknown kind)",
	resolveThinkingBudgetField("example-vllm-model", undefined) === "thinking_token_budget",
);
check(
	"override wins over a different per-kind default (llamacpp mis-detected)",
	resolveThinkingBudgetField("example-vllm-model", "llamacpp") === "thinking_token_budget",
);
check(
	"override is trimmed",
	resolveThinkingBudgetField("force-custom-field", "llamacpp") === "reasoning_budget_tokens",
);
check(
	"blank override falls back to the per-kind default",
	resolveThinkingBudgetField("empty-override", "vllm") === "thinking_token_budget",
);
check(
	"unknown model id falls back to the per-kind default",
	resolveThinkingBudgetField("not-configured", "vllm") === "thinking_token_budget",
);

// ── 2) renameThinkingBudgetField: what vLLM silently drops ─────────────────
console.log("vllm-thinking: request field rename");

const renamed = renameThinkingBudgetField(
	{ model: "m", messages: [], thinking_budget_tokens: 2048, temperature: 0 },
	"thinking_token_budget",
);
check(
	"llama.cpp field renamed to the engine field",
	renamed?.thinking_token_budget === 2048 && renamed?.thinking_budget_tokens === undefined,
	JSON.stringify(renamed),
);
check("other payload keys preserved", renamed?.temperature === 0 && renamed?.model === "m");
check(
	"no rename when the engine field IS llama.cpp's",
	renameThinkingBudgetField({ thinking_budget_tokens: 10 }, "thinking_budget_tokens") === undefined,
);
check(
	"no rename when the client sent no budget",
	renameThinkingBudgetField({ messages: [] }, "thinking_token_budget") === undefined,
);
const both = renameThinkingBudgetField(
	{ thinking_budget_tokens: 100, thinking_token_budget: 200 },
	"thinking_token_budget",
);
check(
	"engine field wins when both are present (llama.cpp duplicate dropped, engine value kept)",
	both?.thinking_token_budget === 200 && both?.thinking_budget_tokens === undefined,
	JSON.stringify(both),
);

// ── 3) makeCompat carries the resolved field for pi ────────────────────────
console.log("vllm-thinking: compat field");

check(
	"makeCompat('vllm') exposes thinking_token_budget",
	makeCompat("vllm").thinkingTokenBudgetField === "thinking_token_budget",
);
check(
	"makeCompat override wins over the kind",
	makeCompat("llamacpp", "thinking_token_budget").thinkingTokenBudgetField === "thinking_token_budget",
);
check(
	"makeCompat('lmstudio') stays thinking-free",
	makeCompat("lmstudio").thinkingTokenBudgetField === undefined,
);

// ── 4) Registration applies the override to the registered model ───────────
console.log("vllm-thinking: registration");

shared.serverModelIds.clear();
shared.compactModelIds.clear();
shared.endpointKinds.clear();
shared.modelBaseUrls.clear();

let registeredProvider: any;
const pi: any = {
	unregisterProvider: () => undefined,
	registerProvider: (_name: string, cfg: any) => {
		registeredProvider = cfg;
	},
};

const regConfig: InfraConfig = {
	servers: [{ id: "bruma-2", host: "bruma", ports: [8082], enabled: true }],
	settings: { ...DEFAULT_SETTINGS },
	// vLLM whose kind detection failed (no owned_by) → override forces the field.
	modelOptions: { "Qwen3.8-27B": { thinkingBudgetField: "thinking_token_budget" } },
};
setActiveConfig(regConfig);

const scan: ScanResult = {
	totalModels: 1,
	serversUp: 1,
	serversTotal: 1,
	endpoints: [
		{
			ok: true,
			serverId: "bruma-2",
			label: "bruma",
			host: "bruma",
			port: 8082,
			baseUrl: "http://bruma:8082/v1",
			// Deliberately NOT vllm: the override is the only source of truth.
			server: "llamacpp",
			mode: "single",
			latencyMs: 1,
			models: [{ id: "Qwen3.8-27B", object: "model", owned_by: "unknown", meta: { n_ctx: 65536 } }],
			meta: new Map(),
		},
	],
};

const models = buildAndRegisterProvider(pi, scan, regConfig, { persistCache: false });
const model = models[0];
check(
	"compat.thinkingTokenBudgetField honors the per-model override",
	model?.compat?.thinkingTokenBudgetField === "thinking_token_budget",
	String(model?.compat?.thinkingTokenBudgetField),
);
check(
	"the per-level budget lands on the override field (llamacpp payload renamed)",
	renameThinkingBudgetField({ thinking_budget_tokens: 4096 }, model?.compat?.thinkingTokenBudgetField ?? "")?.thinking_token_budget === 4096,
);
check("provider streamSimple still wired", typeof registeredProvider?.streamSimple === "function");

if (failures > 0) {
	console.error(`\nvllm-thinking tests failed: ${failures}`);
	process.exit(1);
}
console.log("\nAll vllm-thinking checks passed ✅");
