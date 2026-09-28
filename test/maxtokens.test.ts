// Standalone behavior test for the per-model output-token override.
// Run: node --experimental-strip-types test/maxtokens.test.ts

import { DEFAULT_SETTINGS, setActiveConfig } from "../src/core.ts";
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

console.log("registration: per-model maxTokens override");

let registeredProvider: any;
const pi: any = {
	unregisterProvider: () => undefined,
	registerProvider: (_name: string, config: any) => {
		registeredProvider = config;
	},
};

const config: InfraConfig = {
	servers: [{ id: "bruma", host: "bruma", ports: [8082], enabled: true }],
	settings: { ...DEFAULT_SETTINGS, maxOutputTokens: 32768 },
	modelOptions: {
		// (a) display/registered-name key with the ` (host:port)` suffix.
		"Qwen3.8-27B (bruma:8082)": { maxTokens: 8192 },
		// (b) raw server-id key.
		"Raw-Key-27B": { maxTokens: 8192 },
		// (c) larger than the context window -> clamped.
		"Clamp-Override": { maxTokens: 200000 },
		// (e) invalid values must be ignored.
		"Zero-Override": { maxTokens: 0 },
		"Neg-Override": { maxTokens: -5 },
		"NaN-Override": { maxTokens: NaN },
		// (g) override must win over the server-reported max_tokens.
		"Server-Max-Overridden": { maxTokens: 8192 },
	},
};

setActiveConfig(config);

const scan: ScanResult = {
	totalModels: 9,
	serversUp: 1,
	serversTotal: 1,
	endpoints: [
		{
			ok: true,
			serverId: "bruma",
			host: "bruma",
			port: 8082,
			baseUrl: "http://bruma:8082/v1",
			server: "vllm",
			mode: "single",
			latencyMs: 1,
			models: [
				{ id: "Qwen3.8-27B", max_model_len: 80000 },
				{ id: "Raw-Key-27B", max_model_len: 80000 },
				{ id: "Clamp-Override", max_model_len: 80000 },
				{ id: "No-Override", max_model_len: 131072 },
				{ id: "Zero-Override", max_model_len: 131072 },
				{ id: "Neg-Override", max_model_len: 131072 },
				{ id: "NaN-Override", max_model_len: 131072 },
				{ id: "Server-Max", max_model_len: 131072, max_tokens: 65536 },
				{ id: "Server-Max-Overridden", max_model_len: 131072, max_tokens: 65536 },
			],
			meta: new Map(),
		},
	],
};

const models = buildAndRegisterProvider(pi, scan, config, { persistCache: false });
const byServerId = new Map(models.map((m) => [m.serverModelId, m]));
const cap = (id: string) => byServerId.get(id)?.maxTokens;

check(
	"(a) override keyed by display id '<raw> (host:port)' wins -> 8192",
	cap("Qwen3.8-27B") === 8192,
	String(cap("Qwen3.8-27B")),
);
check("(b) override keyed by raw server id wins -> 8192", cap("Raw-Key-27B") === 8192, String(cap("Raw-Key-27B")));
check(
	"(c) override 200000 on contextWindow 80000 is clamped -> 80000",
	cap("Clamp-Override") === 80000,
	String(cap("Clamp-Override")),
);
check(
	"(d) no override on 131072 ctx -> global settings.maxOutputTokens 32768",
	cap("No-Override") === 32768,
	String(cap("No-Override")),
);
check("(e) invalid override 0 is ignored -> 32768", cap("Zero-Override") === 32768, String(cap("Zero-Override")));
check("(e) invalid override -5 is ignored -> 32768", cap("Neg-Override") === 32768, String(cap("Neg-Override")));
check("(e) invalid override NaN is ignored -> 32768", cap("NaN-Override") === 32768, String(cap("NaN-Override")));
check(
	"(f) server-reported max_tokens 65536 respected when no override -> 65536",
	cap("Server-Max") === 65536,
	String(cap("Server-Max")),
);
check(
	"(g) override 8192 WINS over server-reported max_tokens 65536 -> 8192",
	cap("Server-Max-Overridden") === 8192,
	String(cap("Server-Max-Overridden")),
);
check("provider was registered", typeof registeredProvider?.streamSimple === "function");

if (failures > 0) {
	console.error(`maxtokens tests failed: ${failures}`);
	process.exit(1);
}
console.log("maxtokens tests passed");
