// Behavior tests for vLLM/OpenAI-compatible vision detection: the
// --limit-mm-per-prompt / --language-model-only argument parsing, the
// looksLikeOpenAiEngine wrapper heuristic, and buildModelMetadata using the
// local engine args as ground truth (manual modelOptions.vision still wins).
// Run: node --experimental-strip-types test/vllm-vision.test.ts

import { setActiveConfig } from "../src/core.ts";
import { buildModelMetadata, looksLikeOpenAiEngine, parseServerArgs } from "../src/scan.ts";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
	if (cond) console.log(`  ✓ ${label}`);
	else {
		failures++;
		console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

// ── 1) parseServerArgs: --limit-mm-per-prompt / --language-model-only ──────
console.log("vllm-vision: parseServerArgs");

check(
	`--limit-mm-per-prompt '{"image":2}' → acceptsImages true`,
	parseServerArgs(["--limit-mm-per-prompt", '{"image":2}']).acceptsImages === true,
	JSON.stringify(parseServerArgs(["--limit-mm-per-prompt", '{"image":2}'])),
);
check(
	`--limit-mm-per-prompt '{"image":0}' → acceptsImages false`,
	parseServerArgs(["--limit-mm-per-prompt", '{"image":0}']).acceptsImages === false,
	JSON.stringify(parseServerArgs(["--limit-mm-per-prompt", '{"image":0}'])),
);
check(
	"--limit-mm-per-prompt=image=3 → acceptsImages true",
	parseServerArgs(["--limit-mm-per-prompt=image=3"]).acceptsImages === true,
	JSON.stringify(parseServerArgs(["--limit-mm-per-prompt=image=3"])),
);
check(
	"--language-model-only → acceptsImages false",
	parseServerArgs(["--language-model-only"]).acceptsImages === false,
	JSON.stringify(parseServerArgs(["--language-model-only"])),
);
check(
	"--language-model-only + --limit-mm-per-prompt {\"image\":3} → false (textOnly wins)",
	parseServerArgs(["--language-model-only", "--limit-mm-per-prompt", '{"image":3}']).acceptsImages === false,
	JSON.stringify(parseServerArgs(["--language-model-only", "--limit-mm-per-prompt", '{"image":3}'])),
);
const mmproj = parseServerArgs(["--mmproj", "x.gguf"]);
check("--mmproj x.gguf → hasMmproj true", mmproj.hasMmproj === true, JSON.stringify(mmproj));
check("--mmproj x.gguf → acceptsImages undefined", mmproj.acceptsImages === undefined, JSON.stringify(mmproj));

// ── 2) looksLikeOpenAiEngine wrapper heuristic ─────────────────────────────
console.log("vllm-vision: looksLikeOpenAiEngine");

check(
	"paiton-qwen38 wrapper (--served-model-name + --max-model-len) → true",
	looksLikeOpenAiEngine([
		"python3",
		"/usr/local/bin/paiton-qwen38",
		"serve",
		"--served-model-name",
		"Qwen3.8-27B",
		"--max-model-len",
		"80000",
		"--port",
		"8082",
	]),
);
check(
	"python3 -m vllm.entrypoints.openai.api_server → true",
	looksLikeOpenAiEngine(["python3", "-m", "vllm.entrypoints.openai.api_server", "--port", "8000"]),
);
check("python3 -m sglang.launch_server → true", looksLikeOpenAiEngine(["python3", "-m", "sglang.launch_server", "--port", "30000"]));
check("plain-wrapper (no known flags) → false", looksLikeOpenAiEngine(["python3", "plain-wrapper", "serve", "--port", "8082"]) === false);
check(
	"served-model-name but no OpenAI-specific flag → false",
	looksLikeOpenAiEngine(["python3", "w", "serve", "--served-model-name", "X", "--port", "1"]) === false,
);

// ── 3) buildModelMetadata: local args are ground truth ─────────────────────
console.log("vllm-vision: buildModelMetadata");

setActiveConfig(undefined);
check(
	"acceptsImages:true → vision true",
	buildModelMetadata("Qwen3.8-27B", { id: "Qwen3.8-27B" } as any, undefined, { port: 8082, acceptsImages: true }, "vllm")
		.vision === true,
);
check(
	"acceptsImages:false overrides props modalities.vision",
	buildModelMetadata(
		"Qwen3.8-27B",
		{ id: "Qwen3.8-27B" } as any,
		{ modalities: { vision: true } } as any,
		{ port: 8082, acceptsImages: false },
		"vllm",
	).vision === false,
);
check(
	"acceptsImages:undefined and no props → vision undefined",
	buildModelMetadata("Qwen3.8-27B", { id: "Qwen3.8-27B" } as any, undefined, { port: 8082, acceptsImages: undefined }, "vllm")
		.vision === undefined,
);

// Manual override must still win over the local engine args.
setActiveConfig({ modelOptions: { "Qwen3.8-27B": { vision: true } } } as any);
check(
	"manual modelOptions.vision:true wins over acceptsImages:false",
	buildModelMetadata("Qwen3.8-27B", { id: "Qwen3.8-27B" } as any, undefined, { port: 8082, acceptsImages: false }, "vllm")
		.vision === true,
);
setActiveConfig(undefined);

if (failures > 0) {
	console.error(`\nvllm-vision tests failed: ${failures}`);
	process.exit(1);
}
console.log("\nAll vllm-vision checks passed ✅");
