// Behavior tests for the per-model thinking-budget field (vLLM support without
// a proxy): the llama.cpp `thinking_budget_tokens` → `thinking_token_budget`
// rename, the `modelOptions[id].thinkingBudgetField` override, and the compat
// field pi uses to send its own level budget.
// Run: node --experimental-strip-types test/vllm-thinking.test.ts

import {
	DEFAULT_SETTINGS,
	disableThinkingBudgetField,
	makeCompat,
	parseThinkingBudgetFieldOption,
	renameThinkingBudgetField,
	resolveThinkingBudgetField,
	setActiveConfig,
	shared,
	stripThinkingBudgetFields,
	thinkingBudgetFieldDisabled,
} from "../src/core.ts";
import { composeOnPayload, rejectsThinkingBudgetField } from "../src/runtime.ts";
import { buildAndRegisterProvider } from "../src/registration.ts";
import type { InfraConfig, ScanResult } from "../src/types.ts";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
	servers: [{ id: "gpu-host-2", host: "gpu-host", ports: [8000], enabled: true }],
	settings: { ...DEFAULT_SETTINGS },
	// vLLM whose kind detection failed (no owned_by) → override forces the field.
	modelOptions: { "Example-27B": { thinkingBudgetField: "thinking_token_budget" } },
};
setActiveConfig(regConfig);

