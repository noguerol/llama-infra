// UI / menus / status views. Lazy-loaded on command invocation.

import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, type SettingItem, Text } from "@earendil-works/pi-tui";

import {
	DEFAULT_SETTINGS,
	getConfigPath,
	idSafeHost,
	modelOptions,
	saveConfig,
	serverLabel,
	serversShareEndpoint,
	shared,
} from "./core.ts";
import type {
	EndpointResult,
	ExtensionContext,
	ModelMetadata,
	ModelOptions,
	PiModel,
	ServerConfig,
	ServerKind,
	ThinkingBudgets,
} from "./types.ts";
import { fetchModelsFromEndpoint, scanLocalServers } from "./scan.ts";
import { CURRENCIES, formatProfile, currencySymbol } from "./cost.ts";

// ── Small UI helpers ───────────────────────────────────────────────────────
async function selectFrom<T>(
	ctx: ExtensionContext,
	title: string,
	items: Array<{ value: T; label: string; description?: string }>,
): Promise<T | undefined> {
	const strings = items.map((it) => (it.description ? `${it.label} — ${it.description}` : it.label));
	const picked = await ctx.ui.select(title, strings);
	if (picked === undefined) return undefined;
	const idx = strings.indexOf(picked);
	return idx >= 0 ? items[idx].value : undefined;
}

function parsePorts(input: string): number[] | undefined {
	const ports = new Set<number>();
	for (const part of input.split(/[,\s]+/)) {
		const trimmed = part.trim();
		if (!trimmed) continue;
		const range = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
		if (range) {
			const lo = parseInt(range[1], 10);
			const hi = parseInt(range[2], 10);
			if (isNaN(lo) || isNaN(hi) || lo > hi || hi > 65535 || lo <= 0) continue;
			for (let p = lo; p <= hi && p - lo < 256; p++) ports.add(p);
			continue;
		}
		const n = parseInt(trimmed, 10);
		if (!isNaN(n) && n > 0 && n < 65536) ports.add(n);
	}
	if (ports.size === 0) return undefined;
	return [...ports].sort((a, b) => a - b);
}

function formatMs(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
	return `${Math.round(ms / 60_000)}m`;
}

function formatCtx(tokens: number | undefined): string {
	if (!tokens || tokens <= 0) return "";
	return tokens >= 1024 ? `${Math.round(tokens / 1024)}k` : `${tokens}`;
}

function formatTokens(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "0";
	if (n >= 1024) {
		const k = n / 1024;
		return Number.isInteger(k) ? `${k}k` : `${k.toFixed(1)}k`;
	}
	return `${n}`;
}

type ServerKindLike = ServerKind | "auto" | "unknown";

/** Tolerant icon + label per server kind; unknown/future kinds never crash. */
const KIND_META: Record<ServerKindLike, { icon: string; label: string }> = {
	llamacpp: { icon: "🦙", label: "llama.cpp" },
	zinc: { icon: "⚡", label: "ZINC" },
	lucebox: { icon: "💡", label: "lucebox" },
	dwarfstar: { icon: "🕵️", label: "ds4" },
	lmstudio: { icon: "🎛️", label: "LM Studio" },
	vllm: { icon: "🅥", label: "vLLM" },
	auto: { icon: "🔎", label: "auto" },
	unknown: { icon: "❔", label: "unknown" },
};

/** Falls back to `❔ <raw>` for unrecognized kinds instead of throwing. */
function serverKindLabel(kind: string | undefined): string {
	const meta = kind ? (KIND_META as Record<string, { icon: string; label: string } | undefined>)[kind] : undefined;
	if (!meta) return `❔ ${kind && kind.length > 0 ? kind : "unknown"}`;
	return `${meta.icon} ${meta.label}`;
}

/** GGUF/llama.cpp-specific KV cache types are meaningless for vLLM. */
function showsGgufKvCache(kind: string | undefined): boolean {
	return kind !== "vllm";
}

function metadataBadges(m: ModelMetadata | undefined, kind?: string): string {
	if (!m) return "";
	const parts: string[] = [];
	if (m.quant) parts.push(`🗜️ ${m.quant}`);
	if (showsGgufKvCache(kind) && (m.cacheK || m.cacheV)) parts.push(`🧠 KV ${m.cacheK ?? "?"}/${m.cacheV ?? m.cacheK ?? "?"}`);
	if (m.vision) parts.push("👁️ vision");
	// vLLM does not publish a drafter, but a manual override may set one: always show it.
	if (m.drafter) parts.push(`🚀 ${m.drafter}`);
	return parts.length > 0 ? ` — ${parts.join(" · ")}` : "";
}

function budgetsSummary(b?: ThinkingBudgets): string {
	if (!b) return "none";
	const parts: string[] = [];
	for (const [k, v] of Object.entries(b)) {
		if (typeof v === "number") parts.push(`${k}: ${v}`);
	}
	return parts.length > 0 ? parts.join(", ") : "none";
}

function isServerUp(serverId: string): boolean {
	return shared.lastScan?.endpoints.some((e) => e.serverId === serverId && e.ok) ?? false;
}

function countServerModels(serverId: string): number {
	return shared.lastScan?.endpoints.filter((e) => e.serverId === serverId).reduce((a, e) => a + (e.ok ? e.models.length : 0), 0) ?? 0;
}



// ── Deps (host-provided callbacks; avoid circular imports) ─────────────────
export interface UiDeps {
	rescan: (ctx?: ExtensionContext) => Promise<void>;
	toggleMetrics: (ctx: ExtensionContext) => Promise<void>;
	restartMetricsPolling: (ctx: ExtensionContext) => void;
	updateStatusFooter: (ctx?: ExtensionContext) => void;
}

