// Standalone behavior test for the footer stability of the client-side speed
// tracker (src/speed.ts): the last measured rates must stay visible across
// request/turn boundaries instead of flickering back to placeholders/idle.
// Run: node --experimental-strip-types test/speed-footer.test.ts

import { METRICS_STATUS_KEY } from "../src/core.ts";
import { createSpeedTracker } from "../src/speed.ts";
import type { AssistantMessageEvent } from "../src/types.ts";

let failures = 0;

function check(label: string, cond: boolean, detail?: string): void {
	if (cond) console.log(`  ✓ ${label}`);
	else {
		failures++;
		console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

/** Fake ctx recording every setStatus call (including `undefined` clears). */
function makeCtx() {
	const updates: Array<{ key: string; text: string | undefined }> = [];
	const ctx: any = {
		model: { provider: "llama-infra", id: "m1", baseUrl: "http://127.0.0.1:8080/v1" },
		ui: {
			setStatus: (key: string, text: string | undefined) => {
				updates.push({ key, text });
			},
		},
	};
	/** Text of the last setStatus call, or undefined when cleared. */
	const last = (): string | undefined => (updates.length ? updates[updates.length - 1].text : undefined);
	return { ctx, updates, last };
}

const delta = (): AssistantMessageEvent =>
	({ type: "text_delta", contentIndex: 0, delta: "x", partial: {} } as AssistantMessageEvent);

console.log("speed footer: measured rates persist (no flicker)");

const { ctx, updates, last } = makeCtx();
const tracker = createSpeedTracker({
	isActive: () => true,
	enabled: () => true,
	hasUI: () => true,
	isOurs: () => true,
});

// (e) Before any measurement the first line is a placeholder.
tracker.onRequest(ctx, 0);
const first = last();
check(
	"(e) first line is a placeholder before any measurement",
	!!first && first.length > 0 && first.includes("…"),
	String(first),
);

// Stream tokens over a >300 ms span so genRateAt computes a real rate.
let t = 400;
for (let i = 1; i <= 10; i++) {
	tracker.onToken(ctx, delta(), t);
	t += 400;
}
const streaming = last() ?? "";
check(
	"(a) streamed tokens produce a measured 🔥 rate with a digit",
	/🔥 [\d.]+ t\/s/.test(streaming),
	streaming,
);

// (b) Finalizing the message keeps the measured rate visible.
tracker.onMessageEnd(ctx, { role: "assistant", usage: { input: 2000, output: 10 } }, t);
const done = last() ?? "";
const matched = done.match(/🔥 ([\d.]+) t\/s/);
check("(b) rate still shown after onMessageEnd", !!matched, done);

// (c) Regression: onTurnEnd must not wipe the rate back to the idle icon.
tracker.onTurnEnd(ctx);
const idle = last() ?? "";
check(
	"(c) rate STILL shown after onTurnEnd (not merely ⏸)",
	!!matched && idle.includes(`🔥 ${matched[1]} t/s`) && idle !== "⏸",
	idle,
);

// (d) A new request keeps the previous rate visible (digit, not only '…').
tracker.onRequest(ctx, t + 5000);
const next = last() ?? "";
check(
	"(d) subsequent onRequest keeps the previous rate visible",
	/\d/.test(next) && /🔥/.test(next) && !/^…$/.test(next),
	next,
);

// (f) stop() clears the footer status.
tracker.stop(ctx);
const stopUpdate = updates[updates.length - 1];
check(
	"(f) stop() calls setStatus with undefined",
	stopUpdate.key === METRICS_STATUS_KEY && stopUpdate.text === undefined,
	JSON.stringify(stopUpdate),
);

// (R14) The moving window only trusts a rate once it spans >= GEN_MIN_SPAN_MS (300 ms).
console.log("speed footer: rate requires a >=300 ms sample span (R14)");
{
	const { ctx, last } = makeCtx();
	const tracker = createSpeedTracker({
		isActive: () => true,
		enabled: () => true,
		hasUI: () => true,
		isOurs: () => true,
	});
	tracker.onRequest(ctx, 0);
	tracker.onToken(ctx, delta(), 100); // span = 100 ms < 300 ms
	const early = last() ?? "";
	check(
		"(R14) sub-300 ms span still shows the 🔥 placeholder (no rate)",
		/🔥…/.test(early) && !/🔥 [\d.]+ t\/s/.test(early),
		early,
	);
	tracker.onToken(ctx, delta(), 1000); // span = 1000 ms >= 300 ms
	const later = last() ?? "";
	check("(R14) >=300 ms span computes a 🔥 rate", /🔥 [\d.]+ t\/s/.test(later), later);
}

if (failures > 0) {
	console.error(`speed-footer tests failed: ${failures}`);
	process.exit(1);
}
console.log("speed-footer tests passed");