const scan: ScanResult = {
	totalModels: 1,
	serversUp: 1,
	serversTotal: 1,
	endpoints: [
		{
			ok: true,
			serverId: "gpu-host-2",
			label: "gpu-host",
			host: "gpu-host",
			port: 8000,
			baseUrl: "http://gpu-host:8000/v1",
			// Deliberately NOT vllm: the override is the only source of truth.
			server: "llamacpp",
			mode: "single",
			latencyMs: 1,
			models: [{ id: "Example-27B", object: "model", owned_by: "unknown", meta: { n_ctx: 65536 } }],
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


// ── 5) Opt-out: `thinkingBudgetField: false` sends NO field at all ────────
// A strict engine (vLLM fork with a custom native worker)
// answers HTTP 400 to unknown request fields: the budget field must vanish.
console.log("vllm-thinking: opt-out (field disabled)");

check("parse: false stays false", parseThinkingBudgetFieldOption(false) === false);
check("parse: 'none' → disabled", parseThinkingBudgetFieldOption(" none ") === false);
check("parse: 'off' → disabled", parseThinkingBudgetFieldOption("off") === false);
check("parse: 'disabled' → disabled", parseThinkingBudgetFieldOption("disabled") === false);
check("parse: blank → auto (undefined)", parseThinkingBudgetFieldOption("   ") === undefined);
check(
	"parse: field name kept (trimmed)",
	parseThinkingBudgetFieldOption("  thinking_budget ") === "thinking_budget",
);

const optOut: InfraConfig = {
	servers: [],
	settings: { ...DEFAULT_SETTINGS },
	modelOptions: {
		"strict-worker (gpu-host:8081)": { thinkingBudgetField: false },
		"typed-none": { thinkingBudgetField: "none" },
	},
};
setActiveConfig(optOut);
check(
	"opt-out wins over the vLLM kind default",
	resolveThinkingBudgetField("strict-worker (gpu-host:8081)", "vllm") === undefined,
);
check("opt-out is detected by thinkingBudgetFieldDisabled (raw id)", thinkingBudgetFieldDisabled("strict-worker") === true);

const disabledCompat = makeCompat("vllm", false);
check(
	"makeCompat(kind, false) exposes the opt-out to pi",
	disabledCompat.thinkingTokenBudgetField === false && disabledCompat.supportsThinkingTokenBudget === false,
	JSON.stringify(disabledCompat),
);
check(
	"makeCompat with a field name still works",
	makeCompat("vllm", "thinking_budget").thinkingTokenBudgetField === "thinking_budget",
);

const stripped = stripThinkingBudgetFields({
	model: "m",
	messages: [],
	thinking_budget_tokens: 1024,
	thinking_token_budget: 2048,
	max_tokens: 64,
});
check(
	"stripThinkingBudgetFields drops both known fields, keeps the rest",
	stripped?.thinking_budget_tokens === undefined &&
		stripped?.thinking_token_budget === undefined &&
		stripped?.max_tokens === 64,
	JSON.stringify(stripped),
);
check(
	"stripThinkingBudgetFields returns undefined when there is nothing to strip",
	stripThinkingBudgetFields({ messages: [] }) === undefined,
);

// Registration: the opt-out must reach `compat` (pi reads it there).
const optOutConfig: InfraConfig = {
	servers: [{ id: "gpu-host-3", host: "gpu-host", ports: [8081], enabled: true }],
	settings: { ...DEFAULT_SETTINGS },
	modelOptions: { "Strict-Worker-Model": { thinkingBudgetField: false } },
};
setActiveConfig(optOutConfig);
const optOutScan: ScanResult = {
	totalModels: 1,
	serversUp: 1,
	serversTotal: 1,
	endpoints: [
		{
			ok: true,
			serverId: "gpu-host-3",
			label: "gpu-host",
			host: "gpu-host",
			port: 8081,
			baseUrl: "http://gpu-host:8081/v1",
			server: "vllm",
			mode: "single",
			latencyMs: 1,
			models: [{ id: "Strict-Worker-Model", object: "model", owned_by: "vllm", max_model_len: 98304 }],
			meta: new Map(),
		},
	],
};
const optOutModels = buildAndRegisterProvider(pi, optOutScan, optOutConfig, { persistCache: false });
check(
	"registered compat disables the field for the opted-out model",
	optOutModels[0]?.compat?.thinkingTokenBudgetField === false,
	String(optOutModels[0]?.compat?.thinkingTokenBudgetField),
);
check(
	"registered compat also disables pi's own alias (supportsThinkingTokenBudget)",
	optOutModels[0]?.compat?.supportsThinkingTokenBudget === false,
	String(optOutModels[0]?.compat?.supportsThinkingTokenBudget),
);

// ── 6) Self-healing detection of "server rejects the field" errors ────────
console.log("vllm-thinking: rejection detection + payload strip");

const REJECTION =
	"400 Error: not supported by the native worker: thinking_token_budget";
check("the reported native-worker error is recognized", rejectsThinkingBudgetField(REJECTION));
check("llama.cpp's field name is recognized too", rejectsThinkingBudgetField("unknown field thinking_budget_tokens"));
check(
	"an unrelated error is not recognized",
	rejectsThinkingBudgetField("prompt is too long: 140000 > 98304") === false,
);
check(
	"a bare field name without a rejection verb is ignored",
	rejectsThinkingBudgetField("thinking_token_budget") === false,
);
check("an empty error is ignored", rejectsThinkingBudgetField(undefined) === false);

// composeOnPayload must be able to strip the field on the retry, and still clamp.
const composeStrip = composeOnPayload(
	async (params: any) => ({ ...params, thinking_budget_tokens: 4096 }),
	2048,
	["thinking_token_budget"],
);
const composedPayload: any = await composeStrip(
	{ model: "m", messages: [{ role: "user", content: "hi" }], max_tokens: 10_000 },
	{},
);
check(
	"stripFields removes the prev-injected budget field",
	composedPayload.thinking_budget_tokens === undefined && composedPayload.thinking_token_budget === undefined,
	JSON.stringify(composedPayload),
);
check(
	"the max_tokens clamp still applies after stripping",
	composedPayload.max_tokens < 10_000,
	String(composedPayload.max_tokens),
);

// ── 7) Persisted opt-out (self-healing writes it to the config) ───────────
console.log("vllm-thinking: self-healing persistence");

const tmpAgentDir = mkdtempSync(join(tmpdir(), "llama-infra-thinking-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
try {
	const healConfig: InfraConfig = {
		servers: [],
		settings: { ...DEFAULT_SETTINGS },
		modelOptions: { "strict-worker (gpu-host:8081)": { thinkingBudgets: { low: 1024 } } },
	};
	setActiveConfig(healConfig);
	check("disableThinkingBudgetField reports a change", disableThinkingBudgetField("strict-worker") === true);
	check(
		"the opt-out is stored on the matching modelOptions key",
		healConfig.modelOptions["strict-worker (gpu-host:8081)"]?.thinkingBudgetField === false,
	);
	check(
		"sibling options survive",
		healConfig.modelOptions["strict-worker (gpu-host:8081)"]?.thinkingBudgets?.low === 1024,
	);
	const persisted = JSON.parse(readFileSync(join(tmpAgentDir, "llama-infra.json"), "utf-8"));
	check(
		"the opt-out is persisted to disk",
		persisted.modelOptions?.["strict-worker (gpu-host:8081)"]?.thinkingBudgetField === false,
		JSON.stringify(persisted.modelOptions),
	);
	check("disabling twice is a no-op", disableThinkingBudgetField("strict-worker") === false);
	setActiveConfig(undefined);
	check("no active config → nothing to disable", disableThinkingBudgetField("strict-worker") === false);
} finally {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(tmpAgentDir, { recursive: true, force: true });
}

if (failures > 0) {
	console.error(`\nvllm-thinking tests failed: ${failures}`);
	process.exit(1);
}
console.log("\nAll vllm-thinking checks passed ✅");
