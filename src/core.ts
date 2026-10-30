// Core: config persistence, constants, id helpers, shared mutable state.
// Statically imported by the entrypoint → must stay small.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
	CompatProfile,
	InfraConfig,
	ModelOptions,
	ServerConfig,
	ServerKind,
	SettingsConfig,
} from "./types.ts";

// ── Provider identity ───────────────────────────────────────────────────────
export const PROVIDER_NAME = "llama-infra";
export const STATUS_KEY = "llama-infra";
export const CONFIG_FILE = "llama-infra.json";
export const MODELS_CACHE_FILE = "llama-infra-models.json";
/** Old config/cache filenames, tried in order when the new-named file is absent. */
export const LEGACY_CONFIG_FILES = ["llamacpp-infra.json", "local-models.json"];
export const LEGACY_MODELS_CACHE_FILES = ["llamacpp-infra-models.json"];
export const METRICS_STATUS_KEY = "llama-infra-speed";
export const COST_STATUS_KEY = "llama-infra-cost";
export const DEFAULT_API_KEY = "no-auth";
export const THINKING_BUDGET_FIELD = "thinking_budget_tokens";
/** vLLM's thinking-budget field (differs from llama.cpp's). */
export const VLLM_THINKING_BUDGET_FIELD = "thinking_token_budget";
export const DEFAULT_MAX_OUTPUT_TOKENS = 32_768;
export const DEFAULT_PROVIDER_TIMEOUT_MS = 20 * 60 * 1000;

// ── Settings defaults ───────────────────────────────────────────────────────
export const DEFAULT_SETTINGS: SettingsConfig = {
	discoveryTimeoutMs: 2000,
	pollIntervalMs: 4000,
	pollMaxMs: 90_000,
	startupGraceMs: 40_000,
	maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
	requestTimeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS,
	knownGoodFailLimit: 3,
	detectVision: true,
	prefixModelIds: true,
	warmup: true,
	metricsEnabled: true,
	metricsPollMs: 5000,
	includeUnloadedRouterModels: false,
	showBadgesInNames: true,
	currency: "eur",
	costTracking: true,
};

export const DEFAULT_SERVERS: ServerConfig[] = [
	{
		id: "local",
		host: "127.0.0.1",
		label: "Local",
		ports: [8000, 8001, 8002, 8080, 8081, 8082, 1234],
		enabled: true,
		probeDs4: false,
	},
];

// ── Debug logging ──────────────────────────────────────────────────────────
export const DEBUG = process.env.PI_LLAMA_INFRA_DEBUG === "1" || process.env.PI_LLAMA_INFRA_DEBUG === "true";
export function debugLog(...args: unknown[]): void {
	if (DEBUG) console.debug(`[llama-infra]`, ...args);
}

// ── Config persistence ─────────────────────────────────────────────────────
export function getConfigPath(): string {
	return join(getAgentDir(), CONFIG_FILE);
}

/** Validate/normalize a raw cost profile from disk. */
export function parseCostProfile(raw: unknown): import("./types.ts").CostProfile | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const r = raw as Record<string, unknown>;
	const kW = typeof r.kW === "number" ? r.kW : parseFloat(String(r.kW ?? ""));
	const rate = typeof r.ratePerKwh === "number" ? r.ratePerKwh : parseFloat(String(r.ratePerKwh ?? ""));
	if (!Number.isFinite(kW) || kW <= 0 || !Number.isFinite(rate) || rate <= 0) return undefined;
	const p: import("./types.ts").CostProfile = { kW, ratePerKwh: rate };
	if (typeof r.label === "string" && r.label) p.label = r.label;
	if (typeof r.host === "string" && r.host) p.host = r.host;
	if (typeof r.pattern === "string" && r.pattern) p.pattern = r.pattern;
	return p;
}

const CURRENCY_CODES = new Set(["usd", "eur", "gbp", "cny"]);