// ── Quick status ───────────────────────────────────────────────────────────
export async function showStatus(ctx: ExtensionContext): Promise<void> {
	if (!shared.lastScan) {
		ctx.ui.notify("🦙 scanning… try again in a moment", "info");
		return;
	}
	const config = shared.activeConfig!;
	const lastScan = shared.lastScan;
	const lines: string[] = [];
	lines.push(`🦙 ${lastScan.totalModels} model(s) · ${lastScan.serversUp}/${lastScan.serversTotal} servers up`);
	lines.push("");
	for (const srv of config.servers) {
		if (!srv.enabled) {
			lines.push(`⛔ ${serverLabel(srv)} (${srv.host}) — disabled`);
			continue;
		}
		const eps = lastScan.endpoints.filter((e) => e.serverId === srv.id);
		const okEps = eps.filter((e) => e.ok);
		if (okEps.length === 0) {
			const loading = eps.find((e) => e.loading);
			const err = eps.find((e) => e.error)?.error;
			lines.push(
				loading
					? `⏳ ${serverLabel(srv)} (${srv.host}) — model loading…`
					: `🔴 ${serverLabel(srv)} (${srv.host}) — offline${err ? ` (${err.slice(0, 60)})` : ""}`,
			);
			continue;
		}
		const kinds = new Map<string, number>();
		for (const e of okEps) for (const _m of e.models) kinds.set(e.server, (kinds.get(e.server) ?? 0) + 1);
		const kindStr = [...kinds.entries()].map(([k, n]) => `${serverKindLabel(k)} ×${n}`).join(", ");
		const models = okEps.reduce((a, e) => a + e.models.length, 0);
		lines.push(`🟢 ${serverLabel(srv)} (${srv.host}) — ${models} model(s) [${kindStr}]`);
		for (const e of okEps.sort((a, b) => a.port - b.port)) {
			const mode = e.mode === "router" ? " · 🌐 router mode" : e.mode === "single" ? " · single" : "";
			lines.push(`   • :${e.port} → ${e.models.length} model(s) · ${serverKindLabel(e.server)}${mode} · ${e.latencyMs ?? "?"}ms`);
		}
	}
	if (shared.lastError) lines.push("", `⚠️ Last error: ${shared.lastError}`);
	ctx.ui.notify(lines.join("\n"), "info");
}

// ── Native-style settings panel ────────────────────────────────────────────
// Same component pi's own /settings uses (SettingsList from pi-tui): label +
// current value per row, a description line under the list that explains the
// highlighted option, "Enter/Space to change · Esc to cancel" footer hint.

/**
 * Open a native-style settings panel (the same SettingsList pi's /settings
 * uses). Enter/Space cycles an item through its `values`; the description of
 * the highlighted item shows as a hint line under the list. onChange persists
 * via saveConfig; ids listed in onRerun also trigger a background rescan.
 * Resolves when the user presses Esc; false when TUI mode is unavailable.
 */
async function settingsPanel(
	ctx: ExtensionContext,
	title: string,
	items: SettingItem[],
	handlers: {
		onChange: (id: string, newValue: string) => void;
		onRerun?: string[];
	},
): Promise<boolean> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("⚙️ the config UI requires TUI mode", "warning");
		return false;
	}
	await ctx.ui.custom((_tui, theme, _kb, done: () => void) => {
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		const list = new SettingsList(
			items,
			Math.min(items.length, 12),
			getSettingsListTheme(),
			(id, newValue) => {
				handlers.onChange(id, newValue);
				if (handlers.onRerun?.includes(id)) {
					// Fire-and-forget: the panel keeps its focus; notifications land after.
					void depsOf.rescan(ctx);
				}
			},
			() => done(),
			{ enableSearch: true },
		);
		container.addChild(list);
		return {
			render: (w: number) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => list.handleInput(data),
		};
	});
	return true;
}

let currentDeps: Pick<UiDeps, "rescan"> = { rescan: async () => {} };
const depsOf = () => currentDeps;

const SETTING_LABELS: Record<string, string> = {
	discoveryTimeoutMs: "Discovery timeout",
	pollIntervalMs: "Poll interval",
	pollMaxMs: "Poll budget",
	startupGraceMs: "Startup grace",
	knownGoodFailLimit: "Known-good fail limit",
	detectVision: "Vision detection",
	prefixModelIds: "Prefix model IDs",
	showBadgesInNames: "Badges in names",
	includeUnloadedRouterModels: "Include unloaded models",
	maxOutputTokens: "Max output tokens",
	requestTimeoutMs: "Request timeout",
	warmup: "Header warmup",
};
function settingLabel(id: string): string {
	return SETTING_LABELS[id] ?? id;
}

const ON_OFF: [string, string] = ["true", "false"];
const onOff = (b: boolean) => (b ? "true" : "false");

