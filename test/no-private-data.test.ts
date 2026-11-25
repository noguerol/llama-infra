// Guard for the PUBLIC repo: fails when data that belongs to one developer's
// machine, fleet or account sneaks back into a tracked file.
// Run: node --experimental-strip-types test/no-private-data.test.ts
//
// Two layers, so the strict checks never publish what they protect:
//
//  1. Generic patterns that are never legitimate in a published package:
//     absolute home paths, Tailscale hostnames, API keys, personal e-mails.
//  2. An OPTIONAL, git-ignored local denylist (`sanitize-denylist.local.json`)
//     with the hostnames, model names and ports of YOUR machines. It stays out
//     of the repo: your box is checked against your fleet, the published
//     package carries no trace of it.
//
// Hostnames and model names cannot be listed here by pattern - that is exactly
// the data being protected - so keep them in the local file:
//
//   { "forbid": ["myhost", "192.0.2.10", "Example-27B-The-Private-One"] }

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";

let failures = 0;

function check(label: string, cond: boolean, detail?: string): void {
	if (cond) console.log(`  ✓ ${label}`);
	else {
		failures++;
		console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

console.log("no-private-data: public tree guard");

const repoRoot = join(import.meta.dirname, "..");

/** Files that are never worth scanning (binary assets / generated output). */
const BINARY_EXTENSIONS = new Set([".jpeg", ".jpg", ".png", ".gif", ".webp", ".ico", ".zip", ".gz", ".pdf", ".woff", ".woff2"]);

interface Rule {
	reason: string;
	pattern: RegExp;
}

const RULES: Rule[] = [
	{
		reason: "absolute home path (developer machine layout)",
		pattern: /(?:^|[^A-Za-z0-9])\/(?:home|Users)\/[A-Za-z0-9._-]+/,
	},
	{
		reason: "absolute Windows user path (developer machine layout)",
		pattern: /[A-Za-z]:\\Users\\/,
	},
	{
		reason: "Tailscale hostname (private tailnet)",
		pattern: /\b[a-z0-9][a-z0-9-]*\.ts\.net\b/i,
	},
	{
		reason: "API key or token literal",
		pattern: /\b(?:sk|rk)-[A-Za-z0-9]{16,}|\bghp_[A-Za-z0-9]{20,}|\bAKIA[0-9A-Z]{16}\b|\bxox[bap]-[A-Za-z0-9-]{10,}|\bBSA[A-Za-z0-9_-]{20,}/,
	},
	{
		reason: "personal e-mail address",
		pattern: /[A-Za-z0-9._%+-]+@(?!users\.noreply\.github\.com\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
	},
];

/** Optional, git-ignored list of this machine's own hostnames/models/ports. */
function localDenylist(): string[] {
	const path = join(repoRoot, "sanitize-denylist.local.json");
	if (!existsSync(path)) return [];
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as { forbid?: unknown } | string[];
		const entries = Array.isArray(raw) ? raw : Array.isArray(raw?.forbid) ? raw.forbid : [];
		return entries.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 1).map((entry) => entry.trim().toLowerCase());
	} catch (err) {
		failures++;
		console.error(`  ✗ sanitize-denylist.local.json is not valid JSON — ${err instanceof Error ? err.message : String(err)}`);
		return [];
	}
}

function trackedFiles(): string[] | undefined {
	try {
		const out = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 });
		return out.split("\0").filter(Boolean);
	} catch {
		// Not a git checkout (packed tarball, CI sandbox): nothing to guard here.
		return undefined;
	}
}

const files = trackedFiles();
check("git checkout detected (tracked file list available)", files !== undefined);
const local = localDenylist();

interface Hit {
	file: string;
	line: number;
	reason: string;
	excerpt: string;
}

const hits: Hit[] = [];
for (const file of files ?? []) {
	if (BINARY_EXTENSIONS.has(extname(file).toLowerCase())) continue;
	let content: string;
	try {
		content = readFileSync(join(repoRoot, file), "utf-8");
	} catch {
		continue; // unreadable / deleted-but-tracked
	}
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		for (const rule of RULES) {
			if (rule.pattern.test(line)) {
				hits.push({ file, line: i + 1, reason: rule.reason, excerpt: line.trim().slice(0, 120) });
			}
		}
		const lower = line.toLowerCase();
		for (const entry of local) {
			if (lower.includes(entry)) {
				hits.push({ file, line: i + 1, reason: `local denylist entry "${entry}"`, excerpt: line.trim().slice(0, 120) });
			}
		}
	}
}

check(
	`tracked files carry no machine paths, tailnet names, secrets or personal e-mails (${files?.length ?? 0} files)`,
	hits.length === 0,
	hits.map((h) => `${h.file}:${h.line} ${h.reason} → ${h.excerpt}`).join("\n      "),
);

check(
	"tracked files carry no hostname/model from the local denylist",
	hits.every((h) => !h.reason.startsWith("local denylist entry")),
	`${local.length} local entries checked`,
);

if (files !== undefined) {
	const trackedLocalFiles = (files ?? []).filter((file) => file.endsWith("sanitize-denylist.local.json"));
	check("the local denylist itself is never tracked (it holds private names)", trackedLocalFiles.length === 0, trackedLocalFiles.join(", "));
}

if (failures > 0) {
	console.error(`no-private-data tests failed: ${failures}`);
	process.exit(1);
}
console.log("no-private-data tests passed");