/** Normalize a raw settings object onto the defaults (unknown keys dropped, bad values repaired). */
export function normalizeSettings(raw: unknown): SettingsConfig {
	const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const s: SettingsConfig = { ...DEFAULT_SETTINGS };
	for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof SettingsConfig>) {
		const v = r[key];
		if (typeof v === typeof DEFAULT_SETTINGS[key]) (s as Record<string, unknown>)[key] = v;
	}
	if (typeof r.currency === "string" && CURRENCY_CODES.has(r.currency as string)) s.currency = r.currency as SettingsConfig["currency"];
	return s;
}

/** True if two servers would collide on the same (host, port) endpoint. */
export function serversShareEndpoint(
	a: Pick<import("./types.ts").ServerConfig, "host" | "ports">,
	b: Pick<import("./types.ts").ServerConfig, "host" | "ports">,
): boolean {
	if (a.host !== b.host) return false;
	const aPorts = new Set(a.ports);
	return b.ports.some((p) => aPorts.has(p));
}

function normalizeServer(s: Record<string, unknown>): import("./types.ts").ServerConfig {
	return {
		id: String(s.id ?? "local"),
		host: String(s.host ?? "127.0.0.1"),
		...(typeof s.label === "string" && s.label ? { label: s.label } : {}),
		ports: Array.isArray(s.ports) ? s.ports.filter((p): p is number => typeof p === "number") : [],
		enabled: typeof s.enabled === "boolean" ? s.enabled : true,
		...(s.probeDs4 === true ? { probeDs4: true } : {}),
		...(typeof s.apiKey === "string" && s.apiKey ? { apiKey: s.apiKey } : {}),
		...(() => {
			const p = parseCostProfile(s.costProfile);
			return p ? { costProfile: p } : {};
		})(),
	};
}

/** Normalize the persisted per-model options: `thinkingBudgetField` accepts a
 *  field name, `false` or the words `none`/`off`/`disabled` (→ `false`), and a
 *  blank value falls back to the per-engine default (key dropped). */
function normalizeModelOptions(raw: unknown): Record<string, ModelOptions> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const out: Record<string, ModelOptions> = {};
	for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		const opts: ModelOptions = { ...(value as ModelOptions) };
		if ("thinkingBudgetField" in opts) {
			const parsed = parseThinkingBudgetFieldOption(opts.thinkingBudgetField);
			if (parsed === undefined) delete opts.thinkingBudgetField;
			else opts.thinkingBudgetField = parsed;
		}
		out[id] = opts;
	}
	return out;
}

export function loadConfig(): InfraConfig {
	const defaults: InfraConfig = {
		servers: DEFAULT_SERVERS,
		settings: { ...DEFAULT_SETTINGS },
		modelOptions: {},
	};
	const path = getConfigPath();
	if (existsSync(path)) {
		try {
			const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<InfraConfig>;
			return {
				servers: Array.isArray(raw.servers)
					? raw.servers.map((s) => normalizeServer(s as Record<string, unknown>))
					: defaults.servers,
				settings: normalizeSettings(raw.settings),
				modelOptions: normalizeModelOptions(raw.modelOptions),
			};
		} catch (err) {
			console.error(`[llama-infra] Config load error: ${err}`);
		}
		return defaults;
	}
	for (const legacyFile of LEGACY_CONFIG_FILES) {
		const legacyPath = join(getAgentDir(), legacyFile);
		if (!existsSync(legacyPath)) continue;
		try {
			const raw = JSON.parse(readFileSync(legacyPath, "utf-8")) as Partial<InfraConfig>;
			const migrated: InfraConfig = {
				servers: Array.isArray(raw.servers)
					? raw.servers.map((s) => normalizeServer(s as Record<string, unknown>))
					: defaults.servers,
				settings: normalizeSettings(raw.settings),
				modelOptions: normalizeModelOptions(raw.modelOptions),
			};
			debugLog(`migrated legacy config from ${legacyPath}`);
			return migrated;
		} catch {
			// try the next legacy file, then fall through to defaults
		}
	}
	return defaults;
}

