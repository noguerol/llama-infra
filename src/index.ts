// Extension entrypoint: wires config, hooks, command, and lazy modules.
// Heavy logic lives in lazily-loaded sibling files (scan, registration,
// metrics, ui, prompt-warmup). Static imports are kept minimal.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { homedir } from "node:os";
import {
	PROVIDER_NAME,
	STATUS_KEY,
	applyCachedSharedState,
	compactIdFor,
	debugLog,
	loadConfig,
	loadModelsCache,
	modelOptions,
	modelOptionsFor,
	normalizeLevel,
	rawIdFor,
	renameThinkingBudgetField,
	resolveThinkingBudgetField,
	saveConfig,
	setActiveConfig,
	shared,
	THINKING_BUDGET_FIELD,
} from "./core.ts";
import { clampMaxTokensToFit, createLongTimeoutOpenAICompletionsStream, estimatePromptTokens } from "./runtime.ts";
import {
	detectVanishedModel,
	endpointTags,
	hostTagOf,
	pickModel,
	resolveStaleServerModelId,
	suggestIds,
} from "./model-switch.ts";

/** What `ctx.modelRegistry.find()` hands back to `pi.setModel()`. */
type RegistryModel = ReturnType<ExtensionContext["modelRegistry"]["find"]>;
import { resolveCostProfile } from "./cost.ts";
import { createCostTracker, type CostTracker } from "./cost-tracker.ts";
export { modelOptionsFor };