// ── Model list ─────────────────────────────────────────────────────────────
export async function showModelList(ctx: ExtensionContext): Promise<void> {
	const models = shared.lastModels;
	if (models.length === 0) {
		ctx.ui.notify("🦙 no models discovered — try /llama-infra scan", "warning");
		return;
	}
	const epByBaseUrl = new Map<string, EndpointResult>();
	for (const ep of shared.lastScan?.endpoints ?? []) epByBaseUrl.set(ep.baseUrl, ep);
	const metaFor = (m: PiModel): ModelMetadata | undefined => {
		const ep = epByBaseUrl.get(m.baseUrl);
		if (!ep) return undefined;
		for (const [rawId, meta] of ep.meta) {
			if (m.serverModelId === rawId || m.id === rawId) return meta;
		}
		return undefined;
	};

	const lines: string[] = [`🦙 ${models.length} discovered`, ""];
	for (const m of models) {
		const ep = epByBaseUrl.get(m.baseUrl);
		const where = ep ? `${ep.label}:${ep.port} (${serverKindLabel(ep.server)}${ep.mode === "router" ? ", router" : ""})` : m.baseUrl;
		const meta = metaFor(m);
		const md = metadataBadges({
			quant: m.quant ?? meta?.quant,
			cacheK: m.cacheK ?? meta?.cacheK,
			cacheV: m.cacheV ?? meta?.cacheV,
			// Manual `vision` overrides (e.g. vLLM) land in metadata; local mmproj detection is the fallback.
			vision: meta?.vision ?? m.input.includes("image"),
			drafter: m.drafter ?? meta?.drafter,
			routerStatus: m.routerStatus ?? meta?.routerStatus,
		}, ep?.server);
		const ctxWin = formatCtx(m.contextWindow);
		const status = m.routerStatus && m.routerStatus !== "loaded" ? ` · [${m.routerStatus}]` : "";
		lines.push(`   • ${m.name}`, `     ${m.id} — ${where}${md} · ctx ${ctxWin || "?"}${status}`);
	}
	ctx.ui.notify(lines.join("\n"), "info");
}

export function showHelp(ctx: ExtensionContext): void {
	ctx.ui.notify(
		[
			"🦙 llama-infra — llama.cpp & variants (ZINC, ds4, lucebox, LM Studio, vLLM)",
			"",
			"  /llama-infra            → status",
			"  /llama-infra config     → ⚙️ settings",
			"  /llama-infra scan       → rescan",
			"  /llama-infra status     → per-endpoint report",
			"  /llama-infra list       → models with quant/vision/drafter",
			"  /llama-infra metrics    → toggle live speed & metrics in the footer",
			"  (footer: ⚡ prefill + 🔥 generation speed of the active model, shown in",
			"   the status line; when pi is idle it also mirrors other clients from /metrics)",
			"",
			`Config: ${getConfigPath()}`,
		].join("\n"),
		"info",
	);
}

// ── Config menu ────────────────────────────────────────────────────────────
export async function showConfigMenu(ctx: ExtensionContext, deps: UiDeps): Promise<void> {
	currentDeps = deps;
	const config = shared.activeConfig!;
	for (;;) {
		const budgetCount = Object.values(modelOptions()).filter((o) => o.thinkingBudgets).length;
		const action = await selectFrom(ctx, "🦙 Configuration", [
			{ value: "servers", label: "🌐 Servers", description: `${config.servers.filter((s) => s.enabled).length}/${config.servers.length} enabled` },
			{ value: "scan", label: "🔍 Scan now", description: "rediscover models on all enabled servers" },
			{ value: "models", label: "📋 Discovered models", description: `${shared.registeredCount} currently registered` },
			{ value: "test", label: "🧪 Test connectivity", description: "probe every endpoint and show latency" },
			{ value: "budgets", label: "🧠 Thinking budgets", description: `${budgetCount} model(s) with budgets` },
			{
				value: "cost",
				label: `💰 Energy cost: ${config.settings.costTracking ? "ON" : "OFF"}`,
				description: `currency ${currencySymbol(config.settings.currency)} · kW/tariff per server under 🌐 Servers`,
			},
			{
				value: "metrics",
				label: `📈 Live speed & metrics: ${config.settings.metricsEnabled ? "ON" : "OFF"}`,
				description: `per-token speed · server poll ${formatMs(config.settings.metricsPollMs)}`,
			},
			{ value: "settings", label: "⚙️ Discovery settings", description: "timeouts, polling, vision, badges… (native panel)" },
			{ value: "reset", label: "♻️ Reset settings", description: "restore all discovery settings to their defaults" },
			{ value: "about", label: "ℹ️ About", description: "how this extension works" },
			{ value: "close", label: "🚪 Close", description: "" },
		]);
		if (action === undefined || action === "close") return;
		switch (action) {
			case "servers":
				await showServersMenu(ctx, deps);
				break;
			case "scan":
				await deps.rescan(ctx);
				ctx.ui.notify("🔎 Scan complete", "info");
				break;
			case "models":
				await showModelList(ctx);
				break;
			case "test":
				await testConnectivity(ctx);
				break;
			case "budgets":
				await showThinkingBudgetsMenu(ctx, deps);
				break;
			case "cost":
				await showCostMenu(ctx, deps);
				break;
			case "metrics":
				await showMetricsMenu(ctx, deps);
				break;
			case "settings":
				await showSettingsMenu(ctx, deps);
				break;
			case "reset": {
				const ok = await ctx.ui.confirm("♻️ Reset settings", "Restore all discovery settings to their defaults?");
				if (ok) {
					config.settings = { ...DEFAULT_SETTINGS };
					saveConfig(config);
					ctx.ui.notify("♻️ Settings reset to defaults", "info");
					await deps.rescan(ctx);
				}
				break;
			}
			case "about":
				ctx.ui.notify(
					[
						"🦙 llama-infra",
						"",
						"Discovers models served by llama.cpp, ZINC, DwarfStar (ds4), lucebox,",
						"LM Studio and vLLM on any number of machines, and registers them into",
						"pi's native /model list. Per-model metadata, thinking budgets,",
						"live metrics, header warmup. See README for details.",
						"",
						`Config: ${getConfigPath()}`,
					].join("\n"),
					"info",
				);
				break;
		}
	}
}