export function saveConfig(config: InfraConfig): void {
	try {
		const dir = getAgentDir();
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), "utf-8");
		debugLog(`config saved to ${getConfigPath()}`);
	} catch (err) {
		console.error(`[llama-infra] Config save error: ${err}`);
	}
}

// ── Last-known-models cache ────────────────────────────────────────────────
// Lets a freshly booted pi process register the provider with the models from
// the previous scan IMMEDIATELY (synchronously, during the extension factory),
// so CLI consumers that resolve --model at startup (e.g. trimegisto sub-agents
// spawned as `pi -p --no-session --model provider/model`) find the model before
// the async discovery re-scan completes. The async scan then refreshes this
// registration with live data as usual.

const MODELS_CACHE_VERSION = 1;

/** JSON-safe projection of a registered PiModel (no secrets; headers re-derived). */
interface CachedModelEntry {
	id: string;
	name: string;
	baseUrl: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
	serverModelId: string;
	endpoint: import("./types.ts").PiModel["endpoint"];
	thinkingBudgets?: import("./types.ts").ThinkingBudgets;
	quant?: string;
	cacheK?: string;
	cacheV?: string;
	drafter?: string;
	routerStatus?: string;
}

interface ModelsCacheFile {
	version: number;
	savedAt: string;
	models: CachedModelEntry[];
}

export function getModelsCachePath(): string {
	return join(getAgentDir(), MODELS_CACHE_FILE);
}

