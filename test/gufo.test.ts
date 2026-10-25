// Behavior tests for gufo support (https://github.com/gufo-org, a llama.cpp fork):
// owned_by:"gufo" detection, the /props 400 it answers without ?model= plus the
// placeholder it answers with, the LM Studio catalog probes it must not receive,
// context_length as the only published context window, the llama-family compat
// profile (qwen chat-template thinking control + llama.cpp's budget field name),
// speculative decoding read off /slots (the only route that reports it), and the
// end-to-end registration of a gufo model.
// Uses a throwaway localhost HTTP server, no external network.
// Run: node --experimental-strip-types test/gufo.test.ts

import * as http from "node:http";
import {
	DEFAULT_MAX_OUTPUT_TOKENS,
	DEFAULT_SETTINGS,
	THINKING_BUDGET_FIELD,
	makeCompat,
	renameThinkingBudgetField,
	setActiveConfig,
	shared,
	supportsThinkingBudget,
	thinkingBudgetField,
} from "../src/core.ts";
import {
	buildModelMetadata,
	detectServerKind,
	fetchModelsFromEndpoint,
	fetchServerProps,
	fetchServerSlots,
	slotForModel,
} from "../src/scan.ts";
import { buildAndRegisterProvider } from "../src/registration.ts";
import type { InfraConfig, LlamaCppModel, ScanResult, ServerConfig } from "../src/types.ts";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
	if (cond) console.log(`  ✓ ${label}`);
	else {
		failures++;
		console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

// ── Throwaway gufo-ish HTTP server ─────────────────────────────────────────
// Payload shapes copied from a live gufo build serving a reasoning model, with the
// real model id replaced by a neutral placeholder (public repo, see CHANGELOG 1.8.1):
// /v1/models carries context_length (no meta.n_ctx), /props requires ?model= and
// answers with {template:"", model_info:{}} even then, /health is only {"status":"ok"},
// and there is no /config, /options or /version route at all.
const GUFO_ID = "Example-Reasoner";
const gufoEntry = (): LlamaCppModel => ({
	id: GUFO_ID,
	object: "model",
	created: 1792373464,
	owned_by: "gufo",
	context_length: 262144,
	architecture: { input_modalities: ["text", "image"] },
});

const hits: string[] = [];
const server = http.createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	hits.push(url.pathname);
	const send = (code: number, body: unknown): void => {
		res.writeHead(code, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	};
	if (url.pathname === "/v1/models") return send(200, { object: "list", data: [gufoEntry()] });
	if (url.pathname === "/props") {
		const model = url.searchParams.get("model");
		if (!model) {
			return send(400, {
				error: { message: "'model' query parameter is required", type: "invalid_request_error", code: "missing_model" },
			});
		}
		return send(200, { model, template: "", model_info: {} });
	}
	if (url.pathname === "/health") return send(200, { status: "ok" });
	if (url.pathname === "/ready") return send(200, { status: "ready", model: GUFO_ID });
	if (url.pathname === "/slots") {
		return send(200, [{ id: 0, n_ctx: 262144, speculative: true, is_processing: false, model: GUFO_ID }]);
	}
	return send(404, { error: { message: "no route for this path", type: "invalid_request_error", code: "not_found" } });
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const addr = server.address();
const port = typeof addr === "object" && addr ? addr.port : 0;
const baseUrl = `http://127.0.0.1:${port}/v1`;

// ── 1) kind detection ──────────────────────────────────────────────────────
console.log("gufo: detectServerKind");

check("owned_by gufo → gufo", (await detectServerKind(baseUrl, [gufoEntry()], undefined)) === "gufo");
check(
	"owned_by is matched case-insensitively",
	(await detectServerKind(baseUrl, [{ id: "x", owned_by: "GuFO" }], undefined)) === "gufo",
);
check(
	"plain llama.cpp list stays llama.cpp",
	(await detectServerKind(baseUrl, [{ id: "m", owned_by: "llama.cpp" }], undefined)) === "llamacpp",
);
check(
	"gufo wins over the llama.cpp fallthrough on a mixed list",
	(await detectServerKind(baseUrl, [{ id: "m", owned_by: "llama.cpp" }, gufoEntry()], undefined)) === "gufo",
);
check(
	"zinc keeps priority over gufo (zinc is read off the first model)",
	(await detectServerKind(baseUrl, [{ id: "z", owned_by: "zinc" }, gufoEntry()], undefined)) === "zinc",
);
check(
	"vLLM keeps priority over gufo",
	(await detectServerKind(baseUrl, [gufoEntry(), { id: "v", owned_by: "vllm" }], undefined)) === "vllm",
);

// ── 2) /props is unusable, and must not break the scan ─────────────────────
console.log("gufo: /props tolerance");

check("bare /props 400 → undefined", (await fetchServerProps(baseUrl, 2000)) === undefined);
check(
	"placeholder /props carries no context",
	JSON.stringify(await fetchServerProps(baseUrl, 2000, undefined, GUFO_ID)) ===
		JSON.stringify({ model: GUFO_ID, template: "", model_info: {} }),
	JSON.stringify(await fetchServerProps(baseUrl, 2000, undefined, GUFO_ID)),
);

// ── 3) one endpoint scan ───────────────────────────────────────────────────
console.log("gufo: endpoint scan");

setActiveConfig({ servers: [], settings: { ...DEFAULT_SETTINGS }, modelOptions: {} });
const srv: ServerConfig = { id: "gufo-host", host: "127.0.0.1", ports: [port], enabled: true };
hits.length = 0;
const ep = await fetchModelsFromEndpoint(srv, port, { ...DEFAULT_SETTINGS, detectVision: false }, new Map());

check("endpoint ok", ep.ok === true, ep.error);
check("endpoint kind is gufo", ep.server === "gufo", ep.server);
check("single-server mode", ep.mode === "single", ep.mode);
check("placeholder /props is not kept as endpoint props", ep.props === undefined, JSON.stringify(ep.props));
check("one /models request", hits.filter((h) => h === "/v1/models").length === 1, hits.join(","));
check("LM Studio catalog never probed", !hits.some((h) => h.startsWith("/api/")), hits.join(","));
check("gufo meta built from the model entry", ep.meta.get(GUFO_ID)?.vision === true, JSON.stringify(ep.meta.get(GUFO_ID)));
check("drafter read off /slots", ep.meta.get(GUFO_ID)?.drafter === "speculative", JSON.stringify(ep.meta.get(GUFO_ID)));
check("/slots probed exactly once", hits.filter((h) => h === "/slots").length === 1, hits.join(","));

// ── 4) per-model metadata ──────────────────────────────────────────────────
console.log("gufo: buildModelMetadata");

const meta = buildModelMetadata(GUFO_ID, gufoEntry(), undefined, undefined, "gufo");
check("architecture.input_modalities → vision", meta.vision === true, String(meta.vision));
check("no /props → no KV cache types", meta.cacheK === undefined && meta.cacheV === undefined, `${meta.cacheK}/${meta.cacheV}`);
// The drafter is absent here because no /slots entry was passed, which is what the
// next section covers.
check("no slot passed → no drafter", meta.drafter === undefined, String(meta.drafter));
check(
	"a text-only gufo model stays text-only",
	buildModelMetadata("plain", { id: "plain", owned_by: "gufo", context_length: 8192 }, undefined, undefined, "gufo").vision ===
		undefined,
);

// ── 5) compat profile ──────────────────────────────────────────────────────
console.log("gufo: compat + thinking field");

// Deliberate: the budget field is kept even though the live build (2026-10-19)
// enforces neither `thinking_budget_tokens` nor `reasoning_budget_tokens` — same
// reasoning length with and without it. It costs nothing, and it becomes live the
// moment a build honors the name. Thinking on/off is enforced and unaffected.
check("gufo advertises a thinking budget", supportsThinkingBudget("gufo") === true);
check(
	"gufo keeps llama.cpp's thinking_budget_tokens field",
	thinkingBudgetField("gufo") === THINKING_BUDGET_FIELD,
	String(thinkingBudgetField("gufo")),
);
const compat = makeCompat("gufo");
check("gufo → thinkingFormat qwen-chat-template", compat.thinkingFormat === "qwen-chat-template", String(compat.thinkingFormat));
check(
	"gufo → thinkingTokenBudgetField thinking_budget_tokens",
	compat.thinkingTokenBudgetField === "thinking_budget_tokens",
	String(compat.thinkingTokenBudgetField),
);
check("gufo streams usage", compat.supportsUsageInStreaming === true);
check(
	"no rename is needed on gufo's own field",
	renameThinkingBudgetField({ [THINKING_BUDGET_FIELD]: 1024 }, THINKING_BUDGET_FIELD) === undefined,
);
check("vLLM keeps its own field", thinkingBudgetField("vllm") === "thinking_token_budget", String(thinkingBudgetField("vllm")));

// ── 6) end-to-end registration ─────────────────────────────────────────────
console.log("gufo: registration");

setActiveConfig({
	servers: [{ id: "gufo-host", host: "127.0.0.1", ports: [port], enabled: true }],
	settings: { ...DEFAULT_SETTINGS },
	modelOptions: {},
});
shared.serverModelIds.clear();
shared.compactModelIds.clear();
shared.endpointKinds.clear();
shared.modelBaseUrls.clear();

let registered: any;
const pi: any = {
	unregisterProvider: () => undefined,
	registerProvider: (_name: string, cfg: any) => {
		registered = cfg;
	},
};

const regConfig: InfraConfig = {
	servers: [{ id: "gufo-host", host: "127.0.0.1", ports: [port], enabled: true }],
	settings: { ...DEFAULT_SETTINGS },
	modelOptions: {},
};

const gufoScan = (entry: LlamaCppModel): ScanResult => ({
	totalModels: 1,
	serversUp: 1,
	serversTotal: 1,
	endpoints: [
		{
			ok: true,
			serverId: "gufo-host",
			label: "gufo-host",
			host: "127.0.0.1",
			port,
			baseUrl: `http://127.0.0.1:${port}/v1`,
			server: "gufo",
			mode: "single",
			latencyMs: 1,
			models: [entry],
			meta: new Map([[entry.id, buildModelMetadata(entry.id, entry, undefined, undefined, "gufo")]]),
		},
	],
});

const models = buildAndRegisterProvider(pi, gufoScan(gufoEntry()), regConfig, { persistCache: false });
const model = models[0];
check("gufo model registered", model?.serverModelId === GUFO_ID, String(model?.serverModelId));
check("registered with context_length", model?.contextWindow === 262144, String(model?.contextWindow));
check(
	"max tokens fall back to the client cap (gufo publishes none)",
	model?.maxTokens === Math.min(262144, DEFAULT_MAX_OUTPUT_TOKENS),
	String(model?.maxTokens),
);
check("gufo is reasoning-capable", model?.reasoning === true, String(model?.reasoning));
check("vision → input includes image", model?.input.includes("image") === true, JSON.stringify(model?.input));
check(
	"registered compat carries the qwen chat-template thinking format",
	model?.compat?.thinkingFormat === "qwen-chat-template",
	String(model?.compat?.thinkingFormat),
);
check("provider streamSimple still wired", typeof registered?.streamSimple === "function");

// A gufo build that starts publishing max_tokens must win over the client cap.
const published = buildAndRegisterProvider(pi, gufoScan({ ...gufoEntry(), max_tokens: 4096 }), regConfig, {
	persistCache: false,
});
check("published max_tokens wins over the cap", published[0]?.maxTokens === 4096, String(published[0]?.maxTokens));

// ── 7) speculative decoding: /slots → the existing drafter label ────────────
console.log("gufo: /slots drafter translation");

const slots = await fetchServerSlots(baseUrl, 2000);
check("/slots parsed as a slot list", Array.isArray(slots) && slots.length === 1, JSON.stringify(slots));
check(
	"a server without /slots yields no slots, not a throw",
	(await fetchServerSlots(`http://127.0.0.1:${port}/v1/nope`, 2000)) === undefined,
);
check(
	"the slot naming the model wins",
	slotForModel([{ model: "other", speculative: true }, { model: GUFO_ID, speculative: false }], GUFO_ID)?.speculative === false,
);
check("a single slot is the model's slot even when unnamed", slotForModel([{ id: 0, speculative: true }], GUFO_ID)?.speculative === true);
check("no slots at all → no slot", slotForModel(undefined, GUFO_ID) === undefined && slotForModel([], GUFO_ID) === undefined);

const gufoSlotMeta = (speculative: boolean) =>
	buildModelMetadata(GUFO_ID, gufoEntry(), undefined, undefined, "gufo", undefined, { speculative });
check("speculative slot → 🚀 drafter", gufoSlotMeta(true).drafter === "speculative", JSON.stringify(gufoSlotMeta(true)));
check("speculative: false stays badge-free", gufoSlotMeta(false).drafter === undefined, String(gufoSlotMeta(false)));
check(
	"the slot is ignored for llama.cpp, which reads /props",
	buildModelMetadata("m", { id: "m", owned_by: "llama.cpp" }, undefined, undefined, "llamacpp", undefined, {
		speculative: true,
	}).drafter === undefined,
);

setActiveConfig({
	servers: [{ id: "gufo-host", host: "127.0.0.1", ports: [port], enabled: true }],
	settings: { ...DEFAULT_SETTINGS },
	modelOptions: { [GUFO_ID]: { drafter: "mtp-example-draft" } },
});
check(
	"a manual drafter override still wins over the slot",
	buildModelMetadata(GUFO_ID, gufoEntry(), undefined, undefined, "gufo", undefined, { speculative: true }).drafter ===
		"mtp-example-draft",
);
setActiveConfig({
	servers: [{ id: "gufo-host", host: "127.0.0.1", ports: [port], enabled: true }],
	settings: { ...DEFAULT_SETTINGS },
	modelOptions: {},
});

const endpoint = gufoScan(gufoEntry()).endpoints[0];
const drafted = buildAndRegisterProvider(
	pi,
	{ ...gufoScan(gufoEntry()), endpoints: [{ ...endpoint, meta: new Map([[GUFO_ID, gufoSlotMeta(true)]]) }] },
	regConfig,
	{ persistCache: false },
);
check("🚀 reaches the registered model name", drafted[0]?.name.includes("🚀") === true, String(drafted[0]?.name));

await new Promise<void>((resolve) => server.close(() => resolve()));

if (failures > 0) {
	console.error(`\ngufo tests failed: ${failures}`);
	process.exit(1);
}
console.log("\nAll gufo checks passed ✅");