// ── Servers menu ───────────────────────────────────────────────────────────
async function showServersMenu(ctx: ExtensionContext, deps: UiDeps): Promise<void> {
	const config = shared.activeConfig!;
	for (;;) {
		const items: Array<{ value: string; label: string; description?: string }> = [];
		for (const srv of config.servers) {
			const state = !srv.enabled ? "⛔" : isServerUp(srv.id) ? "🟢" : "🔴";
			const models = countServerModels(srv.id);
			items.push({
				value: srv.id,
				label: `${state} ${serverLabel(srv)}`,
				description: `${srv.host} · ${srv.ports.length} port(s)${srv.enabled ? ` · ${models} model(s)` : " · disabled"}`,
			});
		}
		items.push({ value: "__add", label: "➕ Add server", description: "register a new machine" });
		items.push({ value: "__back", label: "← Back", description: "" });

		const picked = await selectFrom(ctx, "🌐 Servers — select to edit", items);
		if (picked === undefined || picked === "__back") return;
		if (picked === "__add") {
			await addServerFlow(ctx, deps);
			continue;
		}
		const srv = config.servers.find((s) => s.id === picked);
		if (srv) await showServerMenu(ctx, srv, deps);
	}
}

async function showServerMenu(ctx: ExtensionContext, srv: ServerConfig, deps: UiDeps): Promise<void> {
	const config = shared.activeConfig!;
	for (;;) {
		const state = !srv.enabled ? "⛔ disabled" : isServerUp(srv.id) ? "🟢 online" : "🔴 offline";
		const action = await selectFrom(ctx, `🖥️ ${serverLabel(srv)} — ${srv.host} · ${state}`, [
			{ value: "host", label: "✏️ Change host", description: `currently: ${srv.host}` },
			{ value: "label", label: "🏷️ Change label", description: `currently: ${serverLabel(srv)}` },
			{ value: "ports", label: "🔌 Edit ports", description: `currently: ${srv.ports.join(", ")}` },
			{
				value: "toggle",
				label: srv.enabled ? "🔴 Disable server" : "🟢 Enable server",
				description: srv.enabled ? "stop probing this machine" : "start probing this machine",
			},
			{
				value: "ds4",
				label: `🕵️ ds4 probe: ${srv.probeDs4 ? "ON" : "OFF"}`,
				description: "ping /v1/chat/completions when /v1/models fails",
			},
			{
				value: "key",
				label: srv.apiKey ? "🔑 API key: set" : "🔑 API key: none",
				description: srv.apiKey ? "clear or replace bearer token" : "optional",
			},
			{
				value: "cost",
				label: srv.costProfile?.kW ? `💰 Energy cost: ${formatProfile(srv.costProfile, config.settings.currency)}` : "💰 Energy cost: not set",
				description: "power draw during inference (kW) + electricity tariff",
			},
			{ value: "test", label: "🧪 Test this server", description: `probe ${srv.ports.length} port(s) now` },
			{ value: "delete", label: "🗑️ Delete server", description: "remove from configuration" },
			{ value: "__back", label: "← Back", description: "" },
		]);
		if (action === undefined || action === "__back") return;

		switch (action) {
			case "host": {
				const host = await ctx.ui.input("✏️ New host (IP or hostname)", srv.host);
				if (host === undefined) break;
				const trimmed = host.trim();
				if (!trimmed) {
					ctx.ui.notify("❌ Host cannot be empty", "error");
					break;
				}
				const dup = config.servers.find((s) => s.id !== srv.id && serversShareEndpoint(s, { host: trimmed, ports: srv.ports }));
				if (dup) {
					const sharedPorts = srv.ports.filter((p) => dup.ports.includes(p)).join(", ");
					ctx.ui.notify(
						`⚠️ Server "${serverLabel(dup)}" already probes ${trimmed}:${sharedPorts} — pick a different host`,
						"warning",
					);
					break;
				}
				srv.host = trimmed;
				saveConfig(config);
				ctx.ui.notify(`✅ Host updated: ${srv.host}`, "info");
				await deps.rescan(ctx);
				break;
			}
			case "label": {
				const label = await ctx.ui.input("🏷️ Label for menus", serverLabel(srv));
				if (label === undefined) break;
				srv.label = label.trim();
				saveConfig(config);
				ctx.ui.notify(`✅ Label updated: ${serverLabel(srv)}`, "info");
				break;
			}
			case "ports": {
				const raw = await ctx.ui.input("🔌 Ports (e.g. 8000, 8080-8082)", srv.ports.join(", "));
				if (raw === undefined) break;
				const ports = parsePorts(raw);
				if (!ports) {
					ctx.ui.notify("❌ No valid ports in input", "error");
					break;
				}
				srv.ports = ports;
				saveConfig(config);
				ctx.ui.notify(`✅ Ports updated: ${ports.join(", ")}`, "info");
				await deps.rescan(ctx);
				break;
			}
			case "toggle":
				srv.enabled = !srv.enabled;
				saveConfig(config);
				ctx.ui.notify(`${srv.enabled ? "🟢 Enabled" : "🔴 Disabled"}: ${serverLabel(srv)}`, "info");
				await deps.rescan(ctx);
				break;
			case "ds4":
				srv.probeDs4 = !srv.probeDs4;
				saveConfig(config);
				ctx.ui.notify(`🕵️ ds4 probe ${srv.probeDs4 ? "ON" : "OFF"} for ${serverLabel(srv)}`, "info");
				await deps.rescan(ctx);
				break;
			case "key": {
				if (srv.apiKey) {
					const clear = await ctx.ui.confirm("🔑 API key", `A key is set for ${serverLabel(srv)}. Clear it?`);
					if (clear) {
						delete srv.apiKey;
						saveConfig(config);
						ctx.ui.notify("🔑 API key cleared", "info");
						await deps.rescan(ctx);
					}
				} else {
					const key = await ctx.ui.input("🔑 API key (bearer token)", "sk-…");
					if (key === undefined) break;
					const trimmed = key.trim();
					if (!trimmed) break;
					srv.apiKey = trimmed;
					saveConfig(config);
					ctx.ui.notify("🔑 API key saved", "info");
					await deps.rescan(ctx);
				}
				break;
			}
			case "cost": {
				await showServerCostMenu(ctx, srv, config);
				break;
			}
			case "test": {
				ctx.ui.setStatus("llama-infra", "🧪 testing…");
				const localServers = config.settings.detectVision ? scanLocalServers() : new Map();
				const results = await Promise.all(
					srv.ports.map((port) => fetchModelsFromEndpoint(srv, port, config.settings, localServers)),
				);
				const lines = [
					`🧪 ${serverLabel(srv)} (${srv.host}) — ${results.filter((r) => r.ok).length}/${results.length} endpoints up`,
					"",
				];
				for (const r of results.sort((a, b) => a.port - b.port)) {
					if (r.ok) {
						const mode = r.mode === "router" ? " · router" : "";
						lines.push(`✅ :${r.port} — ${r.models.length} model(s) · ${serverKindLabel(r.server)}${mode} · ${r.latencyMs ?? "?"}ms`);
					} else if (r.loading) {
						lines.push(`⏳ :${r.port} — loading model…`);
					} else {
						lines.push(`❌ :${r.port} — ${r.error?.slice(0, 70) ?? "unreachable"}`);
					}
				}
				ctx.ui.notify(lines.join("\n"), "info");
				deps.updateStatusFooter(ctx);
				break;
			}
			case "delete": {
				const sure = await ctx.ui.confirm(
					"🗑️ Delete server",
					`Remove "${serverLabel(srv)}" (${srv.host}) from the configuration?`,
				);
				if (sure) {
					config.servers = config.servers.filter((s) => s.id !== srv.id);
					saveConfig(config);
					ctx.ui.notify(`🗑️ Deleted: ${serverLabel(srv)}`, "info");
					await deps.rescan(ctx);
					return;
				}
				break;
			}
		}
	}
}