/** Persist the last successfully registered models for fast boot on next process. */
export function saveModelsCache(models: import("./types.ts").PiModel[]): void {
	if (!models || models.length === 0) return;
	try {
		const file: ModelsCacheFile = {
			version: MODELS_CACHE_VERSION,
			savedAt: new Date().toISOString(),
			models: models.map((m) => ({
				id: m.id,
				name: m.name,
				baseUrl: m.baseUrl,
				reasoning: m.reasoning,
				input: m.input,
				contextWindow: m.contextWindow,
				maxTokens: m.maxTokens,
				serverModelId: m.serverModelId,
				endpoint: m.endpoint,
				thinkingBudgets: m.thinkingBudgets,
				quant: m.quant,
				cacheK: m.cacheK,
				cacheV: m.cacheV,
				drafter: m.drafter,
				routerStatus: m.routerStatus,
			})),
		};
		const dir = getAgentDir();
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(getModelsCachePath(), JSON.stringify(file), "utf-8");
		debugLog(`models cache saved (${models.length} model(s))`);
	} catch (err) {
		console.error(`[llama-infra] Models cache save error: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/** Load models cached by a previous scan, or null when absent/corrupt/empty. */
export function loadModelsCache(): import("./types.ts").PiModel[] | null {
	try {
		let path = getModelsCachePath();
		if (!existsSync(path)) {
			const legacy = LEGACY_MODELS_CACHE_FILES.map((f) => join(getAgentDir(), f)).find((p) => existsSync(p));
			if (!legacy) return null;
			path = legacy;
		}
		const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<ModelsCacheFile>;
		if (raw?.version !== MODELS_CACHE_VERSION || !Array.isArray(raw.models) || raw.models.length === 0) return null;
		return raw.models.map((c) => ({
			id: c.id,
			name: c.name,
			baseUrl: c.baseUrl,
			reasoning: c.reasoning,
			input: Array.isArray(c.input) && c.input.length > 0 ? c.input : (["text"] as ("text" | "image")[]),
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: c.contextWindow,
			maxTokens: c.maxTokens,
			compat: makeCompat(c.endpoint?.kind, modelOptionsFor(c.serverModelId || c.id)?.thinkingBudgetField),
			serverModelId: c.serverModelId,
			endpoint: c.endpoint,
			thinkingBudgets: c.thinkingBudgets,
			quant: c.quant,
			cacheK: c.cacheK,
			cacheV: c.cacheV,
			drafter: c.drafter,
			routerStatus: c.routerStatus,
		}));
	} catch (err) {
		debugLog(`models cache load failed: ${err instanceof Error ? err.message : String(err)}`);
		return null;
	}
}

/** Rebuild the shared maps (id↔raw, baseUrls, kinds, zinc) from cached models. */
export function applyCachedSharedState(models: import("./types.ts").PiModel[]): void {
	shared.zincModelIds.clear();
	shared.serverModelIds.clear();
	shared.compactModelIds.clear();
	shared.endpointKinds.clear();
	shared.modelBaseUrls.clear();
	for (const pm of models) {
		if (pm.endpoint?.kind === "zinc") {
			shared.zincModelIds.add(pm.id);
			shared.zincModelIds.add(pm.serverModelId);
		}
		shared.serverModelIds.set(pm.id, pm.serverModelId);
		if (!shared.compactModelIds.has(pm.serverModelId)) shared.compactModelIds.set(pm.serverModelId, pm.id);
		shared.endpointKinds.set(pm.baseUrl, pm.endpoint?.kind ?? "unknown");
		shared.modelBaseUrls.set(pm.id, pm.baseUrl);
	}
}

// ── Compat profile ─────────────────────────────────────────────────────────
export function supportsThinkingBudget(kind: ServerKind | "unknown" | "auto" | undefined): boolean {
	return kind === "llamacpp" || kind === "lucebox" || kind === "vllm";
}

/** Top-level thinking-budget field per server family (undefined = unsupported). */
export function thinkingBudgetField(
	kind: ServerKind | "unknown" | "auto" | undefined,
): string | undefined {
	if (kind === "vllm") return VLLM_THINKING_BUDGET_FIELD;
	if (kind === "llamacpp" || kind === "lucebox") return THINKING_BUDGET_FIELD;
	return undefined;
}

/** Resolve the thinking-budget request field for a concrete model: an explicit
 *  `modelOptions[id].thinkingBudgetField` wins over the per-kind default. Use a
 *  field name to force vLLM's `thinking_token_budget` on a server whose kind
 *  cannot be detected (renamed wrapper, remote SGLang/TGI, …), or `false` to
 *  send none at all on servers that reject unknown request fields. */
export function resolveThinkingBudgetField(
	modelId: string | undefined,
	kind: ServerKind | "unknown" | "auto" | undefined,
): string | undefined {
	const override = modelId ? modelOptionsFor(modelId)?.thinkingBudgetField : undefined;
	if (override === false) return undefined;
	if (typeof override === "string" && override.trim()) return override.trim();
	return thinkingBudgetField(kind);
}

/** Move llama.cpp's `thinking_budget_tokens` value onto the field THIS engine
 *  actually reads (vLLM: `thinking_token_budget`) — vLLM silently ignores the
 *  llama.cpp name, so changing the thinking level otherwise looks like a no-op.
 *  Returns the patched payload, or undefined when there was nothing to rename. */
export function renameThinkingBudgetField(
	payload: Record<string, unknown>,
	field: string,
): Record<string, unknown> | undefined {
	if (!field || field === THINKING_BUDGET_FIELD) return undefined;
	const value = payload[THINKING_BUDGET_FIELD];
	if (value === undefined) return undefined;
	const { [THINKING_BUDGET_FIELD]: _drop, ...rest } = payload;
	// If the engine field is already present (pi sent the right one), keep it and
	// just drop the llama.cpp-shaped duplicate.
	return rest[field] !== undefined ? rest : { ...rest, [field]: value };
}

export function makeCompat(
	kind: ServerKind | "unknown" | "auto",
	thinkingFieldOverride?: string | false,
): CompatProfile {
	const usageInStreaming = kind !== "zinc";
	// `false` is an explicit opt-out: the server rejects the field, so pi must not
	// send it and neither alias may re-introduce it.
	const disabled = thinkingFieldOverride === false;
	const override = typeof thinkingFieldOverride === "string" ? thinkingFieldOverride.trim() : "";
	const thinkingField = disabled ? undefined : override || thinkingBudgetField(kind);
	return {
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
		maxTokensField: "max_tokens" as const,
		supportsUsageInStreaming: usageInStreaming,
		supportsStrictMode: false,
		// pi sends chat_template_kwargs{enable_thinking,preserve_thinking} when the
		// format is "qwen-chat-template". halogen accepts it as-is
		// (/health.chat_template_kwargs) and defaults to reasoning_effort=xhigh, so
		// without this pi cannot turn its thinking OFF; llama.cpp Qwen templates read
		// the same kwargs natively. Non-Qwen templates simply ignore the extra vars.
		...(kind === "llamacpp" ? { thinkingFormat: "qwen-chat-template" as const } : {}),
		...(disabled
			? { thinkingTokenBudgetField: false as const, supportsThinkingTokenBudget: false }
			: thinkingField
				? { thinkingTokenBudgetField: thinkingField }
				: {}),
	};
}

// ── Shared mutable state ───────────────────────────────────────────────────
// Maps used by hooks + lazy modules. Kept in one place so lazy imports share
// them via static import of core.ts.
export const shared = {
	activeConfig: undefined as InfraConfig | undefined,
	zincModelIds: new Set<string>(),
	modelBaseUrls: new Map<string, string>(),
	endpointKinds: new Map<string, string>(),
	serverModelIds: new Map<string, string>(),
	compactModelIds: new Map<string, string>(),
	lastScan: undefined as import("./types.ts").ScanResult | undefined,
	lastModels: [] as import("./types.ts").PiModel[],
	registeredCount: 0,
	lastError: undefined as string | undefined,
	rIncludeUnloaded: false,
	/** Sticky halogen contexts (host:port -> positions). halogen learns the
	 *  context from /health, which probes the engine and can stall for seconds
	 *  under memory pressure; without sticky memory the context would flap to
	 *  the 32768 fallback and pi would "compact" at 33k on a 262k model. */
	halogenCtx: new Map<string, number>(),
};

export function setActiveConfig(c: InfraConfig | undefined): void {
	shared.activeConfig = c;
}

export function modelOptions(): Record<string, ModelOptions> {
	return shared.activeConfig?.modelOptions ?? {};
}

/** Resolve the `modelOptions` key that applies to a raw server model id:
 *  accepts the raw id, its registered compact id, the display id
 *  `<raw id> (host:port)`, or a legacy "host:port/<raw id>" key (the legacy
 *  form registration.ts migrates forward). */
export function modelOptionsKeyFor(rawId: string): string | undefined {
	if (!rawId) return undefined;
	const opts = modelOptions();
	if (opts[rawId]) return rawId;
	const compact = compactIdFor(rawId);
	if (compact && opts[compact]) return compact;
	// Display ids: "<raw id> (host:port)" (compact form registered in pi).
	const prefix = `${rawId} (`;
	for (const key of Object.keys(opts)) {
		if (key.startsWith(prefix) && key.endsWith(")")) return key;
	}
	// Legacy keys: "<host>:<port>/<raw id>" (see registration.ts migration).
	const rawSuffix = `/${rawId.replace(/^\/+/, "")}`;
	for (const key of Object.keys(opts)) {
		if (key.endsWith(rawSuffix)) return key;
	}
	return undefined;
}

/** Resolve per-model config overrides for a raw server model id (accepted key
 *  shapes: `modelOptionsKeyFor`). */
export function modelOptionsFor(rawId: string): ModelOptions | undefined {
	const key = modelOptionsKeyFor(rawId);
	return key ? modelOptions()[key] : undefined;
}

/** Values a user may type in the 🔤 Budget field prompt that mean "send no
 *  budget field at all" instead of naming a request field. */
const DISABLED_FIELD_VALUES = new Set(["none", "off", "false", "disable", "disabled", "-", "no"]);

/** Parse a raw `thinkingBudgetField` option: a field name, `false` (disabled),
 *  or undefined (auto per engine). Blank strings mean auto and the words in
 *  DISABLED_FIELD_VALUES mean disabled, so both can be typed in the menu. */
export function parseThinkingBudgetFieldOption(raw: unknown): string | false | undefined {
	if (raw === false) return false;
	if (typeof raw !== "string") return undefined;
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	if (DISABLED_FIELD_VALUES.has(trimmed.toLowerCase())) return false;
	return trimmed;
}

/** True when the model explicitly opted out of any thinking-budget field. */
export function thinkingBudgetFieldDisabled(modelId: string | undefined): boolean {
	if (!modelId) return false;
	return modelOptionsFor(modelId)?.thinkingBudgetField === false;
}

/** Persist "this model's server rejects the thinking-budget field" so pi stops
 *  sending it and llama-infra stops renaming into it. Called when a server
 *  answers with an explicit "… is not supported: thinking_token_budget" error.
 *  Returns true when the configuration actually changed. */
export function disableThinkingBudgetField(modelId: string | undefined): boolean {
	const config = shared.activeConfig;
	if (!config || !modelId) return false;
	const key = modelOptionsKeyFor(modelId) ?? compactIdFor(modelId) ?? modelId;
	const opts = (config.modelOptions[key] ??= {});
	if (opts.thinkingBudgetField === false) return false;
	opts.thinkingBudgetField = false;
	saveConfig(config);
	debugLog(`thinking-budget field disabled for ${key} (server rejected it)`);
	return true;
}

/** Remove every known thinking-budget field from a request payload (used when a
 *  model opted out, so a stale client cannot smuggle one back in). Returns the
 *  patched payload, or undefined when there was nothing to drop. */
export function stripThinkingBudgetFields(
	payload: Record<string, unknown>,
): Record<string, unknown> | undefined {
	let next: Record<string, unknown> | undefined;
	for (const field of [THINKING_BUDGET_FIELD, VLLM_THINKING_BUDGET_FIELD]) {
		if (payload[field] === undefined) continue;
		const { [field]: _drop, ...rest } = next ?? payload;
		next = rest;
	}
	return next;
}

/** Remove a per-model `maxTokens` override, preserving every other per-model
 *  option (thinkingBudgets / vision / drafter). The `modelOptions` entry itself
 *  is removed only when it becomes empty. Returns true when something changed. */
export function clearModelMaxTokens(modelId: string): boolean {
	const config = shared.activeConfig;
	const opts = config?.modelOptions?.[modelId];
	if (!config || !opts || opts.maxTokens === undefined) return false;
	delete opts.maxTokens;
	if (Object.keys(opts).length === 0) delete config.modelOptions[modelId];
	return true;
}

/** Compact id registered in pi for a raw server model id (or the input). */
export function compactIdFor(modelId: string | undefined): string | undefined {
	if (!modelId) return undefined;
	return shared.compactModelIds.get(modelId) ?? modelId;
}

/** Raw server-side id to send in requests for a registered model id (or the input). */
export function rawIdFor(modelId: string | undefined): string | undefined {
	if (!modelId) return undefined;
	return shared.serverModelIds.get(modelId) ?? modelId;
}

// ── Thinking-level normalization (used by the per-model budget hook) ──────
export function normalizeLevel(level: string | undefined): "minimal" | "low" | "medium" | "high" | undefined {
	switch (level) {
		case "minimal":
		case "low":
		case "medium":
		case "high":
			return level;
		case "xhigh":
		case "max":
			return "high";
		default:
			return undefined;
	}
}

// ── Server-label / id helpers ──────────────────────────────────────────────
export function serverLabel(srv: ServerConfig): string {
	return srv.label?.trim() || srv.host;
}

export function idSafeHost(host: string): string {
	return host.trim().toLowerCase() || "host";
}

export function isLocalHost(host: string): boolean {
	const h = host.trim().toLowerCase();
	return h === "127.0.0.1" || h === "localhost" || h === "::1";
}

export function baseName(p: string): string {
	const cleaned = p.replace(/\\/g, "/");
	const last = cleaned.split("/").pop() || cleaned;
	return last;
}