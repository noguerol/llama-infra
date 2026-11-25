// Low-level network helpers shared by the scanner (scan.ts) and the warmup
// client (prompt-warmup.ts). Deliberately config-independent so they stay
// trivially unit-testable: the per-server TLS policy (the self-signed opt-in)
// is resolved in core.ts (tlsInsecureForUrl) and passed in here.

import * as http from "node:http";
import * as https from "node:https";

/** Host as a URL authority: IPv6 literals must be bracketed inside a URL
 *  (`http://[fd00::1]:8080/v1`), plain hostnames must not be. */
export function authorityHost(host: string): string {
	const h = host.trim();
	if (h.startsWith("[") || !h.includes(":")) return h;
	return `[${h}]`;
}

/** Hostname for `http(s).request`: Node's URL keeps the IPv6 brackets, but the
 *  request options want the bare address (`::1`, not `[::1]`). */
export function requestHostname(url: URL): string {
	return url.hostname.replace(/^\[/, "").replace(/\]$/, "");
}

/** Port for `http(s).request`, defaulting by protocol (443 for TLS, 80 plain). */
export function requestPort(url: URL): number {
	if (url.port) return Number(url.port);
	return url.protocol === "https:" ? 443 : 80;
}

/** Client module for a URL's protocol (http or https). */
export function requestClient(url: URL): typeof http | typeof https {
	return url.protocol === "https:" ? https : http;
}

/** Extra request options for TLS URLs. Verification stays ON unless the server
 *  explicitly opted out (self-signed certificate on a host you control). */
export function tlsRequestOptions(insecure: boolean | undefined): https.RequestOptions {
	return insecure === true ? { rejectUnauthorized: false } : {};
}

/**
 * DNS family for outgoing requests.
 *
 * `0` lets Node try both stacks (it does happy-eyeballs style resolution and
 * falls back to the other family), which is what IPv6-only hosts and
 * IPv6-addressed tailnets need. Pinning `4` — the old value — made every
 * IPv6-only host fail with `getaddrinfo ENOTFOUND`.
 */
export const REQUEST_FAMILY = 0;