async function addServerFlow(ctx: ExtensionContext, deps: UiDeps): Promise<void> {
	const config = shared.activeConfig!;
	const host = await ctx.ui.input("➕ Add server — host (IP or tailnet name)", "e.g. 192.168.1.20 or mybox");
	if (host === undefined) return;
	const trimmedHost = host.trim();
	if (!trimmedHost) {
		ctx.ui.notify("❌ Host cannot be empty", "error");
		return;
	}
	const portsRaw = await ctx.ui.input("➕ Ports to probe", "e.g. 1234, 8000, 8080-8082");
	if (portsRaw === undefined) return;
	const ports = parsePorts(portsRaw);
	if (!ports) {
		ctx.ui.notify("❌ No valid ports in input", "error");
		return;
	}
	const dup = config.servers.find((s) => serversShareEndpoint(s, { host: trimmedHost, ports }));
	if (dup) {
		const sharedPorts = ports.filter((p) => dup.ports.includes(p)).join(", ");
		ctx.ui.notify(
			`⚠️ Server "${serverLabel(dup)}" already probes ${trimmedHost}:${sharedPorts} — use different ports`,
			"warning",
		);
		return;
	}
	const label = await ctx.ui.input("🏷️ Label (optional)", trimmedHost);
	if (label === undefined) return;
	const probeDs4 = await ctx.ui.confirm(
		"🕵️ ds4 (DwarfStar) probe?",
		"Enable the chat-completions ping probe for this machine? (for DwarfStar/ds4 hosts)",
	);

	let id = idSafeHost(trimmedHost).replace(/[^a-z0-9.-]/g, "-");
	let n = 2;
	while (config.servers.some((s) => s.id === id)) id = `${idSafeHost(trimmedHost).replace(/[^a-z0-9.-]/g, "-")}-${n++}`;

	config.servers.push({ id, host: trimmedHost, label: label.trim() || undefined, ports, enabled: true, probeDs4 });
	saveConfig(config);
	ctx.ui.notify(`➕ Server added: ${label.trim() || trimmedHost} (${trimmedHost}) — ports ${ports.join(", ")}`, "info");
	await deps.rescan(ctx);

	// Per-machine energy cost: offered right after adding, since it belongs to
	// the machine's own configuration (also editable later under 🌐 Servers).
	const srv = config.servers.find((s) => s.id === id)!;
	const wantCost = await ctx.ui.confirm("💰 Energy cost?", "Set this machine's power draw (kW) and tariff to estimate electricity cost of local inference?");
	if (wantCost) await showServerCostMenu(ctx, srv, config);
}

// ── Thinking budgets ───────────────────────────────────────────────────────
async function showThinkingBudgetsMenu(ctx: ExtensionContext, deps: UiDeps): Promise<void> {
	const config = shared.activeConfig!;
	const models = shared.lastModels;
	for (;;) {
		const entries = Object.entries(modelOptions()).filter(([, o]) => o.thinkingBudgets);
		const items: Array<{ value: string; label: string; description?: string }> = [];
		for (const m of models) {
			const opts = modelOptions()[m.id];
			items.push({
				value: m.id,
				label: `🧠 ${m.name}`,
				description: budgetsSummary(opts?.thinkingBudgets),
			});
		}
		for (const [id, opts] of entries) {
			if (models.some((m) => m.id === id)) continue;
			items.push({
				value: id,
				label: `🧠 ${id}`,
				description: `${budgetsSummary(opts.thinkingBudgets)} (not online)`,
			});
		}
		if (items.length === 0) {
			const info = await ctx.ui.confirm(
				"🧠 Thinking budgets",
				"No models discovered yet. Run /llama-infra scan first, then come back. Open help?",
			);
			if (info) showHelp(ctx);
			return;
		}
		items.push({ value: "__back", label: "← Back", description: "" });
		const picked = await selectFrom(ctx, "🧠 Thinking budgets — pick a model", items);
		if (picked === undefined || picked === "__back") return;
		const changed = await editModelBudgets(ctx, picked);
		if (changed) {
			saveConfig(config);
			ctx.ui.notify("🧠 Budgets saved — re-registering", "info");
			await deps.rescan(ctx);
		}
	}
}

