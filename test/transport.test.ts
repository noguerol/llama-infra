// Standalone behavior test for the transport layer: IPv6 addresses, the
// per-server TLS opt-in, and the URL helpers the scanner and the warmup client
// share.
//
// Run: node --experimental-strip-types test/transport.test.ts

import * as http from "node:http";
import * as https from "node:https";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, normalizeServer, serverBaseUrl, setActiveConfig } from "../src/core.ts";
import { REQUEST_FAMILY, requestHostname, requestPort, requestClient, tlsRequestOptions } from "../src/net.ts";
import { fetchModelsFromEndpoint, httpGet } from "../src/scan.ts";
import type { InfraConfig } from "../src/types.ts";

let failures = 0;

function check(label: string, cond: boolean, detail?: string): void {
	if (cond) console.log(`  ✓ ${label}`);
	else {
		failures++;
		console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

function resetConfig(servers: InfraConfig["servers"] = []): void {
	setActiveConfig({ servers, settings: { ...DEFAULT_SETTINGS }, modelOptions: {} });
}

console.log("transport: URL helpers");

check("IPv4/hostname base URL", serverBaseUrl({ host: "mybox" }, 8080) === "http://mybox:8080/v1");
check("https base URL", serverBaseUrl({ host: "mybox", protocol: "https" }, 8443) === "https://mybox:8443/v1");
check(
	"IPv6 literals are bracketed inside the URL",
	serverBaseUrl({ host: "fd00::1" }, 8080) === "http://[fd00::1]:8080/v1",
	serverBaseUrl({ host: "fd00::1" }, 8080),
);
check(
	"an already-bracketed host is not double-bracketed",
	serverBaseUrl({ host: "[::1]" }, 8080) === "http://[::1]:8080/v1",
	serverBaseUrl({ host: "[::1]" }, 8080),
);
check(
	"requestHostname hands the bare address to http.request",
	requestHostname(new URL("http://[fd00::1]:8080/v1/models")) === "fd00::1",
	requestHostname(new URL("http://[fd00::1]:8080/v1/models")),
);
check("port defaults to 80 for http", requestPort(new URL("http://mybox/v1")) === 80);
check("port defaults to 443 for https", requestPort(new URL("https://mybox/v1")) === 443);
check("explicit port wins", requestPort(new URL("https://mybox:8443/v1")) === 8443);
check("https URL selects the https client", requestClient(new URL("https://mybox/v1")) === https);
check("http URL selects the http client", requestClient(new URL("http://mybox/v1")) === http);
// The IPv6-only-host bug: pinning family 4 made every AAAA-only name ENOTFOUND.
check("DNS is dual-stack (family 0, not 4)", REQUEST_FAMILY === 0, String(REQUEST_FAMILY));
check("TLS verification stays on by default", tlsRequestOptions(undefined).rejectUnauthorized !== false);
check("TLS verification is opt-out per server", tlsRequestOptions(true).rejectUnauthorized === false);

console.log("transport: config normalization");
{
	const httpsSrv = normalizeServer({ id: "a", host: "h", ports: [1], protocol: "https", tlsInsecure: true });
	check("https + self-signed kept", httpsSrv.protocol === "https" && httpsSrv.tlsInsecure === true, JSON.stringify(httpsSrv));
	const plain = normalizeServer({ id: "a", host: "h", ports: [1], protocol: "http", tlsInsecure: true });
	check("certificate opt-in is dropped without https", plain.tlsInsecure === undefined, JSON.stringify(plain));
	check("priority parsed", normalizeServer({ id: "a", host: "h", ports: [1], priority: 0 }).priority === 0);
	check("bogus priority dropped", normalizeServer({ id: "a", host: "h", ports: [1], priority: "soon" }).priority === undefined);
}

// ── A live IPv6-only endpoint ──────────────────────────────────────────────
// The scanner used to pin `family: 4`, so an IPv6-literal endpoint (or an
// AAAA-only host) could never be reached. Binding a server to ::1 and fetching
// it through the scanner proves both halves of the fix: dual-stack DNS and
// stripping the URL brackets before http.request.
await (async () => {
	let server: http.Server | undefined;
	try {
		server = http.createServer((req, res) => {
			if ((req.url ?? "").startsWith("/v1/models")) {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						object: "list",
						data: [{ id: "ipv6-model", object: "model", created: 1, owned_by: "llamacpp", context_length: 8192 }],
					}),
				);
				return;
			}
			res.writeHead(404).end();
		});
		await new Promise<void>((resolve, reject) => {
			server!.once("error", reject);
			server!.listen(0, "::1", resolve);
		});
		const port = (server.address() as { port: number }).port;
		resetConfig([{ id: "v6", host: "::1", ports: [port], enabled: true }]);

		const res = await httpGet(`http://[::1]:${port}/v1/models`, 2000);
		check("httpGet reaches an IPv6 literal endpoint", res.status === 200, String(res.status));

		const ep = await fetchModelsFromEndpoint({ id: "v6", host: "::1", ports: [port], enabled: true }, port, DEFAULT_SETTINGS, new Map());
		check("endpoint scan works over IPv6", ep.ok === true, ep.error);
		check("IPv6 endpoint base URL is bracketed", ep.baseUrl === `http://[::1]:${port}/v1`, ep.baseUrl);
		check("IPv6 endpoint exposes its model", ep.models.length === 1, String(ep.models.length));
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "EADDRNOTAVAIL" || code === "EAFNOSUPPORT") {
			console.log(`  ↷ skipped (no IPv6 loopback here: ${code})`);
		} else {
			check("IPv6 loopback endpoint", false, err instanceof Error ? err.message : String(err));
		}
	} finally {
		server?.close();
	}
})();

