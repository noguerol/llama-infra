// Standalone wiring test for model ACTIVATION (src/index.ts).
//
// Reproduces the reported failure end to end: a server is live with model A, the
// session is on A, the operator stops A and starts A-Uncensored on the same port
// without restarting pi. The extension must (a) discover the new model, (b) get the
// session onto it instead of leaving a dead id selected, (c) activate on demand with
// `/llama-infra use`, and (d) refuse to send an id it cannot map without saying so.
//
// Isolated: PI_CODING_AGENT_DIR points at a temp dir, so no real config, models
// cache or warmup file is touched, and the only endpoint is a local fake gufo.
// Run: node --experimental-strip-types test/activate.test.ts

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

const agentDir = mkdtempSync(join(tmpdir(), "llama-infra-activate-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
	if (cond) console.log(`  ✓ ${label}`);
	else {
		failures++;
		console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

// ── fake gufo: one model at a time, /props is a placeholder like gufo's ─────
let served: { id: string } = { id: "Alpha Model" };
const notifications: string[] = [];
const server = http.createServer((req, res) => {
	const path = (req.url ?? "").split("?")[0];
	if (path === "/v1/models") {
		res.writeHead(200, { "content-type": "application/json" });
		return res.end(
			JSON.stringify({
				object: "list",
				data: [{ id: served.id, object: "model", created: 1, owned_by: "gufo", context_length: 131072 }],
			}),
		);
	}
	if (path === "/slots") {
		res.writeHead(200, { "content-type": "application/json" });
		return res.end(JSON.stringify([{ id: 0, n_ctx: 131072, speculative: true, model: served.id }]));
	}
	res.writeHead(400, { "content-type": "application/json" });
	res.end(JSON.stringify({ error: "model parameter required" }));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r as () => void));
const port = (server.address() as { port: number }).port;

// ── config for the extension under test, pointed at the fake server only ───
writeFileSync(
	join(agentDir, "llama-infra.json"),
	JSON.stringify({
		servers: [{ id: "test", host: "127.0.0.1", ports: [port], enabled: true }],
		settings: {
			detectVision: false,
			warmup: false,
			metricsEnabled: false,
			costTracking: false,
			showBadgesInNames: false,
			prefixModelIds: true,
			discoveryTimeoutMs: 1500,
			rescanIntervalMs: 700,
		},
		modelOptions: {},
	}),
	"utf-8",
);

const { shared } = await import("../src/core.ts");
const extensionFactory = (await import("../src/index.ts")).default;

// ── pi stub: record registrations, commands, event handlers, setModel ──────
const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void>; completions?: (p: string) => any }>();
const handlers = new Map<string, Array<(e: any, c: any) => any>>();
const setModelCalls: string[] = [];
let registeredModels: any[] = [];

const ui = {
	notify: (m: string) => notifications.push(String(m)),
	setStatus: () => undefined,
};
const registry = new Map<string, any>();
const mkCtx = (modelId?: string): any => ({
	hasUI: true,
	cwd: process.cwd(),
	ui,
	model: modelId ? { id: modelId, provider: "llama-infra" } : undefined,
	modelRegistry: { find: (_p: string, id: string) => registry.get(id) },
	getSystemPrompt: () => "test prompt",
});

const pi: any = new Proxy(
	{
		registerCommand: (name: string, opts: any) => commands.set(name, { handler: opts.handler, completions: opts.getArgumentCompletions }),
		on: (event: string, handler: (e: any, c: any) => any) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerProvider: (_n: string, cfg: any) => {
			registeredModels = cfg.models ?? [];
			for (const m of registeredModels) registry.set(m.id, m);
		},
		unregisterProvider: () => undefined,
		setModel: async (model: any) => {
			setModelCalls.push(model.id);
			return true;
		},
	},
	{ get: (t, k: string) => (k in t ? (t as any)[k] : () => undefined) },
);

const fire = async (event: string, e: any, ctx: any) => {
	for (const h of handlers.get(event) ?? []) {
		try {
			await h(e, ctx);
		} catch (err) {
			// warmup/metrics stubs may reject; activation assertions don't depend on them
		}
	}
};

const runRequest = async (payload: Record<string, unknown>) => {
	let current: Record<string, unknown> = payload;
	const results: Array<Record<string, unknown>> = [];
	for (const h of handlers.get("before_provider_request") ?? []) {
		const r: any = await h({ type: "before_provider_request", payload: current }, mkCtx(undefined));
		if (r && typeof r === "object") {
			results.push(r);
			current = { ...current, ...r };
		}
	}
	return results;
};

async function waitFor(cond: () => boolean, ms = 4000): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (cond()) return true;
		await new Promise((r) => setTimeout(r, 40));
	}
	return cond();
}