async function editModelBudgets(ctx: ExtensionContext, modelId: string): Promise<boolean> {
	const config = shared.activeConfig!;
	let changed = false;
	for (;;) {
		const opts = (modelOptions()[modelId] ??= {} as ModelOptions);
		opts.thinkingBudgets ??= {};
		const b = opts.thinkingBudgets;
		const action = await selectFrom(ctx, `🧠 Budgets for ${modelId}`, [
			{ value: "minimal", label: `minimal: ${b.minimal ?? "—"}`, description: "" },
			{ value: "low", label: `low: ${b.low ?? "—"}`, description: "" },
			{ value: "medium", label: `medium: ${b.medium ?? "—"}`, description: "" },
			{ value: "high", label: `high: ${b.high ?? "—"}`, description: "xhigh/max clamp to this value" },
			{ value: "clear", label: "🗑️ Clear all budgets", description: "" },
			{ value: "__back", label: "← Back", description: "" },
		]);
		if (action === undefined || action === "__back") return changed;

		if (action === "clear") {
			delete config.modelOptions[modelId];
			ctx.ui.notify(`🗑️ Budgets cleared for ${modelId}`, "info");
			return true;
		}

		const current = b[action as keyof ThinkingBudgets];
		const value = await selectFrom(ctx, `🧠 ${action} budget (tokens)`, [
			...(current !== undefined ? [{ value: -1, label: "❌ Clear this level", description: "fall back to pi's global budget" }] : []),
			{ value: 512, label: "512" },
			{ value: 1024, label: "1,024" },
			{ value: 2048, label: "2,048" },
			{ value: 4096, label: "4,096" },
			{ value: 8192, label: "8,192" },
			{ value: 16384, label: "16,384" },
			{ value: 32768, label: "32,768" },
			{ value: 65536, label: "65,536" },
			{ value: -2, label: "✏️ Custom value…", description: "enter any token count" },
		]);
		if (value === undefined) continue;
		if (value === -1) {
			delete b[action as keyof ThinkingBudgets];
			changed = true;
			ctx.ui.notify(`❌ ${action} budget cleared`, "info");
		} else if (value === -2) {
			const raw = await ctx.ui.input("✏️ Custom budget (tokens)", String(current ?? 4096));
			if (raw === undefined) continue;
			const parsed = parseInt(raw.trim(), 10);
			if (isNaN(parsed) || parsed < 0) {
				ctx.ui.notify("❌ Invalid token count", "error");
				continue;
			}
			b[action as keyof ThinkingBudgets] = parsed;
			changed = true;
			ctx.ui.notify(`🧠 ${action} budget = ${parsed}`, "info");
		} else {
			b[action as keyof ThinkingBudgets] = value;
			changed = true;
			ctx.ui.notify(`🧠 ${action} budget = ${value}`, "info");
		}
		if (Object.keys(b).length === 0) delete opts.thinkingBudgets;
	}
}

// ── Metrics menu ───────────────────────────────────────────────────────────
async function showMetricsMenu(ctx: ExtensionContext, deps: UiDeps): Promise<void> {
	const config = shared.activeConfig!;
	for (;;) {
		const action = await selectFrom(ctx, "📈 Live speed & metrics", [
			{
				value: "toggle",
				label: config.settings.metricsEnabled ? "🔴 Disable footer speed metrics" : "🟢 Enable footer speed metrics",
				description: "⚡ prefill + 🔥 generation speed per token; server /metrics supplement",
			},
			{
				value: "interval",
				label: `🔁 Server poll: ${formatMs(config.settings.metricsPollMs)}`,
				description: "how often the /metrics endpoint is fetched (supplement only)",
			},
			{ value: "__back", label: "← Back", description: "" },
		]);
		if (action === undefined || action === "__back") return;
		if (action === "toggle") {
			await deps.toggleMetrics(ctx);
		} else if (action === "interval") {
			const v = await selectFrom(
				ctx,
				"🔁 Metrics poll interval",
				[2000, 3000, 5000, 10_000, 15_000].map((ms) => ({ value: ms, label: formatMs(ms) })),
			);
			if (v !== undefined) {
				config.settings.metricsPollMs = v;
				saveConfig(config);
				deps.restartMetricsPolling(ctx);
				ctx.ui.notify(`🔁 Metrics poll interval: ${formatMs(v)}`, "info");
			}
		}
	}
}

