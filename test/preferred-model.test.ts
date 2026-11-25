// Standalone behavior test for the model preference policy (issue #1):
// a session whose llama-infra model is offline moves to the highest-priority
// server that is actually online, and nothing else is ever touched.
//
// Run: node --experimental-strip-types test/preferred-model.test.ts

import { DEFAULT_SERVER_PRIORITY, choosePreferredModel, preferredModelOverride, serverPriority } from "../src/core.ts";
import type { EndpointResult, PiModel, ServerConfig } from "../src/types.ts";

let failures = 0;

function check(label: string, cond: boolean, detail?: string): void {
	if (cond) console.log(`  ✓ ${label}`);
	else {
		failures++;
		console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

function model(serverId: string, host: string, port: number, id = `${serverId}-model`): PiModel {
	return {
		id: `${id} (${host}:${port})`,
		name: id,
		baseUrl: `http://${host}:${port}/v1`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 8192,
		serverModelId: id,
		endpoint: { serverId, host, port, kind: "llamacpp", mode: "single" },
	};
}

function endpoint(serverId: string, host: string, port: number, ok: boolean, models = 1): EndpointResult {
	return {
		serverId,
		host,
		label: host,
		port,
		baseUrl: `http://${host}:${port}/v1`,
		server: "llamacpp",
		mode: "single",
		models: Array.from({ length: models }, (_, i) => ({ id: `m${i}` })),
		meta: new Map(),
		ok,
		...(ok ? {} : { error: "EHOSTUNREACH" }),
	};
}

const srv = (id: string, host: string, priority?: number, enabled = true): ServerConfig => ({
	id,
	host,
	ports: [8080],
	enabled,
	...(priority === undefined ? {} : { priority }),
});

console.log("preferred-model: server priority");
check("unset priority is the neutral default", serverPriority({}) === DEFAULT_SERVER_PRIORITY, String(serverPriority({})));
check("0 is honoured (the 'default' flag)", serverPriority({ priority: 0 }) === 0);
check("a higher number ranks later", serverPriority({ priority: 5 }) < serverPriority({ priority: 50 }));

console.log("preferred-model: choosePreferredModel");
{
	const servers = [srv("a", "host-a"), srv("b", "host-b", 0)];
	const models = [model("a", "host-a", 8080), model("b", "host-b", 8080)];
	const endpoints = [endpoint("a", "host-a", 8080, true), endpoint("b", "host-b", 8080, true)];
	const pick = choosePreferredModel(models, servers, endpoints);
	check("the lowest priority number wins over config order", pick?.endpoint.serverId === "b", pick?.id);
}
{
	const servers = [srv("a", "host-a"), srv("b", "host-b")];
	const models = [model("a", "host-a", 8080), model("b", "host-b", 8080)];
	const endpoints = [endpoint("a", "host-a", 8080, false), endpoint("b", "host-b", 8080, true)];
	const pick = choosePreferredModel(models, servers, endpoints);
	check("an offline server is skipped", pick?.endpoint.serverId === "b", pick?.id);
}
{
	const servers = [srv("a", "host-a"), srv("b", "host-b")];
	const models = [model("a", "host-a", 8080), model("b", "host-b", 8080)];
	const endpoints = [endpoint("a", "host-a", 8080, true), endpoint("b", "host-b", 8080, true)];
	const pick = choosePreferredModel(models, servers, endpoints);
	check("equal priority keeps config order", pick?.endpoint.serverId === "a", pick?.id);
}
{
	const servers = [srv("a", "host-a", 0, false), srv("b", "host-b", 50)];
	const models = [model("a", "host-a", 8080), model("b", "host-b", 8080)];
	const endpoints = [endpoint("a", "host-a", 8080, true), endpoint("b", "host-b", 8080, true)];
	check("a disabled server is skipped even with priority 0", choosePreferredModel(models, servers, endpoints)?.endpoint.serverId === "b");
}
{
	const servers = [srv("a", "host-a", 0), srv("b", "host-b")];
	const models = [model("a", "host-a", 8080), model("b", "host-b", 8080)];
	const endpoints = [endpoint("a", "host-a", 8080, true, 0), endpoint("b", "host-b", 8080, true)];
	check("an endpoint that serves no models is skipped", choosePreferredModel(models, servers, endpoints)?.endpoint.serverId === "b");
}
{
	check(
		"nothing online → no preferred model",
		choosePreferredModel([], [srv("a", "host-a")], [endpoint("a", "host-a", 8080, false)]) === undefined,
	);
	check("no servers at all → undefined", choosePreferredModel([], [], []) === undefined);
}

console.log("preferred-model: preferredModelOverride (when to switch)");
const provider = "llama-infra";
{
	const servers = [srv("a", "host-a"), srv("b", "host-b", 0)];
	const models = [model("a", "host-a", 8080), model("b", "host-b", 8080)];
	const endpoints = [endpoint("a", "host-a", 8080, true), endpoint("b", "host-b", 8080, true)];

	const online = { id: models[0].id, provider };
	check(
		"an online selection is respected (no switch)",
		preferredModelOverride(online, models, servers, endpoints, provider) === undefined,
	);

	const offlineId = `${models[0].name} (host-zzz:9999)`;
	const offline = { id: offlineId, provider };
	check(
		"an offline llama-infra model moves to the preferred server",
		preferredModelOverride(offline, models, servers, endpoints, provider)?.endpoint.serverId === "b",
	);

	check(
		"another provider's model is never touched",
		preferredModelOverride({ id: "claude-x", provider: "anthropic" }, models, servers, endpoints, provider) === undefined,
	);
	check("no current model → no switch", preferredModelOverride(undefined, models, servers, endpoints, provider) === undefined);
	check(
		"nothing online → no switch (nothing better to move to)",
		preferredModelOverride(offline, [], servers, [endpoint("a", "host-a", 8080, false)], provider) === undefined,
	);
}

if (failures > 0) {
	console.error(`preferred-model tests failed: ${failures}`);
	process.exit(1);
}
console.log("preferred-model: all checks passed");
