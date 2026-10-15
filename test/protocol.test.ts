// Standalone behavior test: per-server protocol selection (http/https) for
// servers proxied behind TLS.
// Run: node --experimental-strip-types test/protocol.test.ts

import * as http from "node:http";
import * as https from "node:https";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, normalizeServer, serverBaseUrl } from "../src/core.ts";
import { fetchModelsFromEndpoint, httpGet, isNetworkError } from "../src/scan.ts";

let failures = 0;

function check(label: string, cond: boolean, detail?: string): void {
	if (cond) console.log(`  ✓ ${label}`);
	else {
		failures++;
		console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

console.log("protocol: serverBaseUrl");
check("defaults to http", serverBaseUrl({ host: "mybox" }, 8080) === "http://mybox:8080/v1");
check("explicit http", serverBaseUrl({ host: "mybox", protocol: "http" }, 8080) === "http://mybox:8080/v1");
check("explicit https", serverBaseUrl({ host: "mybox", protocol: "https" }, 8443) === "https://mybox:8443/v1");

console.log("protocol: normalizeServer parses the config field");
check("https kept", normalizeServer({ id: "a", host: "h", ports: [1], protocol: "https" }).protocol === "https");
check("http kept", normalizeServer({ id: "a", host: "h", ports: [1], protocol: "http" }).protocol === "http");
check("bogus value dropped", normalizeServer({ id: "a", host: "h", ports: [1], protocol: "ftp" }).protocol === undefined);
check("absent value stays undefined", normalizeServer({ id: "a", host: "h", ports: [1] }).protocol === undefined);

console.log("protocol: TLS failures are classified as network errors");
check("self signed", isNetworkError("self signed certificate"));
check("unable to verify", isNetworkError("unable to verify the first certificate"));
check("expired cert", isNetworkError("certificate has expired"));
check("altname mismatch", isNetworkError("ERR_TLS_CERT_ALTNAME_INVALID: Hostname/IP does not match certificate's altnames"));
check("handshake version error", isNetworkError("wrong version number"));
check("plain HTTP error is not a network error", !isNetworkError("404: Not Found"));

console.log("protocol: endpoint scan builds https URLs");
{
	const srv = { id: "t", host: "127.0.0.1", ports: [1], enabled: true, protocol: "https" as const };
	const ep = await fetchModelsFromEndpoint(srv, 1, DEFAULT_SETTINGS, new Map());
	check("https baseUrl on endpoint", ep.baseUrl === "https://127.0.0.1:1/v1", ep.baseUrl);
	const epHttp = await fetchModelsFromEndpoint({ id: "t", host: "127.0.0.1", ports: [1], enabled: true }, 1, DEFAULT_SETTINGS, new Map());
	check("http baseUrl on endpoint (default)", epHttp.baseUrl === "http://127.0.0.1:1/v1", epHttp.baseUrl);
}

console.log("protocol: https URLs really go through node:https");
{
	// A plain HTTP server answering an https:// URL with a TLS handshake error
	// proves the https module was used (node:http would have parsed the reply).
	const plain = http.createServer((req, res) => {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end("{}");
	});
	await new Promise<void>((r) => plain.listen(0, "127.0.0.1", () => r()));
	const port = (plain.address() as { port: number }).port;
	try {
		await httpGet(`https://127.0.0.1:${port}/models`, 2000);
		check("https request to plain-HTTP port fails", false, "unexpected success");
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		check("https request to plain-HTTP port fails", true);
		check("handshake error is a network error", isNetworkError(msg), msg);
	} finally {
		plain.close();
	}
}

console.log("protocol: full TLS handshake against a self-signed https server");
{
	let dir: string | undefined;
	try {
		dir = mkdtempSync(join(tmpdir(), "llama-infra-protocol-"));
		execSync(
			`openssl req -x509 -newkey rsa:2048 -keyout ${join(dir, "key.pem")} -out ${join(dir, "cert.pem")} -days 1 -nodes -subj "/CN=127.0.0.1"`,
			{ stdio: "ignore" },
		);
		const tls = https.createServer(
			{ key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) },
			(req, res) => {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end("{}");
			},
		);
		await new Promise<void>((r) => tls.listen(0, "127.0.0.1", () => r()));
		const port = (tls.address() as { port: number }).port;
		// NODE_TLS_REJECT_UNAUTHORIZED=0 (some sandboxes/CI) disables verification
		// process-wide — in that case the round trip must simply succeed.
		const verifyOn = process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0";
		try {
			const res = await httpGet(`https://127.0.0.1:${port}/models`, 2000);
			check(
				verifyOn ? "self-signed cert is rejected (verification on)" : "https round trip succeeds (verification off in env)",
				!verifyOn && res.status === 200,
				verifyOn ? "unexpected success" : `status ${res.status}`,
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			check("self-signed cert is rejected (verification on)", !verifyOn || /self[- ]signed|unable to verify/i.test(msg), msg);
			if (verifyOn) check("cert error is a network error", isNetworkError(msg), msg);
		} finally {
			tls.close();
		}
	} catch (err) {
		console.log(`  ↷ skipped (openssl unavailable: ${err instanceof Error ? err.message : String(err)})`);
	}
}

if (failures > 0) {
	console.error(`protocol tests failed: ${failures}`);
	process.exit(1);
}
console.log("protocol: all checks passed");