// ── Energy-cost menu ────────────────────────────────────────────────────
async function showCostMenu(ctx: ExtensionContext, deps: UiDeps): Promise<void> {
	const config = shared.activeConfig!;
	for (;;) {
		const withKw = config.servers.filter((s) => s.costProfile && s.costProfile.kW > 0);
		const action = await selectFrom(ctx, `💰 Energy cost (${currencySymbol(config.settings.currency)})`, [
			{
				value: "toggle",
				label: config.settings.costTracking ? "🔴 Disable cost tracking" : "🟢 Enable cost tracking",
				description: "accumulate electricity cost of local inference (footer + usage.cost)",
			},
			{
				value: "currency",
				label: `💱 Currency: ${CURRENCIES.find((c) => c.code === config.settings.currency)?.label ?? config.settings.currency}`,
				description: "display unit for costs and tariffs",
			},
			{
				value: "servers",
				label: "🖥️ Per-server kW / tariff…",
				description: `${withKw.length} configured — edit under 🌐 Servers → machine`,
			},
			{ value: "__back", label: "← Back", description: "" },
		]);
		if (action === undefined || action === "__back") return;

		if (action === "toggle") {
			config.settings.costTracking = !config.settings.costTracking;
			saveConfig(config);
			deps.updateStatusFooter(ctx);
			ctx.ui.notify(`💰 Cost tracking: ${config.settings.costTracking ? "ON" : "OFF"}`, "info");
		}
		else if (action === "currency") {
			const cur = await selectFrom(ctx, "💱 Select currency", CURRENCIES.map((c) => ({ value: c.code, label: c.label })));
			if (cur) {
				config.settings.currency = cur;
				saveConfig(config);
				ctx.ui.notify(`💱 Currency: ${CURRENCIES.find((c) => c.code === cur)?.label}`, "info");
			}
		}
		else if (action === "servers") {
			await showServersMenu(ctx, deps);
		}
	}
}

/** Per-machine energy cost (kW + tariff). Lives inside the server's own menu. */
async function showServerCostMenu(ctx: ExtensionContext, srv: ServerConfig, config: NonNullable<typeof shared.activeConfig>): Promise<void> {
	for (;;) {
		const p = srv.costProfile;
		const sub = await selectFrom(ctx, `💰 ${serverLabel(srv)} — energy cost`, [
			{ value: "kW", label: p?.kW ? `⚡ Power draw: ${p.kW} kW` : "⚡ Set power draw (kW)", description: "watts consumed during inference, e.g. 0.15 for 150 W" },
			{ value: "rate", label: p?.ratePerKwh ? `🧾 Tariff: ${p.ratePerKwh} ${currencySymbol(config.settings.currency)}/kWh` : `🧾 Set tariff (${currencySymbol(config.settings.currency)}/kWh)`, description: "electricity price per kWh" },
			...(p?.kW || p?.ratePerKwh ? [{ value: "clear", label: "🗑️ Remove cost profile", description: "stop estimating cost for this machine" }] : []),
			{ value: "__back", label: "← Back", description: "" },
		]);
		if (!sub || sub === "__back") return;

		if (sub === "kW") {
			const raw = await ctx.ui.input("⚡ Power draw in kW (e.g. 0.15 = 150 W)", p?.kW ? String(p.kW) : "0.15");
			const kW = parseFloat(raw ?? "");
			if (isNaN(kW) || kW <= 0) { ctx.ui.notify("❌ Invalid kW", "error"); continue; }
			srv.costProfile = { ...(srv.costProfile ?? { ratePerKwh: 0.2 }), kW };
			saveConfig(config);
			ctx.ui.notify(`⚡ ${serverLabel(srv)}: ${kW} kW`, "info");
		}
		else if (sub === "rate") {
			const raw = await ctx.ui.input(`🧾 Tariff in ${currencySymbol(config.settings.currency)}/kWh (e.g. 0.21)`, p?.ratePerKwh ? String(p.ratePerKwh) : "0.21");
			const rate = parseFloat(raw ?? "");
			if (isNaN(rate) || rate <= 0) { ctx.ui.notify("❌ Invalid tariff", "error"); continue; }
			srv.costProfile = { ...(srv.costProfile ?? { kW: 0.15 }), ratePerKwh: rate };
			saveConfig(config);
			ctx.ui.notify(`🧾 ${serverLabel(srv)}: ${rate} ${currencySymbol(config.settings.currency)}/kWh`, "info");
		}
		else if (sub === "clear") {
			delete srv.costProfile;
			saveConfig(config);
			ctx.ui.notify(`🗑️ ${serverLabel(srv)}: cost profile removed`, "info");
		}
	}
}