export default function (pi: ExtensionAPI) {
	const config = loadConfig();
	setActiveConfig(config);
	shared.lastScan = undefined;
	shared.lastModels = [];
	shared.registeredCount = 0;
	shared.lastError = undefined;

	// ── Lazy module handles ───────────────────────────────────────────────
	type WarmerModule = typeof import("./prompt-warmup.ts");
	type UiModule = typeof import("./ui.ts");
	type MetricsModule = typeof import("./metrics.ts");
	type SpeedModule = typeof import("./speed.ts");
	type ScanModule = typeof import("./scan.ts");
	type RegModule = typeof import("./registration.ts");

	let warmerModPromise: Promise<WarmerModule> | undefined;
	let metricsModPromise: Promise<MetricsModule> | undefined;
	let speedModPromise: Promise<SpeedModule> | undefined;
	let uiModPromise: Promise<UiModule> | undefined;
	let scanModPromise: Promise<ScanModule> | undefined;
	let regModPromise: Promise<RegModule> | undefined;

	const loadWarmer = (): Promise<WarmerModule> => (warmerModPromise ??= import("./prompt-warmup.ts"));
	const loadUi = (): Promise<UiModule> => (uiModPromise ??= import("./ui.ts"));
	const loadMetrics = (): Promise<MetricsModule> => (metricsModPromise ??= import("./metrics.ts"));
	const loadSpeed = (): Promise<SpeedModule> => (speedModPromise ??= import("./speed.ts"));
	const loadScan = (): Promise<ScanModule> => (scanModPromise ??= import("./scan.ts"));
	const loadReg = (): Promise<RegModule> => (regModPromise ??= import("./registration.ts"));

	// Prime heavy modules off the critical path so they land in cache before
	// they are first needed. Discovery (always needed) starts after the
	// factory returns, so these resolves race the first discoverAndRegister().
	void loadScan();
	void loadReg();
	if (config.settings.metricsEnabled) {
		void loadMetrics();
		void loadSpeed();
	}
	if (config.settings.warmup) void loadWarmer();
	void loadUi(); // command handler awaits this; priming keeps menus snappy

	// ── Warmup handle (constructed lazily on first session_start) ─────────
	interface WarmerHandles {
		warmer: import("./prompt-warmup.ts").PromptWarmer;
		status: import("./prompt-warmup.ts").WarmupStatus;
	}
	let warm: WarmerHandles | undefined;

	// ── Metrics engine + speed tracker handles ────────────────────────────
	let metricsApi: ReturnType<MetricsModule["createMetrics"]> | undefined;
	let speedApi: ReturnType<SpeedModule["createSpeedTracker"]> | undefined;

	/**
	 * Energy-cost tracker. Created SYNCHRONOUSLY at factory time (not lazily
	 * like the speed tracker) because cost must be measured inside sub-agent
	 * processes too (`pi -p --no-session`), which never fire session_start:
	 * the message_end hook needs it on the very first LLM call. Gating is done
	 * via deps.enabled(), so toggling costTracking ON at runtime works.
	 */
	const costApi: CostTracker = createCostTracker({
			isActive: () => extensionActive,
			hasUI: ctxHasUI,
			isOurs: (ctx) => {
				try {
					return ctx?.model?.provider === PROVIDER_NAME;
				} catch {
					return false;
				}
			},
			enabled: () => config.settings.costTracking,
			currency: () => config.settings.currency,
			profileFor: (ctx) => costProfileFor(ctx),
		});

	// ── Internal state ────────────────────────────────────────────────────
	let lastSignature: string | undefined;
	let pollTimer: ReturnType<typeof setTimeout> | undefined;
	let polling = false;
	let discoveryTimer: ReturnType<typeof setInterval> | undefined;
	let providerIsEmpty = true;
	let currentThinkingLevel: string | undefined;

	const knownGood = new Set<string>();
	const consecutiveFails = new Map<string, number>();
	let anyEverOk = false;

	// ── Session model tracking (activation needs both) ────────────────────
	// pi keeps the session's model selection across registerProvider(), so after a
	// server swap the session can be pointed at an id nobody serves. Activation
	// therefore needs (a) the id the session is on and (b) a live ctx, since
	// pi.setModel()/ui.notify() are only reachable through one. discovery has no
	// ctx of its own, so the freshest UI ctx seen in any handler is remembered.
	let lastUiCtx: ExtensionContext | undefined;
	let currentModelId: string | undefined;
	/** `(host:port)` tags this extension can produce — used to recognize our ids. */
	const ourTags = endpointTags(config.servers);
	const warnedStaleIds = new Set<string>();
	const startedAt = Date.now();
	let extensionActive = true;

	function ctxHasUI(ctx: ExtensionContext | undefined): ctx is ExtensionContext {
		if (!ctx || !extensionActive) return false;
		try {
			return ctx.hasUI;
		} catch (err) {
			debugLog(`stale ctx ignored: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}

	const epKey = (host: string, port: number) => `${host}:${port}`;

	/** Cost profile for the model a ctx is currently talking to (null = no estimation). */
	function costProfileFor(ctx: ExtensionContext | undefined): import("./types.ts").CostProfile | null {
		try {
			const m = ctx?.model as { id?: string; provider?: string } | undefined;
			if (!m?.id) return null;
			const baseUrl = shared.modelBaseUrls.get(m.id);
			const ep = shared.lastScan?.endpoints.find((e) => e.baseUrl === baseUrl);
			return resolveCostProfile(
				{
					id: m.id,
					endpoint: ep ? { serverId: ep.serverId, host: ep.host, port: ep.port } : undefined,
				},
				config.servers,
			);
		} catch {
			return null;
		}
	}

	function safeSystemPrompt(ctx: { getSystemPrompt?: () => string }): string | undefined {
		try {
			return ctx.getSystemPrompt?.();
		} catch {
			return undefined;
		}
	}

	// ── Activation helpers ────────────────────────────────────────────────
	/** Keep the freshest usable UI context for notify()/setModel(). */
	function noteCtx(ctx: ExtensionContext | undefined): void {
		if (ctxHasUI(ctx)) lastUiCtx = ctx;
	}

	function uiCtx(): ExtensionContext | undefined {
		return ctxHasUI(lastUiCtx) ? lastUiCtx : undefined;
	}

	function notify(message: string, kind: "info" | "warning" = "info"): void {
		const ctx = uiCtx();
		if (!ctx) return;
		try {
			ctx.ui.notify(message, kind);
		} catch (err) {
			debugLog(`notify ignored: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** Select a discovered model for this session (pi's own selection path). */
	async function activateModel(target: import("./types.ts").PiModel, ctx: ExtensionContext): Promise<boolean> {
		let model: RegistryModel | undefined;
		try {
			model = ctx.modelRegistry.find(PROVIDER_NAME, target.id);
		} catch (err) {
			debugLog(`modelRegistry.find failed: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
		if (!model) {
			notify(`🦙 "${target.id}" is not registered with pi — run /llama-infra scan`, "warning");
			return false;
		}
		const ok = await pi.setModel(model);
		if (!ok) {
			notify(`🦙 could not activate "${target.id}"`, "warning");
			return false;
		}
		currentModelId = target.id;
		notify(`🦙 using ${target.id} → served as ${target.serverModelId}`);
		return true;
	}

	/** `/llama-infra use <model>`: resolve a query to one model and activate it. */
	async function useModel(query: string, ctx: ExtensionContext): Promise<void> {
		noteCtx(ctx);
		if (!query) {
			const ids = shared.lastModels.map((m) => m.id);
			notify(
				ids.length === 0
					? "🦙 no models discovered — try /llama-infra scan"
					: `🦙 which model? /llama-infra use <name> · ${ids.slice(0, 6).join(", ")}${ids.length > 6 ? ` (+${ids.length - 6})` : ""}`,
				"warning",
			);
			return;
		}
		// A model that was just started is by definition not in the list yet.
		let pick = pickModel(shared.lastModels, query);
		if (pick.matches.length === 0) {
			await rescan(ctx);
			pick = pickModel(shared.lastModels, query);
		}
		if (pick.matches.length === 0) {
			const hints = suggestIds(shared.lastModels, query);
			notify(
				hints.length > 0
					? `🦙 nothing matches "${query}" — try: ${hints.join(", ")}`
					: `🦙 nothing matches "${query}" (${shared.lastModels.length} discovered)`,
				"warning",
			);
			return;
		}
		if (pick.matches.length > 1) {
			notify(
				`🦙 "${query}" matches ${pick.matches.length}: ${pick.matches
					.slice(0, 5)
					.map((m) => m.id)
					.join(", ")}${pick.matches.length > 5 ? " …" : ""} — be more specific`,
				"warning",
			);
			return;
		}
		await activateModel(pick.matches[0], ctx);
	}

	// ── Empty provider registration (pi boots without waiting) ───────────
	function registerEmptyProvider() {
		const first = config.servers.find((s) => s.enabled && s.ports.length > 0);
		try {
			pi.unregisterProvider(PROVIDER_NAME);
		} catch {
			// not registered yet
		}
		pi.registerProvider(PROVIDER_NAME, {
			name: "🦙 llama-infra (scanning…)",
			baseUrl: `http://${first?.host ?? "127.0.0.1"}:${first?.ports[0] ?? 8080}/v1`,
			apiKey: first?.apiKey || "no-auth",
			api: "openai-completions",
			streamSimple: createLongTimeoutOpenAICompletionsStream,
			models: [],
		});
		providerIsEmpty = true;
	}

	// ── Boot provider registration (synchronous, cache-first) ────────────
	// Registers models from the last known scan IMMEDIATELY when a cache exists,
	// so this process can resolve `--model llama-infra/...` at startup without
	// waiting for the async discovery re-scan (which refreshes right after).
	// Falls back to the empty "scanning…" provider when there is no cache.
	function registerBootProvider() {
		const cached = loadModelsCache();
		if (cached && cached.length > 0) {
			try {
				pi.unregisterProvider(PROVIDER_NAME);
			} catch {
				// not registered yet
			}
			// Re-derive per-server auth headers (never persisted with the cache).
			for (const m of cached) {
				const srv = config.servers.find((s) => s.id === m.endpoint?.serverId && s.host === m.endpoint?.host);
				if (srv?.apiKey) m.headers = { Authorization: `Bearer ${srv.apiKey}` };
			}
			applyCachedSharedState(cached);
			const bootSrv = config.servers.find((s) => s.id === cached[0].endpoint?.serverId);
			pi.registerProvider(PROVIDER_NAME, {
				name: `🦙 llama-infra (cached ${cached.length}, rescanning…)`,
				baseUrl: cached[0].baseUrl,
				apiKey: bootSrv?.apiKey || "no-auth",
				api: "openai-completions",
				streamSimple: createLongTimeoutOpenAICompletionsStream,
				models: cached,
			});
			providerIsEmpty = false;
			shared.registeredCount = cached.length;
			shared.lastModels = cached;
			debugLog(`boot: registered ${cached.length} cached model(s); async rescan will refresh`);
			return;
		}
		registerEmptyProvider();
	}

	async function discoverAndRegister(): Promise<{ scan: import("./types.ts").ScanResult; shouldPoll: boolean }> {
		try {
			if (!extensionActive) {
				return { scan: { endpoints: [], totalModels: 0, serversUp: 0, serversTotal: 0 }, shouldPoll: false };
			}
			const { scanAllServers, modelsSignature } = await loadScan();
			const scan = await scanAllServers(config);
			if (!extensionActive) return { scan, shouldPoll: false };
			shared.lastScan = scan;

			const signature = modelsSignature(scan.endpoints);
			const changed = signature !== lastSignature || providerIsEmpty;
			lastSignature = signature;
			if (!changed) {
				return {
					scan,
					shouldPoll: shouldContinuePolling(scan.endpoints, scan.endpoints.some((e) => e.loading)),
				};
			}

			const { buildAndRegisterProvider } = await loadReg();
			const prevModels = shared.lastModels;
			const models = buildAndRegisterProvider(pi, scan, config);
			// A model swap (or a server that came back with something else) leaves
			// the session pointed at an id no one serves, and the next request dies
			// with the server's own "model not found". Adopt the replacement when
			// there is exactly one on that endpoint; otherwise say what to type.
			const repair = detectVanishedModel(prevModels, models, currentModelId);
			if (repair) {
				const where = epKey(repair.gone.endpoint?.host ?? "?", repair.gone.endpoint?.port ?? 0);
				const ctx = uiCtx();
				if (repair.candidates.length === 1 && ctx) {
					const only = repair.candidates[0];
					debugLog(`"${repair.gone.id}" no longer served on ${where}; adopting "${only.id}"`);
					void activateModel(only, ctx).catch((err) =>
						debugLog(`auto-adopt failed: ${err instanceof Error ? err.message : String(err)}`),
					);
				} else if (repair.candidates.length > 1) {
					notify(
						`🦙 "${repair.gone.id}" is no longer served on ${where} — /llama-infra use <model> (${repair.candidates.length} available)`,
						"warning",
					);
				} else {
					notify(`🦙 "${repair.gone.id}" is no longer served on ${where}`, "warning");
				}
			}
			providerIsEmpty = models.length === 0;
			shared.registeredCount = models.length;
			shared.lastModels = models;
			shared.lastError = undefined;
			debugLog(`discovery change: ${shared.registeredCount} model(s), ${scan.serversUp}/${scan.serversTotal} servers up`);

			for (const ep of scan.endpoints) {
				const key = epKey(ep.host, ep.port);
				if (ep.ok) {
					anyEverOk = true;
					knownGood.add(key);
					consecutiveFails.delete(key);
				} else if (knownGood.has(key)) {
					const fails = (consecutiveFails.get(key) ?? 0) + 1;
					consecutiveFails.set(key, fails);
					if (fails >= config.settings.knownGoodFailLimit) {
						knownGood.delete(key);
						consecutiveFails.delete(key);
					}
				}
			}
			return {
				scan,
				shouldPoll: shouldContinuePolling(scan.endpoints, scan.endpoints.some((e) => e.loading)),
			};
		} catch (err) {
			if (extensionActive) shared.lastError = err instanceof Error ? err.message : String(err);
			return { scan: { endpoints: [], totalModels: 0, serversUp: 0, serversTotal: 0 }, shouldPoll: false };
		}
	}

	function shouldContinuePolling(endpoints: import("./types.ts").EndpointResult[], hasLoading: boolean): boolean {
		if (hasLoading) return true;
		for (const key of knownGood) {
			const ep = endpoints.find((e) => epKey(e.host, e.port) === key);
			if (!ep || !ep.ok) return true;
		}
		if (!anyEverOk && Date.now() - startedAt < config.settings.startupGraceMs) return true;
		return false;
	}

	function schedulePolling(shouldPoll: boolean) {
		if (!extensionActive || !shouldPoll || polling) return;
		polling = true;
		const deadline = Date.now() + config.settings.pollMaxMs;
		const tick = async () => {
			if (!extensionActive) {
				polling = false;
				return;
			}
			if (Date.now() >= deadline) {
				polling = false;
				return;
			}
			const r = await discoverAndRegister();
			if (!extensionActive) {
				polling = false;
				return;
			}
			if (r.shouldPoll) {
				pollTimer = setTimeout(tick, config.settings.pollIntervalMs);
				pollTimer?.unref?.();
			} else {
				polling = false;
			}
		};
		pollTimer = setTimeout(tick, config.settings.pollIntervalMs);
		pollTimer?.unref?.();
	}

	function stopPolling() {
		if (pollTimer) clearTimeout(pollTimer);
		pollTimer = undefined;
		polling = false;
	}

	/**
	 * Re-scan every enabled endpoint on a timer. The poll loop above only watches
	 * endpoints that are loading or failing, so swapping the model on a server that
	 * stayed up — the normal way to change models — would otherwise be invisible
	 * until a manual scan or a new session. Discovery is idempotent: this is one
	 * cheap GET round per tick, and nothing is re-registered unless the signature
	 * actually changed.
	 */
	function startDiscoveryInterval() {
		const ms = config.settings.rescanIntervalMs;
		if (!extensionActive || discoveryTimer || !(ms > 0)) return;
		discoveryTimer = setInterval(() => {
			if (!extensionActive || polling) return;
			void discoverAndRegister()
				.then((r) => {
					if (extensionActive && !polling) schedulePolling(r.shouldPoll);
				})
				.catch((err) => debugLog(`background rescan failed: ${err instanceof Error ? err.message : String(err)}`));
		}, ms);
		discoveryTimer.unref?.();
	}

	function stopDiscoveryInterval() {
		if (discoveryTimer) clearInterval(discoveryTimer);
		discoveryTimer = undefined;
	}

	async function rescan(ctx?: ExtensionContext) {
		if (!extensionActive) return;
		if (ctxHasUI(ctx)) ctx.ui.setStatus(STATUS_KEY, "🔎");
		stopPolling();
		registerEmptyProvider();
		const r = await discoverAndRegister();
		if (!extensionActive) return;
		schedulePolling(r.shouldPoll);
		updateStatusFooter(ctx);
	}

	function updateStatusFooter(ctx?: ExtensionContext) {
		if (!ctxHasUI(ctx)) return;
		if (shared.registeredCount > 0) {
			ctx.ui.setStatus(STATUS_KEY, `🦙(${shared.registeredCount})`);
		} else if (shared.lastScan?.endpoints.some((e) => e.loading)) {
			ctx.ui.setStatus(STATUS_KEY, "⏳");
		} else if (shared.lastError) {
			ctx.ui.setStatus(STATUS_KEY, "⚠️");
		} else {
			ctx.ui.setStatus(STATUS_KEY, "−");
		}
	}

	async function toggleMetrics(ctx: ExtensionContext) {
		config.settings.metricsEnabled = !config.settings.metricsEnabled;
		saveConfig(config);
		if (config.settings.metricsEnabled) {
			await ensureSpeed().then((s) => s?.start(ctx));
			const m = await ensureMetrics();
			m.start(ctx);
			ctx.ui.notify("📊 Live speed & metrics enabled (footer)", "info");
		} else {
			speedApi?.stop(ctx);
			metricsApi?.stop(ctx);
			ctx.ui.notify("📊 Live speed & metrics disabled", "info");
		}
	}

	function restartMetricsPolling(ctx: ExtensionContext) {
		if (!metricsApi) return;
		metricsApi.stop(ctx);
		if (config.settings.metricsEnabled) metricsApi.start(ctx);
	}

	// ── Live speed + energy cost: per-call timing (before id rewrite) ─────
	pi.on("before_provider_request", (_event, ctx) => {
		speedApi?.onRequest(ctx, Date.now());
		costApi?.onRequest(ctx, Date.now());
		return undefined;
	});

	// ── Live speed: stream events (token arrivals, message/turn ends) ────
	pi.on("message_update", (event, ctx) => {
		speedApi?.onToken(ctx, event.assistantMessageEvent, Date.now());
	});

	pi.on("message_end", (event, ctx) => {
		speedApi?.onMessageEnd(ctx, event.message, Date.now());

		// Inject the energy cost of THIS request into usage.cost.total so pi's
		// native cost footer, session stats and any consumer reading usage
		// (e.g. trimegisto agents, which accumulate usage.cost.total per
		// message) see a realistic cost for local models. message_end fires
		// before persistence, so mutating event.message in place is enough.
		const msg = event.message as { role?: string; usage?: { cost?: { total?: number } } } | undefined;
		if (msg?.role === "assistant" && config.settings.costTracking) {
			const requestCost = costApi?.onMessageEnd(ctx, event.message, Date.now()) ?? 0;
			if (requestCost > 0 && msg.usage?.cost) {
				msg.usage.cost.total = (msg.usage.cost.total ?? 0) + requestCost;
				return { message: event.message };
			}
		}
		return undefined;
	});

	pi.on("turn_end", (_event, ctx) => {
		speedApi?.onTurnEnd(ctx);
	});

	// ── Hook -1: tools-aware request-time max_tokens clamp ────────────────
	// pi's estimateContextTokens ignores tool schemas, which on tool-heavy
	// setups add tens of thousands of tokens. strict engines (vLLM) answer
	// HTTP 400 when prompt + max_tokens exceeds max_model_len, so clamp the
	// request before the compact→raw id rewrite (Hook 0) turns the payload
	// model into the raw id: this sees the compact id registered in pi.
	pi.on("before_provider_request", (event, _ctx) => {
		const payload = event.payload as Record<string, unknown>;
		const modelId = typeof payload.model === "string" ? payload.model : undefined;
		if (!modelId) return undefined;
		const compact = compactIdFor(modelId);
		const model = compact ? shared.lastModels.find((m) => m.id === compact) : undefined;
		if (!model) return undefined;
		const est = estimatePromptTokens(payload);
		const next = clampMaxTokensToFit(payload, model.contextWindow);
		if (next === undefined) return undefined;
		debugLog(
			`max_tokens clamp ${payload.max_tokens} → ${next} (prompt ~${est} tok, ctx ${model.contextWindow})`,
		);
		return { ...payload, max_tokens: next };
	});

	// ── Hook 0: compact id → raw server model id ──────────────────────────
	pi.on("before_provider_request", (event, _ctx) => {
		const payload = event.payload as Record<string, unknown>;
		const modelInPayload = typeof payload.model === "string" ? payload.model : undefined;
		if (!modelInPayload) return undefined;
		const raw = shared.serverModelIds.get(modelInPayload);
		if (raw !== undefined && raw !== modelInPayload) {
			debugLog(`model id "${modelInPayload}" → "${raw}"`);
			return { ...payload, model: raw };
		}
		// Unmapped decorated id: either the registration was renamed but the model
		// is still there (recover it, scoped to the same host:port), or it is gone
		// and the server would answer with its own opaque "model not found" — say
		// what happened once per id instead. Foreign providers' models carry no tag
		// we issued, so they are never mentioned here.
		if (raw === undefined) {
			const recovered = resolveStaleServerModelId(modelInPayload, shared.serverModelIds);
			if (recovered !== undefined) {
				debugLog(`stale id "${modelInPayload}" → "${recovered}" (same endpoint)`);
				return { ...payload, model: recovered };
			}
			const tag = hostTagOf(modelInPayload);
			if (tag !== undefined && ourTags.has(tag) && !warnedStaleIds.has(modelInPayload)) {
				warnedStaleIds.add(modelInPayload);
				debugLog(`no server id for "${modelInPayload}" — sending as-is`);
				notify(
					`🦙 "${modelInPayload}" is not served on ${tag} — /llama-infra use <model> to pick a live one`,
					"warning",
				);
			}
		}
		return undefined;
	});

	// ── Hook 1: ZINC payload workaround ───────────────────────────────────
	function isZincModel(modelInPayload: unknown): boolean {
		if (typeof modelInPayload !== "string") return false;
		if (shared.zincModelIds.has(modelInPayload)) return true;
		for (const zid of shared.zincModelIds) {
			if (modelInPayload === zid || modelInPayload.includes(zid) || zid.includes(modelInPayload)) return true;
		}
		return false;
	}

	pi.on("before_provider_request", (event, _ctx) => {
		const payload = event.payload as Record<string, unknown>;
		if (!isZincModel(payload.model)) return undefined;

		const rawTools = payload.tools;
		const hasTools = "tools" in payload;
		const toolCount = Array.isArray(rawTools) ? rawTools.length : 0;
		debugLog(`ZINC model detected ("${payload.model}") → rewriting payload`);

		const newPayload: Record<string, unknown> = { ...payload, model: "" };

		if (hasTools && toolCount > 0 && newPayload.tool_choice === undefined) {
			newPayload.tool_choice = "auto";
		}

		if (Array.isArray(rawTools)) {
			newPayload.tools = rawTools.map((tool: any) => {
				if (tool?.type === "function" && tool?.function) {
					const cleaned: any = { type: "function", function: { ...tool.function } };
					delete cleaned.function.strict;
					return cleaned;
				}
				if (tool?.name) {
					const fn: any = { name: tool.name };
					if (tool.description) fn.description = tool.description;
					if (tool.parameters) fn.parameters = tool.parameters;
					delete (fn as any).strict;
					return { type: "function", function: fn };
				}
				return tool;
			});
		}

		return newPayload;
	});

	// ── Hook 2: per-model thinking budget (kind/override-aware field) ──────
	// pi's compat may already place the level budget on the right field
	// (`thinkingTokenBudgetField`), but two things still need fixing here:
	//  1) a client (or a mis-detected server) sends llama.cpp's
	//     `thinking_budget_tokens`, which vLLM silently ignores → rename it to
	//     the engine's field (`thinking_token_budget`);
	//  2) inject the per-level budget from `modelOptions[id].thinkingBudgets`
	//     when the request carries none.
	pi.on("before_provider_request", (event, ctx) => {
		const payload = event.payload as Record<string, unknown>;
		const modelId = typeof payload.model === "string" ? payload.model : undefined;
		if (!modelId) return undefined;
		const compactKey = shared.compactModelIds.get(modelId) ?? modelId;
		const baseUrl = shared.modelBaseUrls.get(compactKey);
		const kind = shared.endpointKinds.get(baseUrl ?? "");
		const field = resolveThinkingBudgetField(compactKey, kind as never);
		if (!field) return undefined;

		// 1) Rename llama.cpp's field onto the engine's field when needed.
		let next = renameThinkingBudgetField(payload, field);
		if (next) {
			debugLog(`thinking budget field for ${compactKey}: ${THINKING_BUDGET_FIELD} → ${field}`);
		}

		// 2) Inject/override with the configured per-level budget. Like before,
		//    a per-model `thinkingBudgets` value wins over pi's own global budget.
		const budgets = modelOptions()[compactKey]?.thinkingBudgets;
		if (budgets) {
			const level = normalizeLevel(ctx.thinkingLevel ?? currentThinkingLevel);
			const value = level ? budgets[level] : undefined;
			if (typeof value === "number") {
				next = { ...(next ?? payload), [field]: value };
				debugLog(`thinking budget for ${compactKey} [${level}] = ${value} → ${field}`);
			}
		}

		return next;
	});

	// ── Hook 3: header warmup capture ─────────────────────────────────────
	pi.on("before_provider_request", (event, ctx) => {
		if (!config.settings.warmup || !warm) return undefined;
		const payload = event.payload as Record<string, unknown>;
		const modelId = typeof payload?.model === "string" ? payload.model : undefined;
		const compactKey = modelId ? compactIdFor(modelId) : undefined;
		const baseUrl = compactKey ? shared.modelBaseUrls.get(compactKey) : undefined;
		const capturePayload = compactKey ? { ...payload, model: compactKey } : payload;
		warm.warmer.onProviderPayload(capturePayload, baseUrl, ctx.cwd);
		return undefined;
	});

	// ── Async warmup loader ───────────────────────────────────────────────
	async function ensureWarmup(): Promise<WarmerHandles | undefined> {
		if (!config.settings.warmup) return undefined;
		if (!warm) {
			const m = await loadWarmer();
			const status = new m.WarmupStatus("warmup-llama-infra");
			const warmer = new m.PromptWarmer({
				provider: PROVIDER_NAME,
				cacheFile: join(homedir(), ".pi", "agent", "warmup-llama-infra.json"),
				kindFor: (baseUrl) => shared.endpointKinds.get(baseUrl),
				requestModelFor: (modelId) => rawIdFor(modelId) ?? modelId,
				onEvent: (ev) => status.handle(ev),
			});
			warm = { warmer, status };
		}
		return warm;
	}

	async function ensureSpeed(): Promise<NonNullable<typeof speedApi> | undefined> {
		if (!speedApi) {
			const m = await loadSpeed();
			if (!speedApi) {
				speedApi = m.createSpeedTracker({
					isActive: () => extensionActive,
					hasUI: ctxHasUI,
					isOurs: (ctx) => {
						try {
							return ctx?.model?.provider === PROVIDER_NAME;
						} catch {
							return false; // post-shutdown ctx (live `model` getter throws)
						}
					},
					enabled: () => config.settings.metricsEnabled,
				});
			}
		}
		return speedApi;
	}

	async function ensureMetrics(): Promise<NonNullable<typeof metricsApi>> {
		if (!metricsApi) {
			const m = await loadMetrics();
			metricsApi = m.createMetrics({
				isActive: () => extensionActive,
				pollIntervalMs: () => config.settings.metricsPollMs,
				enabled: () => config.settings.metricsEnabled,
				onServerState: (ctx, st) => {
					speedApi?.onServerState(ctx, st);
				},
			});
		}
		return metricsApi;
	}

	// ── Command ───────────────────────────────────────────────────────────
	pi.registerCommand("llama-infra", {
		description: "🦙 llama-infra: scan, use <model>, status, config, metrics for llama.cpp/ZINC/ds4/lucebox/LM Studio/vLLM/gufo",
		getArgumentCompletions: (prefix) => {
			const raw = prefix ?? "";
			// `use ` completes discovered model ids; ids contain spaces, so only the
			// first token is treated as the subcommand everywhere below.
			const usePrefix = /^use\s+/i.exec(raw);
			if (usePrefix) {
				const q = raw.slice(usePrefix[0].length);
				const matches = pickModel(shared.lastModels, q).matches;
				const list = matches.length > 0 ? matches : shared.lastModels;
				return list.slice(0, 20).map((m) => ({ value: `use ${m.id}`, label: m.id }));
			}
			return ["use", "config", "scan", "status", "list", "metrics", "help"]
				.filter((s) => s.startsWith(raw.trim().toLowerCase()))
				.map((s) => ({ value: s, label: s }));
		},
		handler: async (args, ctx) => {
			noteCtx(ctx);
			const rawArgs = (args ?? "").trim();
			const sp = rawArgs.indexOf(" ");
			const sub = (sp < 0 ? rawArgs : rawArgs.slice(0, sp)).toLowerCase();
			const rest = sp < 0 ? "" : rawArgs.slice(sp + 1).trim();
			const ui = await loadUi();
			const deps: import("./ui.ts").UiDeps = {
				rescan,
				toggleMetrics,
				restartMetricsPolling,
				updateStatusFooter,
			};
			switch (sub) {
				case "":
				case "status":
					await ui.showStatus(ctx);
					break;
				case "config":
					await ui.showConfigMenu(ctx, deps);
					break;
				case "scan":
					await rescan(ctx);
					ctx.ui.notify("🔎 scan complete", "info");
					break;
				case "list":
					await ui.showModelList(ctx);
					break;
				case "use":
					await useModel(rest, ctx);
					break;
				case "metrics":
					await toggleMetrics(ctx);
					break;
				case "help":
					ui.showHelp(ctx);
					break;
				default:
					ctx.ui.notify(`❓ unknown "${sub}". Try /llama-infra help`, "warning");
					break;
			}
		},
	});

	// ── Initial non-blocking registration ─────────────────────────────────
	registerBootProvider();
	void discoverAndRegister()
		.then((r) => {
			if (extensionActive) schedulePolling(r.shouldPoll);
			startDiscoveryInterval();
		})
		.catch((err) => {
			if (extensionActive) debugLog(`initial discovery failed: ${err instanceof Error ? err.message : String(err)}`);
		});

	// ── Events ────────────────────────────────────────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		noteCtx(ctx);
		try {
			currentModelId = (ctx.model as { id?: string } | undefined)?.id;
		} catch {
			// stale ctx — keep the previous id rather than lose it
		}
		const w = await ensureWarmup();
		if (w) {
			if (ctxHasUI(ctx)) w.status.bind(ctx.ui);
			w.warmer.warmupForModel(ctx.model, safeSystemPrompt(ctx), ctx.cwd);
		}
		currentThinkingLevel = ctx.thinkingLevel;
		try {
			if (config.settings.metricsEnabled) {
				await ensureSpeed().then((s) => s?.start(ctx));
				const m = await ensureMetrics();
				m.start(ctx);
			}
		} catch (err) {
			// Tracking must never break session start (or spam the TUI with traces).
			debugLog(`session_start tracking error ignored: ${err instanceof Error ? err.message : String(err)}`);
		}
		if (!ctxHasUI(ctx)) return;
		void discoverAndRegister()
			.then((r) => {
				if (!extensionActive) return;
				schedulePolling(r.shouldPoll);
				startDiscoveryInterval();
				updateStatusFooter(ctx);
			})
			.catch((err) => {
				if (!extensionActive) return;
				shared.lastError = err instanceof Error ? err.message : String(err);
				updateStatusFooter(ctx);
			});
	});

	pi.on("model_select", async (event, ctx) => {
		noteCtx(ctx);
		currentModelId = event.model.id;
		if (event.model.provider !== PROVIDER_NAME) {
			speedApi?.stop(ctx);
			metricsApi?.stop(ctx);
			return;
		}
		const w = await ensureWarmup();
		if (w) {
			if (ctxHasUI(ctx)) w.status.bind(ctx.ui);
			w.warmer.warmupForModel(event.model, safeSystemPrompt(ctx), ctx.cwd);
		}
		metricsApi?.resetForModelSwitch();
		costApi?.reset(ctx);
		try {
			if (config.settings.metricsEnabled) {
				await ensureSpeed().then((s) => s?.start(ctx));
				const m = await ensureMetrics();
				m.start(ctx);
			}
		} catch (err) {
			// Tracking must never break model switches (or spam the TUI with traces).
			debugLog(`model_select tracking error ignored: ${err instanceof Error ? err.message : String(err)}`);
		}
	});

	pi.on("thinking_level_select", (event, _ctx) => {
		currentThinkingLevel = event.level;
	});

	pi.on("session_shutdown", () => {
		extensionActive = false;
		stopPolling();
		stopDiscoveryInterval();
		speedApi?.stop();
		metricsApi?.stop();
		warm?.warmer.dispose();
		warm?.status.dispose();
	});
}