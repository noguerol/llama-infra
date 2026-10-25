// Standalone behavior test for model activation (src/model-switch.ts).
// Covers: query → model resolution, adopting a model that replaced the session's
// vanished one, and never sending a decorated id we cannot map.
// Run: node --experimental-strip-types test/model-switch.test.ts

import { DEFAULT_SETTINGS } from "../src/core.ts";
import {
	detectVanishedModel,
	endpointTags,
	hostTagOf,
	pickModel,
	resolveStaleServerModelId,
	suggestIds,
	withoutHostTag,
} from "../src/model-switch.ts";
import { buildAndRegisterProvider } from "../src/registration.ts";
import type { InfraConfig, PiModel, ScanResult } from "../src/types.ts";

let failures = 0;

function check(label: string, cond: boolean, detail?: string): void {
	if (cond) console.log(`  ✓ ${label}`);
	else {
		failures++;
		console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

function model(id: string, over: Partial<PiModel> = {}): PiModel {
	return {
		id,
		name: id,
		baseUrl: "http://127.0.0.1:8080/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262144,
		maxTokens: 32768,
		serverModelId: id,
		endpoint: { serverId: "local", host: "127.0.0.1", port: 8080, kind: "gufo", mode: "single" },
		...over,
	};
}

console.log("model-switch: activate a discovered model");

// ── 1) tags ────────────────────────────────────────────────────────────────
check("hostTagOf reads the (host:port) tag", hostTagOf("Foo (127.0.0.1:8080)") === "127.0.0.1:8080");
check("hostTagOf returns undefined for a raw id", hostTagOf("orcarouter/Foo") === undefined);
check("withoutHostTag strips only the tag", withoutHostTag("Foo (127.0.0.1:8080)") === "Foo");
check(
	"endpointTags covers every configured port",
	endpointTags([{ id: "local", host: "127.0.0.1", ports: [8080, 1234], enabled: true }]).has("127.0.0.1:1234"),
);

// ── 2) query resolution ────────────────────────────────────────────────────
const models: PiModel[] = [
	model("Qwen3.8-Flash-Next-Uncensored (127.0.0.1:8080)", { serverModelId: "orcarouter/Qwen3.8-Flash-Next-Uncensored" }),
	model("Qwen3.8-Flash-Next (192.168.1.9:8080)", { serverModelId: "Qwen3.8 Flash Next" }),
	model("DeepSeek-R1 (127.0.0.1:8080)", { serverModelId: "deepseek-r1.gguf" }),
];

check("exact registered id wins", pickModel(models, models[0].id).matches[0]?.id === models[0].id);
check(
	"raw server id resolves the model",
	pickModel(models, "orcarouter/Qwen3.8-Flash-Next-Uncensored").matches[0]?.id === models[0].id,
);
check(
	"separator-insensitive fragment resolves one model",
	pickModel(models, "flash next uncensored").matches.map((m) => m.id).join() === models[0].id,
	JSON.stringify(pickModel(models, "flash next uncensored").matches.map((m) => m.id)),
);
check(
	"a bare fragment matching several endpoints stays ambiguous instead of guessing",
	pickModel(models, "flash next").matches.length === 2,
	JSON.stringify(pickModel(models, "flash next").matches.map((m) => m.id)),
);
check("an unknown query matches nothing", pickModel(models, "llama-70b").matches.length === 0);
check(
	"an unloaded router model loses to the loaded one",
	pickModel(
		[model("Foo (a:8080)"), model("Foo (b:8080)", { routerStatus: "not loaded" })],
		"foo",
	).matches[0]?.id === "Foo (a:8080)",
);
check("empty query matches nothing (so the caller can list)", pickModel(models, "").matches.length === 0);
check(
	"a failed query still suggests close ids",
	suggestIds(models, "uncensr").length > 0 && suggestIds(models, "uncensr")[0].includes("Uncensored"),
	JSON.stringify(suggestIds(models, "uncensr")),
);

// ── 3) adopting the model that replaced ours ───────────────────────────────
const onGufo = model("Qwen3.8-Flash-Next-Uncensored (127.0.0.1:8080)");
const swapped = model("Qwen3.8 Flash Next (127.0.0.1:8080)", { serverModelId: "Qwen3.8 Flash Next" });
const otherHost = model("Other (192.168.1.9:8080)");

const van = detectVanishedModel([onGufo], [swapped], onGufo.id);
check("a vanished model is detected", van?.gone.id === onGufo.id);
check(
	"its replacement on the same endpoint is the only candidate",
	van?.candidates.map((m) => m.id).join() === swapped.id,
	JSON.stringify(van?.candidates.map((m) => m.id)),
);
check(
	"a model that is still served needs no repair",
	detectVanishedModel([onGufo], [onGufo, otherHost], onGufo.id) === undefined,
);
check(
	"a foreign provider's model is never adopted",
	detectVanishedModel([onGufo], [swapped], "claude-opus-4") === undefined,
);
check(
	"several replacements are reported instead of auto-picked",
	detectVanishedModel([onGufo], [swapped, model("Second (127.0.0.1:8080)")], onGufo.id)?.candidates.length === 2,
);
check(
	"candidates never cross endpoints",
	detectVanishedModel([onGufo], [model("Other", { endpoint: { serverId: "nas", host: "192.168.1.9", port: 8080, kind: "gufo", mode: "single" } })], onGufo.id)?.candidates.length === 0,
);

// ── 4) a decorated id we cannot map must not go out blind ─────────────────
const ids = new Map<string, string>([
	["Foo (127.0.0.1:8080)", "orcarouter/foo"],
	["Bar", "bare-bar"],
	["Foo (10.8.0.3:8080)", "vpn-foo"],
]);
check("the plain mapping still wins", ids.get("Foo (127.0.0.1:8080)") === "orcarouter/foo");
check(
	"an untagged registration is never matched to a tagged id",
	resolveStaleServerModelId("Bar (127.0.0.1:8080)", new Map([["Bar", "bare-bar"]])) === undefined,
);
check("recovery does not cross hosts", resolveStaleServerModelId("Foo (127.0.0.1:8080)", new Map([["Foo (10.8.0.3:8080)", "vpn-foo"]])) === undefined);
check("an undecorated id is left alone", resolveStaleServerModelId("deepseek-r1.gguf", ids) === undefined);
check(
	"an id differing only in spacing before the tag still recovers",
	resolveStaleServerModelId("Foo  (127.0.0.1:8080)", new Map([["Foo (127.0.0.1:8080)", "orcarouter/foo"]])) === "orcarouter/foo",
);
check(
	"a different model on the same endpoint is not recovered",
	resolveStaleServerModelId("Qwen3.8-Flash-Next (127.0.0.1:8080)", new Map([["Qwen3.8-Flash-Next-Uncensored (127.0.0.1:8080)", "orcarouter/uncensored"]])) === undefined,
);

// ── 5) end to end: the swapped-in model is pickable by name ───────────────
const pi: any = { unregisterProvider: () => undefined, registerProvider: () => undefined };
const config: InfraConfig = {
	servers: [{ id: "local", host: "127.0.0.1", ports: [8080], enabled: true }],
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
			serverId: "local",
			host: "127.0.0.1",
			port: 8080,
			baseUrl: "http://127.0.0.1:8080/v1",
			server: "gufo",
			mode: "single",
			latencyMs: 2,
			models: [
				{
					id: "orcarouter/Qwen3.8-Flash-Next-Uncensored",
					owned_by: "gufo",
					context_length: 262144,
					architecture: { input_modalities: ["text", "image"] },
				},
			],
			meta: new Map(),
		},
	],
};
const registered = buildAndRegisterProvider(pi, scan, config, { persistCache: false });
check("the swapped model registers", registered.length === 1, String(registered.length));
check(
	"its registered name keeps the flavor word",
	registered[0]?.id.includes("Uncensored"),
	registered[0]?.id,
);
check(
	"the raw served id is preserved for the request payload",
	registered[0]?.serverModelId === "orcarouter/Qwen3.8-Flash-Next-Uncensored",
	registered[0]?.serverModelId,
);
check(
	"'use uncensored' picks it",
	pickModel(registered, "uncensored").matches[0]?.id === registered[0]?.id,
	JSON.stringify(pickModel(registered, "uncensored").matches.map((m) => m.id)),
);
check(
	"the two models are now distinguishable by name",
	registered[0]?.id !== "Qwen3.8-Flash-Next (127.0.0.1:8080)",
	registered[0]?.id,
);

if (failures > 0) {
	console.error(`model-switch tests failed: ${failures}`);
	process.exit(1);
}
console.log("model-switch tests passed");