// ── Settings menu (native pi /settings style: description hint per option) ──
async function showSettingsMenu(ctx: ExtensionContext, deps: UiDeps): Promise<void> {
	currentDeps = deps;
	const s = shared.activeConfig!.settings;
	const fmt = (arr: number[]) => arr.map((v) => formatMs(v));

	const buildItems = (): SettingItem[] => [
		{
			id: "discoveryTimeoutMs",
			label: "Discovery timeout",
			description: "How long to wait for a server to answer before giving up on it. Raise it for machines that wake from sleep.",
			currentValue: formatMs(s.discoveryTimeoutMs),
			values: fmt([500, 1000, 1500, 2000, 3000, 5000]),
		},
		{
			id: "pollIntervalMs",
			label: "Poll interval",
			description: "How often llama-infra re-checks, in the background, servers that are still loading a model.",
			currentValue: formatMs(s.pollIntervalMs),
			values: fmt([2000, 3000, 4000, 5000, 10_000]),
		},
		{
			id: "pollMaxMs",
			label: "Poll budget",
			description: "Total time the background poller keeps retrying loading servers before it stops. Any new scan restarts it.",
			currentValue: formatMs(s.pollMaxMs),
			values: fmt([30_000, 60_000, 90_000, 120_000, 300_000]),
		},
		{
			id: "startupGraceMs",
			label: "Startup grace",
			description: "Extra patience at pi startup while no server has answered yet, so slow machines still get discovered.",
			currentValue: formatMs(s.startupGraceMs),
			values: fmt([10_000, 20_000, 40_000, 60_000, 120_000]),
		},
		{
			id: "knownGoodFailLimit",
			label: "Known-good fail limit",
			description: "Consecutive probe failures tolerated on an endpoint that used to work, before it is marked offline.",
			currentValue: String(s.knownGoodFailLimit),
			values: ["1", "2", "3", "5", "10"],
		},
		{
			id: "detectVision",
			label: "Vision detection",
			description: "Detect image-capable models (mmproj files, /proc flags, server-reported modalities) and badge them 👁️.",
			currentValue: onOff(s.detectVision),
			values: ON_OFF,
		},
		{
			id: "prefixModelIds",
			label: "Prefix model IDs",
			description: 'Register IDs as "host:port/model" so the same model on several machines never collides.',
			currentValue: onOff(s.prefixModelIds),
			values: ON_OFF,
		},
		{
			id: "showBadgesInNames",
			label: "Badges in names",
			description: "Append 👁️ vision, 🚀 drafter and 💤 unloaded badges to model names in pi's model list.",
			currentValue: onOff(s.showBadgesInNames),
			values: ON_OFF,
		},
		{
			id: "includeUnloadedRouterModels",
			label: "Include unloaded models",
			description: "In router mode, also list models the server knows about but has not loaded (slower to switch to).",
			currentValue: onOff(s.includeUnloadedRouterModels),
			values: ON_OFF,
		},
		{
			id: "maxOutputTokens",
			label: "Max output tokens",
			description: "Ceiling sent as max_tokens for models that do not report their own limit. Raise it for longer generations.",
			currentValue: formatTokens(s.maxOutputTokens),
			values: [4_096, 8_192, 16_384, 24_576, 32_768, 49_152, 65_536].map((v) => formatTokens(v)),
		},
		{
			id: "requestTimeoutMs",
			label: "Request timeout",
			description: "Lower bound of the stream idle timeout for chat requests. Raise it if long local generations get aborted.",
			currentValue: formatMs(s.requestTimeoutMs),
			values: fmt([60_000, 300_000, 600_000, 1_200_000, 1_800_000, 3_600_000]),
		},
		{
			id: "warmup",
			label: "Header warmup",
			description: "Pre-cache the system prompt on llama.cpp-family servers so the first real reply starts warm (prompt-cache hit).",
			currentValue: onOff(s.warmup),
			values: ON_OFF,
		},
	];

const durationOpts: Record<string, number[]> = {
		discoveryTimeoutMs: [500, 1000, 1500, 2000, 3000, 5000],
		pollIntervalMs: [2000, 3000, 4000, 5000, 10_000],
		pollMaxMs: [30_000, 60_000, 90_000, 120_000, 300_000],
		startupGraceMs: [10_000, 20_000, 40_000, 60_000, 120_000],
		requestTimeoutMs: [60_000, 300_000, 600_000, 1_200_000, 1_800_000, 3_600_000],
	};
	const rescanOn = ["detectVision", "prefixModelIds", "showBadgesInNames", "includeUnloadedRouterModels", "maxOutputTokens"];

	await settingsPanel(
		ctx,
		"⚙️ Discovery settings",
		buildItems(),
		{
			onChange: (id, value) => {
				const config = shared.activeConfig!;
				const st = config.settings as Record<string, unknown>;
				switch (id) {
					case "detectVision":
					case "prefixModelIds":
					case "showBadgesInNames":
					case "includeUnloadedRouterModels":
					case "warmup":
						st[id] = value === "true";
						break;
					case "knownGoodFailLimit":
						config.settings.knownGoodFailLimit = parseInt(value, 10);
						break;
					case "maxOutputTokens": {
						const v = [4_096, 8_192, 16_384, 24_576, 32_768, 49_152, 65_536].find((n) => formatTokens(n) === value);
						if (v !== undefined) config.settings.maxOutputTokens = v;
						break;
					}
					default: {
						const opts = id === "warmup" ? undefined : durationOpts[id];
						const v = opts?.find((n) => formatMs(n) === value);
						if (v !== undefined) st[id] = v;
					}
				}
				saveConfig(config);
				ctx.ui.notify(`⚙️ ${settingLabel(id)} = ${value}`, "info");
			},
			onRerun: rescanOn,
		},
	);
}

// ── Connectivity test ──────────────────────────────────────────────────────

// ── Connectivity test ──────────────────────────────────────────────────────
export async function testConnectivity(ctx: ExtensionContext): Promise<void> {
	const config = shared.activeConfig!;
	const enabled = config.servers.filter((s) => s.enabled && s.ports.length > 0);
	if (enabled.length === 0) {
		ctx.ui.notify("🧪 No enabled servers to test", "warning");
		return;
	}
	ctx.ui.setStatus("llama-infra", "🧪 testing…");
	const localServers = config.settings.detectVision ? scanLocalServers() : new Map();
	const all: EndpointResult[] = [];
	for (const srv of enabled) {
		const results = await Promise.all(
			srv.ports.map((port) => fetchModelsFromEndpoint(srv, port, config.settings, localServers)),
		);
		all.push(...results);
	}
	const lines: string[] = ["🧪 Connectivity report", ""];
	for (const srv of enabled) {
		const eps = all.filter((e) => e.serverId === srv.id).sort((a, b) => a.port - b.port);
		const up = eps.filter((e) => e.ok).length;
		lines.push(`${up === eps.length ? "🟢" : up > 0 ? "🟡" : "🔴"} ${serverLabel(srv)} (${srv.host}) — ${up}/${eps.length}`);
		for (const e of eps) {
			if (e.ok) lines.push(`   ✅ :${e.port} — ${e.models.length} model(s) · ${serverKindLabel(e.server)}${e.mode === "router" ? " (router)" : ""} · ${e.latencyMs ?? "?"}ms`);
			else if (e.loading) lines.push(`   ⏳ :${e.port} — loading model…`);
			else lines.push(`   ❌ :${e.port} — ${e.error?.slice(0, 70) ?? "unreachable"}`);
		}
	}
	ctx.ui.notify(lines.join("\n"), "info");
	ctx.ui.setStatus("llama-infra", undefined);
}