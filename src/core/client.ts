import { checkEntry, expandTypes } from "./entry.ts";
import { type HttpOptions, ArdHttpError, getJson, isLoopback, postJson } from "./http.ts";
import type { ArdEntry, RegistryConfig } from "./types.ts";

export interface SearchParams {
	text: string;
	types?: string[];
	federation?: "auto" | "referrals" | "none";
	pageSize?: number;
	pageToken?: string;
}

export interface SearchResult {
	endpoint: string;
	results: ArdEntry[];
	referrals: ArdEntry[];
	pageToken?: string;
	/** Results dropped because they had no identifier (the only term ARD requires in a result). */
	dropped: number;
}

/** Registry base URL + `/search`, or the full searchUrl as-is (referrals, ARD §5.3). */
export function searchEndpoint(r: RegistryConfig): string {
	if (r.searchUrl) return r.searchUrl;
	if (!r.url) throw new Error(`Registry ${r.name} has neither url nor searchUrl`);
	return `${r.url.replace(/\/+$/, "")}/search`;
}

/** Some registries send `mediaType` instead of `type` alongside it; normalize to `type`. */
function normalize(raw: unknown): ArdEntry | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const e = { ...(raw as Record<string, unknown>) };
	if (typeof e.type !== "string" && typeof e.mediaType === "string") e.type = e.mediaType;
	if (typeof e.identifier !== "string") return undefined;
	return e as ArdEntry;
}

/** ARD §5.3.2 POST /search. One request; errors surface with status and code; no retry, no fallback. */
export async function search(registry: RegistryConfig, p: SearchParams, http?: HttpOptions): Promise<SearchResult> {
	if (!p.text?.trim()) throw new ArdHttpError("query text is required", searchEndpoint(registry), undefined, "INVALID_ARGUMENT");
	const endpoint = searchEndpoint(registry);
	const pageSize = Math.min(Math.max(1, Math.trunc(p.pageSize ?? 10)), 100);
	const body: Record<string, unknown> = {
		query: { text: p.text, ...(p.types?.length ? { filter: { type: expandTypes(p.types) } } : {}) },
		federation: p.federation ?? registry.federation ?? "none",
		pageSize,
	};
	if (p.pageToken) body.pageToken = p.pageToken;
	const json = (await postJson(endpoint, body, http)) as Record<string, unknown>;
	if (!json || !Array.isArray(json.results)) throw new ArdHttpError("Response has no results[] array", endpoint);
	const results: ArdEntry[] = [];
	let dropped = 0;
	for (const r of json.results) {
		const e = normalize(r);
		if (e) results.push(e);
		else dropped++;
	}
	const referrals = Array.isArray(json.referrals) ? json.referrals.map(normalize).filter((e): e is ArdEntry => !!e) : [];
	return {
		endpoint,
		results,
		referrals,
		pageToken: typeof json.pageToken === "string" && json.pageToken ? json.pageToken : undefined,
		dropped,
	};
}

export interface CatalogResult {
	/** The URL that answered. */
	url: string;
	/** "ard.json" (ARD v0.91) or "ai-catalog.json" (predecessor, optional fallback). */
	path: "ard.json" | "ai-catalog.json" | "direct";
	specVersion?: string;
	entries: ArdEntry[];
	invalid: Array<{ entry: unknown; problems: string[] }>;
	/** Why ard.json was skipped, when the fallback answered. */
	fallbackReason?: string;
}

function parseManifest(json: unknown, url: string): Omit<CatalogResult, "path" | "fallbackReason"> | undefined {
	if (!json || typeof json !== "object" || !Array.isArray((json as { entries?: unknown }).entries)) return undefined;
	const doc = json as { entries: unknown[]; specVersion?: unknown };
	const entries: ArdEntry[] = [];
	const invalid: CatalogResult["invalid"] = [];
	for (const raw of doc.entries) {
		const e = normalize(raw);
		const problems = e ? checkEntry(e, true).problems.filter((p) => !p.startsWith("identity mismatch")) : ["missing identifier"];
		// Identity mismatch is surfaced per-entry at install time; only structural problems mark it invalid here.
		if (e && problems.length === 0) entries.push(e);
		else invalid.push({ entry: raw, problems });
	}
	return { url, specVersion: typeof doc.specVersion === "string" ? doc.specVersion : undefined, entries, invalid };
}

/**
 * ARD §5.1 consumer resolution: fetch https://{domain}/.well-known/ard.json (MUST); if that is not
 * a JSON manifest with entries[], try the predecessor /.well-known/ai-catalog.json (MAY).
 */
/** "https://Example.com/x" -> "example.com"; "localhost:8787" kept with port. Throws unless a plain host[:port]. */
export function catalogHost(domain: string): string {
	const host = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
	if (!/^[a-z0-9.-]+(:\d+)?$/.test(host)) throw new ArdHttpError(`Not a domain: ${domain}`, domain);
	return host;
}

export async function fetchCatalog(domain: string, http?: HttpOptions): Promise<CatalogResult> {
	const host = catalogHost(domain);
	const base = `${isLoopback(host.replace(/:\d+$/, "")) ? "http" : "https"}://${host}`;
	let reason: string;
	try {
		const r = await getJson(`${base}/.well-known/ard.json`, http);
		const m = parseManifest(r.json, r.url);
		if (m) return { ...m, path: "ard.json" };
		reason = "ard.json has no entries[] array";
	} catch (e) {
		reason = `ard.json: ${e instanceof Error ? e.message : String(e)}`;
	}
	const r = await getJson(`${base}/.well-known/ai-catalog.json`, http).catch((e: unknown) => {
		throw new ArdHttpError(`No catalog at ${host}. ${reason}; ai-catalog.json: ${e instanceof Error ? e.message : String(e)}`, base);
	});
	const m = parseManifest(r.json, r.url);
	if (!m) throw new ArdHttpError(`No catalog at ${host}. ${reason}; ai-catalog.json has no entries[] array`, r.url);
	return { ...m, path: "ai-catalog.json", fallbackReason: reason };
}

/** Fetch a nested catalog (application/ai-catalog+json entry url). */
export async function fetchCatalogUrl(url: string, http?: HttpOptions): Promise<CatalogResult> {
	const r = await getJson(url, http);
	const m = parseManifest(r.json, r.url);
	if (!m) throw new ArdHttpError("Document has no entries[] array", r.url);
	return { ...m, path: "direct" };
}
