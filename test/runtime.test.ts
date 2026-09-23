// Standalone behavior test for llama-infra runtime request defaults.
// Run: node --experimental-strip-types test/runtime.test.ts

import { DEFAULT_PROVIDER_TIMEOUT_MS } from "../src/core.ts";
import { toServerRequestModel, withLocalRuntimeDefaults } from "../src/runtime.ts";

let failures = 0;

function check(label: string, cond: boolean, detail?: string): void {
	if (cond) console.log(`  ✓ ${label}`);
	else {
		failures++;
		console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

console.log("runtime defaults: timeout floor");

check(
	"missing timeout becomes 20 minutes",
	withLocalRuntimeDefaults(undefined).timeoutMs === DEFAULT_PROVIDER_TIMEOUT_MS,
	String(withLocalRuntimeDefaults(undefined).timeoutMs),
);

check(
	"shorter timeout is raised to 20 minutes",
	withLocalRuntimeDefaults({ timeoutMs: 300_000 }).timeoutMs === DEFAULT_PROVIDER_TIMEOUT_MS,
	String(withLocalRuntimeDefaults({ timeoutMs: 300_000 }).timeoutMs),
);

check(
	"longer timeout is preserved",
	withLocalRuntimeDefaults({ timeoutMs: 3_600_000 }).timeoutMs === 3_600_000,
	String(withLocalRuntimeDefaults({ timeoutMs: 3_600_000 }).timeoutMs),
);

check(
	"other stream options are preserved",
	withLocalRuntimeDefaults({ maxRetries: 0, maxTokens: 1024 }).maxTokens === 1024,
	JSON.stringify(withLocalRuntimeDefaults({ maxRetries: 0, maxTokens: 1024 })),
);

// Regression for the critique/extension nested-call 404: ctx.modelRegistry
// .complete() bypasses the session's before_provider_request hook, so the
// provider stream itself must rewrite the pi-visible (decorated) id to the
// raw server id.
console.log("runtime: server model id rewrite for nested calls");

const ids = new Map([["Example-27B (gpu-host:8000)", "Example-27B"]]);

const decorated = { id: "Example-27B (gpu-host:8000)", provider: "llama-infra" };
check(
	"decorated id is rewritten to the raw server id",
	toServerRequestModel(decorated, ids).id === "Example-27B",
	toServerRequestModel(decorated, ids).id,
);
check(
	"rewrite returns a copy and does not mutate the input",
	toServerRequestModel(decorated, ids) !== decorated && decorated.id === "Example-27B (gpu-host:8000)",
);
check(
	"an already-raw id is returned unchanged (same object)",
	toServerRequestModel({ id: "Example-27B" }, ids).id === "Example-27B",
);
check(
	"an unmapped id is returned unchanged",
	toServerRequestModel({ id: "some-other-model" }, ids).id === "some-other-model",
);
check(
	"a model without an id is returned unchanged",
	toServerRequestModel({} as { id?: string }, ids).id === undefined,
);

if (failures > 0) {
	console.error(`runtime defaults tests failed: ${failures}`);
	process.exit(1);
}
console.log("runtime defaults tests passed");
