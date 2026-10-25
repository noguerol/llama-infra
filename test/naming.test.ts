// Standalone behavior test for display-name cleaning (src/scan.ts cleanModelName).
// Packaging (quant, file suffix, version) is stripped; model flavor is preserved, so
// a fine-tune never registers under the name of the model it was tuned from.
// Run: node --experimental-strip-types test/naming.test.ts

import { cleanModelName } from "../src/scan.ts";

let failures = 0;

function check(label: string, got: string, want: string): void {
	if (got === want) console.log(`  ✓ ${label}`);
	else {
		failures++;
		console.error(`  ✗ ${label} — want ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
	}
}

console.log("naming: what a model id becomes in /model");

// ── flavor words survive ──────────────────────────────────────────────────
check(
	"uncensored fine-tune keeps its flavor",
	cleanModelName("orcarouter/Qwen3.8-Flash-Next-Uncensored"),
	"Qwen3.8-Flash-Next-Uncensored",
);
check(
	"the base model keeps its own name",
	cleanModelName("Qwen3.8 Flash Next"),
	"Qwen3.8 Flash Next",
);
check(
	"the two register under different names",
	cleanModelName("orcarouter/Qwen3.8-Flash-Next-Uncensored") === cleanModelName("Qwen3.8 Flash Next")
		? "IDENTICAL"
		: "distinct",
	"distinct",
);
check(
	"instruct keeps its flavor and loses its quant",
	cleanModelName("Some-Model-Instruct-Q4_K_M.gguf"),
	"Some-Model-Instruct",
);

// ── packaging still goes away ─────────────────────────────────────────────
check("gguf extension is stripped", cleanModelName("mixtral-8x7b.gguf"), "mixtral-8x7b");
check("ggml tarball suffix is stripped", cleanModelName("model.ggml.tar"), "model");
check("bare GGUF packaging token is stripped", cleanModelName("Orca-Mini-GGUF"), "Orca-Mini");
check("f16 suffix is stripped", cleanModelName("Some-Model-F16.gguf"), "Some-Model");
check("q8_0 suffix is stripped", cleanModelName("Some-Model-Q8_0.gguf"), "Some-Model");

// ── the (host:port) tag is preserved through cleaning ─────────────────────
check(
	"a tagged id keeps its tag",
	cleanModelName("Qwen3.8-Flash-Next-Uncensored-Q4_K_M (gpu-host:8080)"),
	"Qwen3.8-Flash-Next-Uncensored (gpu-host:8080)",
);
check(
	"a path prefix with a tag still cleans",
	cleanModelName("/models/Qwen (gpu-host:8000)"),
	"Qwen (gpu-host:8000)",
);


if (failures > 0) {
	console.error(`naming tests failed: ${failures}`);
	process.exit(1);
}
console.log("naming tests passed");