console.log("activate: a swapped model reaches the session without restarting pi");

extensionFactory(pi);

const tag = `(127.0.0.1:${port})`;
const idA = `Alpha Model ${tag}`;
const idB = `Alpha-Uncensored ${tag}`;

check("model A is discovered at boot", await waitFor(() => shared.lastModels.some((m: any) => m.id === idA)), JSON.stringify(shared.lastModels.map((m: any) => m.id)));

// The session picks model A, exactly as pi does at startup.
await fire("session_start", { type: "session_start" }, mkCtx(idA));

// ── 1) `/llama-infra use` on a model that is not there yet ─────────────────
const cmd = commands.get("llama-infra")!;
check("the command is registered", !!cmd?.handler);
const completions = cmd.completions?.("") ?? [];
check("completions offer `use`", completions.some((c: any) => c.value === "use"), JSON.stringify(completions.map((c: any) => c.value)));
check(
	"`use ` completes a discovered id",
	(cmd.completions?.("use alpha") ?? []).some((c: any) => String(c.value).startsWith("use ")),
);

notifications.length = 0;
await cmd.handler("use uncensored", mkCtx(idA));
check(
	"an unknown model is refused with suggestions, not activated",
	notifications.some((n) => n.includes("nothing matches")) && setModelCalls.length === 0,
	JSON.stringify(notifications),
);

// ── 2) the operator swaps the model on the same port ──────────────────────
served = { id: "orcarouter/Alpha-Uncensored" };
await cmd.handler("scan", mkCtx(idA));
check("the new model is discovered", await waitFor(() => shared.lastModels.some((m: any) => m.id === idB)), JSON.stringify(shared.lastModels.map((m: any) => m.id)));
check(
	"the stale model is gone from the registry",
	!shared.lastModels.some((m: any) => m.id === idA),
);

// ── 3) the session is moved onto the replacement automatically ────────────
check("pi.setModel is called for the replacement", await waitFor(() => setModelCalls.includes(idB)), JSON.stringify(setModelCalls));
check(
	"the switch is announced",
	notifications.some((n) => n.includes("using") && n.includes("orcarouter/Alpha-Uncensored")),
	JSON.stringify(notifications.slice(-3)),
);

// ── 4) request payloads use the raw served id ─────────────────────────────
const mapped = await runRequest({ model: idB, max_tokens: 999999 });
check(
	"a live id is rewritten to the raw server id",
	mapped.some((r) => r.model === "orcarouter/Alpha-Uncensored"),
	JSON.stringify(mapped),
);

// ── 5) a dead id is never sent quietly ────────────────────────────────────
notifications.length = 0;
const dead = await runRequest({ model: idA, max_tokens: 512 });
check("a dead id is not rewritten to another model", !dead.some((r) => typeof r.model === "string" && r.model !== idA), JSON.stringify(dead));
check(
	"a dead id is reported with the fix to run",
	notifications.some((n) => n.includes("is not served on") && n.includes("/llama-infra use")),
	JSON.stringify(notifications),
);

// ── 6) `/llama-infra use` activates on demand ─────────────────────────────
setModelCalls.length = 0;
notifications.length = 0;
await cmd.handler("use uncensored", mkCtx(idB));
check("use activates the matching model", setModelCalls.length === 1 && setModelCalls[0] === idB, JSON.stringify(setModelCalls));

// ── 7) no manual scan: the background rescan notices the next swap ─────────
setModelCalls.length = 0;
const idC = `Gamma Model ${tag}`;
served = { id: "Gamma Model" };
check(
	"the background rescan discovers the swapped model on its own",
	await waitFor(() => shared.lastModels.some((m: any) => m.id === idC), 6000),
	JSON.stringify(shared.lastModels.map((m: any) => m.id)),
);
check(
	"and the session follows it",
	await waitFor(() => setModelCalls.includes(idC), 3000),
	JSON.stringify(setModelCalls),
);

server.close();
if (failures > 0) {
	console.error(`activate tests failed: ${failures}`);
	process.exit(1);
}
console.log("activate tests passed");
