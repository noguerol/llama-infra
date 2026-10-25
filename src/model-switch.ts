// Model activation helpers: turn a user query into one discovered model, repair a
// session whose model stopped being served, and stop decorated ids from reaching a
// server that never heard of them.
//
// Pure functions only (no pi, no I/O) so the whole activation policy is testable
// without an ExtensionAPI. src/index.ts owns the pi.setModel() calls.

import type { PiModel, ServerConfig } from "./types.ts";

/** Trailing `(host:port)` disambiguation tag added by registration. */
const HOST_TAG_RE = /\(([^()]*?):(\d{1,5})\)$/;

/** `host:port` from a decorated id, or undefined when the id carries no tag. */
export function hostTagOf(id: string): string | undefined {
	const m = HOST_TAG_RE.exec(id);
	return m ? `${m[1]}:${m[2]}`.toLowerCase() : undefined;
}

/** Drop the trailing `(host:port)` tag (if any). */
export function withoutHostTag(id: string): string {
	return id.replace(HOST_TAG_RE, "").trimEnd();
}

/** Every `(host:port)` tag this extension can produce, for the servers it manages. */
export function endpointTags(servers: ServerConfig[]): Set<string> {
	const tags = new Set<string>();
	for (const srv of servers) for (const port of srv.ports) tags.add(`${srv.host}:${port}`.toLowerCase());
	return tags;
}

/** Separator-free lowercase form, so "flash next uncensored" matches `Flash-Next_Uncensored`. */
function norm(s: string): string {
	return s.toLowerCase().replace(/[\s_.\-/:]+/g, "");
}

function haystacks(m: PiModel): string[] {
	return [m.id, m.name ?? m.id, m.serverModelId ?? "", hostTagOf(m.id) ?? ""];
}

export interface PickResult {
	/** Highest-scoring models; length > 1 means the query is ambiguous. */
	matches: PiModel[];
	/** True when at least one match was an exact id/name/server-id hit. */
	exact: boolean;
}

const SCORE_EXACT = 100;
const SCORE_PREFIX = 60;
const SCORE_CONTAINS = 20;
const SCORE_SUBSEQ = 8;

/** Order-preserving subsequence test, for typo-tolerant suggestions. */
function isSubsequence(needle: string, hay: string): boolean {
	if (!needle) return false;
	let i = 0;
	for (const ch of hay) {
		if (ch === needle[i]) i++;
		if (i === needle.length) return true;
	}
	return false;
}

/**
 * Resolve a user query (registered id, display name, raw server id, or a fragment)
 * to the discovered models it best matches. Router models that are not loaded rank
 * below an equally good loaded one, so a bare fragment never silently picks a
 * sleeping model.
 */
export function pickModel(models: PiModel[], query: string): PickResult {
	const q = query.trim();
	if (!q) return { matches: [], exact: false };
	const lower = q.toLowerCase();
	const nq = norm(q);

	const scored: Array<{ model: PiModel; score: number }> = [];
	for (const m of models) {
		let score = 0;
		for (const hay of haystacks(m)) {
			if (!hay) continue;
			const h = hay.toLowerCase();
			const nh = norm(h);
			if (score < SCORE_EXACT && h === lower) score = SCORE_EXACT;
			else if (score < SCORE_PREFIX && h.startsWith(lower)) score = Math.max(score, SCORE_PREFIX);
			else if (score < SCORE_CONTAINS && nh.includes(nq)) score = Math.max(score, SCORE_CONTAINS);
			else if (score < SCORE_SUBSEQ && isSubsequence(nq, nh)) score = Math.max(score, SCORE_SUBSEQ);
		}
		if (score === 0) continue;
		if (m.routerStatus && m.routerStatus !== "loaded") score -= 5;
		scored.push({ model: m, score });
	}
	if (scored.length === 0) return { matches: [], exact: false };

	scored.sort((a, b) => b.score - a.score || a.model.id.localeCompare(b.model.id));
	const top = scored[0].score;
	return {
		matches: scored.filter((s) => s.score === top).map((s) => s.model),
		exact: top >= SCORE_PREFIX,
	};
}

/** Best-effort suggestions for a query that matched nothing. */
export function suggestIds(models: PiModel[], query: string, limit = 3): string[] {
	const nq = norm(query);
	const ranked = models
		.map((m) => {
			const nh = norm(m.id);
			const contains = nq && nh.includes(nq) ? 2 : 0;
			const subseq = nq && isSubsequence(nq, nh) ? 1 : 0;
			return { id: m.id, rank: contains + subseq };
		})
		.sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id));
	return ranked.slice(0, limit).map((r) => r.id);
}

export interface VanishedModel {
	/** The model this session was on, as registered before the rescan. */
	gone: PiModel;
	/** Models now served on the same endpoint — the only sane successors. */
	candidates: PiModel[];
}

/**
 * Detect that the session's current model disappeared from the newly registered
 * list (a model swap on a live server, or a server that came back with something
 * else). The session keeps its selection across `registerProvider()`, so without
 * this the next request carries an id the server rejects.
 */
export function detectVanishedModel(
	previous: PiModel[],
	next: PiModel[],
	currentModelId: string | undefined,
): VanishedModel | undefined {
	if (!currentModelId) return undefined;
	if (next.some((m) => m.id === currentModelId)) return undefined;
	const gone = previous.find((m) => m.id === currentModelId);
	if (!gone) return undefined;
	const candidates = next.filter(
		(m) => m.endpoint?.host === gone.endpoint?.host && m.endpoint?.port === gone.endpoint?.port,
	);
	return { gone, candidates };
}

/**
 * Recover the raw server id for a decorated id that the id map misses, but only
 * when a registered id agrees after the `(host:port)` tag is trimmed off — the
 * same model on the same endpoint, spelled differently (an id rebuilt across a
 * naming change, or with stray whitespace before the tag). Never rewritten
 * across hosts and never by bare-name similarity: guessing which model a request
 * meant is worse than the server's own "model not found". An id with no tag is
 * left exactly as pi sent it.
 */
export function resolveStaleServerModelId(payloadId: string, ids: Map<string, string>): string | undefined {
	const tag = hostTagOf(payloadId);
	if (!tag) return undefined;
	const bare = withoutHostTag(payloadId).toLowerCase();
	if (!bare) return undefined;
	for (const [id, raw] of ids) {
		if (hostTagOf(id) !== tag) continue;
		if (withoutHostTag(id).toLowerCase() === bare) return raw;
	}
	return undefined;
}