// ── Self-signed TLS: rejected by default, accepted with the opt-in ─────────
await (async () => {
	let dir: string;
	try {
		dir = mkdtempSync(join(tmpdir(), "llama-infra-transport-"));
		execSync(
			`openssl req -x509 -newkey rsa:2048 -keyout ${join(dir, "key.pem")} -out ${join(dir, "cert.pem")} -days 1 -nodes -subj "/CN=127.0.0.1"`,
			{ stdio: "ignore" },
		);
	} catch (err) {
		console.log(`  ↷ skipped (openssl unavailable: ${err instanceof Error ? err.message : String(err)})`);
		if (failures > 0) {
			console.error(`transport tests failed: ${failures}`);
			process.exit(1);
		}
		console.log("transport: all checks passed");
		process.exit(0);
	}
	const tls = https.createServer(
		{ key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) },
		(req, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ object: "list", data: [{ id: "tls-model", object: "model", created: 1 }] }));
		},
	);
	await new Promise<void>((resolve) => tls.listen(0, "127.0.0.1", resolve));
	const port = (tls.address() as { port: number }).port;
	try {
		// Opted in: the endpoint is reachable and its models are discovered.
		resetConfig([{ id: "tls", host: "127.0.0.1", ports: [port], enabled: true, protocol: "https", tlsInsecure: true }]);
		const ep = await fetchModelsFromEndpoint(
			{ id: "tls", host: "127.0.0.1", ports: [port], enabled: true, protocol: "https", tlsInsecure: true },
			port,
			DEFAULT_SETTINGS,
			new Map(),
		);
		check("self-signed https endpoint is reachable with tlsInsecure", ep.ok === true, ep.error);
		check("https endpoint baseUrl", ep.baseUrl === `https://127.0.0.1:${port}/v1`, ep.baseUrl);
		check("models discovered over TLS", ep.models.length === 1, String(ep.models.length));

		// Not opted in: verification stays on, so the same host fails cleanly.
		resetConfig([{ id: "tls", host: "127.0.0.1", ports: [port], enabled: true, protocol: "https" }]);
		const strict = await fetchModelsFromEndpoint(
			{ id: "tls", host: "127.0.0.1", ports: [port], enabled: true, protocol: "https" },
			port,
			DEFAULT_SETTINGS,
			new Map(),
		);
		check("self-signed https endpoint is rejected without the opt-in", strict.ok === false, JSON.stringify(strict.models.length));
	} finally {
		tls.close();
		resetConfig();
	}
})();

if (failures > 0) {
	console.error(`transport tests failed: ${failures}`);
	process.exit(1);
}
console.log("transport: all checks passed");
