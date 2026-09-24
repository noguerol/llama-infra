// Behavior tests for the modelOptions resolver (src/core.ts::modelOptionsFor)
// as exercised through buildModelMetadata (src/scan.ts): raw-id keys,
// display-id keys (`<raw id> (host:port)`), and manual overrides winning over
// server-reported modalities. No external network: everything runs in-process.
// Run: node --experimental-strip-types test/vision.test.ts

import { DEFAULT_SETTINGS, setActiveConfig, shared } from "../src/core.ts";
import { buildModelMetadata } from "../src/scan.ts";
import type { LlamaCppModel, ModelOptions } from "../src/types.ts";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
	if (cond) console.log(`  ✓ ${label}`);
	else {
		failures++;
		console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

/** Reset shared state and install a config with the given modelOptions. */
function withModelOptions(opts: Record<string, ModelOptions>): void {
	shared.compactModelIds.clear();
	setActiveConfig({
		servers: [],
		settings: { ...DEFAULT_SETTINGS },
		modelOptions: opts,
	});
}

const plainEntry: LlamaCppModel = { id: "Example-27B", object: "model" };

// ── 1) Raw-id key ──────────────────────────────────────────────────────────
console.log("vision: modelOptions key = raw id");

withModelOptions({ "Example-27B": { vision: true } });
const metaA = buildModelMetadata("Example-27B", plainEntry, undefined, undefined);
check("raw-id key Example-27B → meta.vision === true", metaA.vision === true, String(metaA.vision));

// ── 2) Display-id key (regression: the gpu-host:8000 bug) ─────────────────────
// The user configures the model under its registered display id
// "Example-27B (gpu-host:8000)" while the raw server id is "Example-27B".
// compactModelIds is EMPTY (pre-registration resolution) — the resolver must
// still find the display-id key by its `<raw id> (` prefix.
console.log("vision: modelOptions key = display id `<raw id> (host:port)`");

withModelOptions({ "Example-27B (gpu-host:8000)": { vision: true } });
const metaB = buildModelMetadata("Example-27B", plainEntry, undefined, undefined);
check(
	"display-id key Example-27B (gpu-host:8000) → meta.vision === true (regression)",
	metaB.vision === true,
	String(metaB.vision),
);

// ── 3) No key at all ────────────────────────────────────────────────────────
console.log("vision: no modelOptions key, no server signal");

withModelOptions({});
const metaC = buildModelMetadata("Example-27B", plainEntry, undefined, undefined);
check("no key, vLLM-style entry → meta.vision undefined", metaC.vision === undefined, String(metaC.vision));

// ── 4) Manual override wins over server-reported modalities ────────────────
console.log("vision: override vision:false beats input_modalities");

withModelOptions({ "Example-27B": { vision: false } });
const visionEntry: LlamaCppModel = {
	id: "Example-27B",
	object: "model",
	architecture: { input_modalities: ["image"] },
};
const metaD = buildModelMetadata("Example-27B", visionEntry, undefined, undefined);
check(
	"override vision:false wins over architecture.input_modalities ['image']",
	metaD.vision === false,
	String(metaD.vision),
);

// ── 5) Drafter override via display-id key ──────────────────────────────────
console.log("vision: drafter override via display id");

withModelOptions({ "Example-27B (gpu-host:8000)": { drafter: "example-27b-draft" } });
const metaE = buildModelMetadata("Example-27B", plainEntry, undefined, undefined);
check(
	"display-id key drafter override resolves",
	metaE.drafter === "example-27b-draft",
	String(metaE.drafter),
);

if (failures > 0) {
	console.error(`\nvision tests failed: ${failures}`);
	process.exit(1);
}
console.log("\nAll vision checks passed ✅");
