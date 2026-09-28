// Standalone behavior test for the per-model output-cap "Clear" semantics:
// removing the cap must never touch thinkingBudgets / vision / drafter, and the
// modelOptions entry is dropped only when it becomes empty.
// Run: node --experimental-strip-types test/outputcaps.test.ts

import { clearModelMaxTokens, DEFAULT_SETTINGS, setActiveConfig } from "../src/core.ts";
import type { InfraConfig, ModelOptions } from "../src/types.ts";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
	if (cond) console.log(`  ✓ ${label}`);
	else {
		failures++;
		console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

const base = (modelOptions: Record<string, ModelOptions>): InfraConfig => ({
	servers: [],
	settings: { ...DEFAULT_SETTINGS },
	modelOptions,
});

console.log("core: clearModelMaxTokens");

// (a) mixed entry: only maxTokens goes away, the rest survives.
let config = base({
	"mixed-model": { maxTokens: 8192, thinkingBudgets: { low: 512 }, vision: true, drafter: "draft-x" },
});
setActiveConfig(config);
check("(a) returns true", clearModelMaxTokens("mixed-model") === true);
const mixed = config.modelOptions["mixed-model"];
check("(a) entry still present", mixed !== undefined);
check("(a) maxTokens removed", mixed?.maxTokens === undefined);
check("(a) thinkingBudgets preserved", mixed?.thinkingBudgets?.low === 512, JSON.stringify(mixed?.thinkingBudgets));
check("(a) vision preserved", mixed?.vision === true);
check("(a) drafter preserved", mixed?.drafter === "draft-x");

// (b) only maxTokens: the whole entry is removed.
config = base({ "only-cap": { maxTokens: 4096 } });
setActiveConfig(config);
check("(b) returns true", clearModelMaxTokens("only-cap") === true);
check("(b) entry removed", config.modelOptions["only-cap"] === undefined);
check("(b) key absent", !("only-cap" in config.modelOptions));

// (c) no maxTokens: no-op, entry untouched.
config = base({ "vision-only": { vision: true } });
setActiveConfig(config);
const c = clearModelMaxTokens("vision-only");
check("(c) returns false", c === false);
check("(c) entry intact", config.modelOptions["vision-only"]?.vision === true);
check("(c) no maxTokens created", config.modelOptions["vision-only"]?.maxTokens === undefined);

// (d) unknown model: no-op and no new entry.
config = base({});
setActiveConfig(config);
check("(d) returns false", clearModelMaxTokens("missing") === false);
check("(d) no entry created", Object.keys(config.modelOptions).length === 0);

// (e) siblings are never affected.
config = base({ a: { maxTokens: 2048 }, b: { maxTokens: 8192 } });
setActiveConfig(config);
clearModelMaxTokens("a");
check("(e) target removed", config.modelOptions.a === undefined);
check("(e) sibling untouched", config.modelOptions.b.maxTokens === 8192);

if (failures > 0) {
	console.error(`outputcaps tests failed: ${failures}`);
	process.exit(1);
}
console.log("outputcaps tests passed");
