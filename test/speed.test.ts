// Standalone behavior test for the client-side speed tracker (src/speed.ts).
// Run: node --experimental-strip-types test/speed.test.ts

import { createSpeedTracker } from "../src/speed.ts";
import type { AssistantMessageEvent, ServerMetricsState } from "../src/types.ts";

let failures = 0;

function check(label: string, cond: boolean, detail?: string): void {
	if (cond) {
		console.log(`  ✓ ${label}`);
	} else {
		failures++;
		console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

function makeCtx(ours: boolean) {
	const lines: string[] = [];
	const ctx: any = {
		model: {
			provider: ours ? "llama-infra" : "anthropic",
			id: "m1",
			baseUrl: "http://127.0.0.1:8080/v1",
		},
		ui: {
			setStatus: (_key: string, text: string | undefined) => {
				lines.length = 0;
				if (text !== undefined) lines.push(text);
			},
			theme: { fg: (_c: string, t: string) => t },
		},
	};
	return { ctx, lines };
}

/** One stream chunk. 3 chars ≈ 1 token with the default 0.35 tok/char ratio. */
const delta = (n: number, text = "xxx"): AssistantMessageEvent =>
	({ type: "text_delta", contentIndex: 0, delta: text, partial: {} } as AssistantMessageEvent);

console.log("speed tracker: basic turn lifecycle");
{
	const { ctx, lines } = makeCtx(true);
	const tracker = createSpeedTracker({
		isActive: () => true,
		hasUI: (c) => !!c?.ui,
		isOurs: (c) => c?.model?.provider === "llama-infra",
		enabled: () => true,
	});

	tracker.onRequest(ctx, 0);
	check("prefill line shows placeholders before first token", lines.join() === "⚡… 🔥…", lines.join());

	// First token at t=2000 → streaming. No rate yet (window span < 300 ms).
	tracker.onToken(ctx, delta(1), 2000);
	check("streaming line shows pending rate", lines.join() === "🔥…", lines.join());

	// 29 more chunks at 40 ms intervals (25 chunks/s ≈ 26 t/s with 3 chars ≈ 1 token).
	for (let i = 2; i <= 30; i++) tracker.onToken(ctx, delta(i), 2000 + (i - 1) * 40);
	const line = lines.join();
	const m = line.match(/🔥 ([\d.]+) t\/s/);
	const rate = m ? parseFloat(m[1]) : NaN;
	check("gen rate ≈ 25 t/s (whole-request average)", Math.abs(rate - 25) <= 3, line);

	// Message ends: usage.input gives 3000 prompt tokens, prefill span 2.0 s → 1500 t/s.
	tracker.onMessageEnd(ctx, { role: "assistant", usage: { input: 3000, output: 30 } }, 3200);
	const done = lines.join();
	check("done line keeps gen + prefill rates", /🔥 .*t\/s/.test(done) && /⚡ 1500 t\/s/.test(done), done);

	tracker.onTurnEnd(ctx);
	// Rates persist across turns so the footer does not flicker back to idle.
	check(
		"idle line keeps measured rates after turn end",
		/🔥 [\d.]+ t\/s/.test(lines.join()) && /⚡ 1500 t\/s/.test(lines.join()),
		lines.join(),
	);

	// Server supplement while idle: other clients busy (appended to the rates).
	tracker.onServerState(ctx, { processing: 2, promptTps: 150, genTps: 18 } satisfies ServerMetricsState);
	const sup = lines.join();
	check("server supplement shown while idle", /▶2/.test(sup) && /⚡ 150 t\/s/.test(sup) && /🔥 18\.0 t\/s/.test(sup), sup);

	tracker.onServerState(ctx, null);
	check("idle without server keeps rates", /🔥 [\d.]+ t\/s/.test(lines.join()) && !/⏸/.test(lines.join()), lines.join());
}

console.log("speed tracker: foreign model");
{
	const { ctx, lines } = makeCtx(false);
	const tracker = createSpeedTracker({
		isActive: () => true,
		hasUI: (c) => !!c?.ui,
		isOurs: (c) => c?.model?.provider === "llama-infra",
		enabled: () => true,
	});
	tracker.start(ctx);
	check("no widget for foreign model", lines.length === 0);
	tracker.onRequest(ctx, 0);
	check("no widget on foreign request", lines.length === 0);
}

console.log("speed tracker: disabled widget");
{
	const { ctx, lines } = makeCtx(true);
	const tracker = createSpeedTracker({
		isActive: () => true,
		hasUI: (c) => !!c?.ui,
		isOurs: (c) => c?.model?.provider === "llama-infra",
		enabled: () => false,
	});
	tracker.start(ctx);
	check("no widget when disabled", lines.length === 0);
	tracker.onRequest(ctx, 0);
	check("no widget on request when disabled", lines.length === 0);
}

console.log("speed tracker: render throttle (no spam)");
{
	const { ctx, lines } = makeCtx(true);
	let renders = 0;
	const ctxCount: any = {
		...ctx,
		ui: {
			...ctx.ui,
			setStatus: (_key: string, text: string | undefined) => {
				renders++;
				lines.length = 0;
				if (text !== undefined) lines.push(text);
			},
		},
	};
	const tracker = createSpeedTracker({
		isActive: () => true,
		hasUI: (c) => !!c?.ui,
		isOurs: (c) => c?.model?.provider === "llama-infra",
		enabled: () => true,
	});
	tracker.onRequest(ctxCount, 0);
	for (let i = 1; i <= 50; i++) tracker.onToken(ctxCount, delta(i), i * 20); // 50 chunks/s over 1 s
	// 1 s of 20 ms tokens → renders at most ~11 (100 ms throttle).
	check("throttled renders (≤ 12)", renders <= 12, `renders=${renders}`);
	const m = lines.join().match(/🔥 ([\d.]+) t\/s/);
	const rate = m ? parseFloat(m[1]) : NaN;
	check("gen rate ≈ 50 t/s (whole-request average)", Math.abs(rate - 50) <= 6, lines.join());
}

console.log("speed tracker: dedup (no redundant status updates)");
{
	const { ctx } = makeCtx(true);
	let updates = 0;
	const ctxDup: any = {
		...ctx,
		ui: {
			...ctx.ui,
			setStatus: (_key: string, _text: string | undefined) => {
				updates++;
			},
		},
	};
	const tracker = createSpeedTracker({
		isActive: () => true,
		hasUI: (c) => !!c?.ui,
		isOurs: (c) => c?.model?.provider === "llama-infra",
		enabled: () => true,
	});
	tracker.onRequest(ctxDup, 0); // "⚡… 🔥…" → 1 update
	tracker.onRequest(ctxDup, 1000); // identical text, forced render → dedup skips
	check("identical prefill text sent once", updates === 1, `updates=${updates}`);
	tracker.onToken(ctxDup, delta(1), 1500); // streaming → different text
	tracker.onTurnEnd(ctxDup); // "⏸"
	tracker.onServerState(ctxDup, { processing: 2, promptTps: 150, genTps: 18 });
	const after = updates;
	tracker.onServerState(ctxDup, { processing: 2, promptTps: 150, genTps: 18 }); // same snapshot → dedup skips
	check("identical server snapshot sent once", updates === after, `updates=${after}→${updates}`);
	tracker.onServerState(ctxDup, null); // idle again → text changes
	check("state changes still update", updates === after + 1, `updates=${updates}`);
}

console.log("speed tracker: prefill is only a rate when compute dominates");
{
	// Regression for the six-figure prefill rate: an engine with prefix caching
	// answers an 80k-token prompt in ~0.5 s, so prompt_tokens / TTFT explodes.
	// A prefix-cache hit (or a tiny prompt) must be reported as TTFT instead.
	const { ctx, lines } = makeCtx(true);
	const tracker = createSpeedTracker({
		isActive: () => true,
		hasUI: (c) => !!c?.ui,
		isOurs: (c) => c?.model?.provider === "llama-infra",
		enabled: () => true,
	});
	tracker.onRequest(ctx, 0);
	tracker.onToken(ctx, delta(1), 500);
	tracker.onMessageEnd(ctx, { role: "assistant", usage: { input: 80_000, cacheRead: 0, output: 40 } }, 900);
	const cached = lines.join();
	check(
		"80k prompt in 500 ms (cache hit) shows TTFT, not 160000 t/s",
		/⚡ 500ms/.test(cached) && !/⚡ \d+ t\/s/.test(cached),
		cached,
	);
	check("decode rate still measured on that turn", /🔥 [\d.]+ t\/s/.test(cached), cached);

	// A prompt that really was processed (>= 1 s of prefill) does report t/s.
	tracker.onRequest(ctx, 10_000);
	tracker.onToken(ctx, delta(1), 12_000);
	tracker.onMessageEnd(ctx, { role: "assistant", usage: { input: 18_000, cacheWrite: 0, output: 50 } }, 12_600);
	const real = lines.join();
	check("18k prompt in 2 s reports 9000 t/s", /⚡ 9000 t\/s/.test(real), real);
	check("decode = output tokens / time since first token (≈83 t/s)", /🔥 (8[0-9]|9[0-9])(\.\d)? t\/s/.test(real), real);

	// Cache writes count as processed prompt tokens; cache reads do not.
	const { ctx: ctx2, lines: lines2 } = makeCtx(true);
	const tracker2 = createSpeedTracker({
		isActive: () => true,
		hasUI: (c) => !!c?.ui,
		isOurs: (c) => c?.model?.provider === "llama-infra",
		enabled: () => true,
	});
	tracker2.onRequest(ctx2, 20_000);
	tracker2.onToken(ctx2, delta(1), 23_000);
	tracker2.onMessageEnd(
		ctx2,
		{ role: "assistant", usage: { input: 1_000, cacheRead: 79_000, cacheWrite: 9_000, output: 10 } },
		23_400,
	);
	const partial = lines2.join();
	check(
		"only uncached tokens are divided by TTFT (1000 in + 9000 cacheWrite / 3 s ≈ 3333 t/s)",
		/⚡ 33[0-9][0-9] t\/s/.test(partial),
		partial,
	);
}

console.log("speed tracker: chunk → token calibration");
{
	const { ctx, lines } = makeCtx(true);
	const tracker = createSpeedTracker({
		isActive: () => true,
		hasUI: (c) => !!c?.ui,
		isOurs: (c) => c?.model?.provider === "llama-infra",
		enabled: () => true,
	});
	// 200 chars in 1 s, provider reports 100 output tokens → ratio 0.5 for later calls.
	tracker.onRequest(ctx, 0);
	for (let i = 1; i <= 10; i++) tracker.onToken(ctx, delta(i, "x".repeat(20)), i * 100);
	tracker.onMessageEnd(ctx, { role: "assistant", usage: { input: 600, output: 100 } }, 1_100);
	// Next request: 100 chars over 1 s with the learned 0.5 ratio → ≈50 t/s.
	tracker.onRequest(ctx, 5_000);
	for (let i = 1; i <= 5; i++) tracker.onToken(ctx, delta(i, "x".repeat(20)), 5_000 + i * 200);
	const learned = lines.join().match(/🔥 ([\d.]+) t\/s/);
	const rate = learned ? parseFloat(learned[1]) : NaN;
	check("live estimate uses the ratio learned from usage.output (≈0.5 tok/char)", Math.abs(rate - 50) <= 8, lines.join());
}

console.log("speed tracker: tool-call fragments count by characters");
{
	const { ctx, lines } = makeCtx(true);
	const tracker = createSpeedTracker({
		isActive: () => true,
		hasUI: (c) => !!c?.ui,
		isOurs: (c) => c?.model?.provider === "llama-infra",
		enabled: () => true,
	});
	tracker.onRequest(ctx, 0);
	for (let i = 1; i <= 10; i++) {
		tracker.onToken(
			ctx,
			{ type: "toolcall_delta", contentIndex: 0, delta: "x".repeat(10), partial: {} } as AssistantMessageEvent,
			i * 100,
		);
	}
	const line = lines.join();
	check("toolcall_delta drives a 🔥 rate", /🔥 [\d.]+ t\/s/.test(line), line);
}

console.log("speed tracker: measurements are per model");
{
	const { ctx, lines } = makeCtx(true);
	const tracker = createSpeedTracker({
		isActive: () => true,
		hasUI: (c) => !!c?.ui,
		isOurs: (c) => c?.model?.provider === "llama-infra",
		enabled: () => true,
	});
	tracker.onRequest(ctx, 0);
	tracker.onToken(ctx, delta(1), 2_500);
	tracker.onMessageEnd(ctx, { role: "assistant", usage: { input: 20_000, output: 50 } }, 3_100);
	check("first model shows a prefill rate + decode", /⚡ 8000 t\/s/.test(lines.join()) && /🔥 [\d.]+ t\/s/.test(lines.join()), lines.join());
	// Switching to another llama-infra model must not inherit the old rates.
	const ctxB: any = { ...ctx, model: { ...ctx.model, id: "m2" } };
	tracker.onRequest(ctxB, 10_000);
	check(
		"switching model clears the previous prefill/decode readings",
		lines.join() === "⚡… 🔥…",
		lines.join(),
	);
}

if (failures > 0) {
	console.error(`\n${failures} check(s) FAILED`);
	process.exit(1);
}
console.log("\nAll checks passed ✅");
