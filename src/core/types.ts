/** ARD entry as received. Only `identifier` is guaranteed for search results (ARD v0.91 §5.3.2). */
export interface ArdEntry {
	identifier: string;
	displayName?: string;
	type?: string;
	url?: string;
	data?: unknown;
	description?: string;
	metadata?: Record<string, unknown>;
	trustManifest?: TrustManifest;
	/** Search results only. Relevance, never trust. */
	score?: number;
	[key: string]: unknown;
}

export interface TrustManifest {
	identity?: string;
	trustSchema?: { identifier?: string; version?: string; governanceUri?: string; verificationMethods?: string[] };
	attestations?: Array<{ type?: string; uri?: string; mediaType?: string; digest?: string }>;
	[key: string]: unknown;
}

export type EntryKind = "skill" | "mcp" | "a2a" | "registry" | "catalog" | "unsupported";

export interface RegistryConfig {
	name: string;
	/** Registry base URL. `/search` is appended (ARD §5.3). */
	url?: string;
	/** Full search endpoint, used as-is (e.g. from a referral). */
	searchUrl?: string;
}

export interface ArdConfig {
	registries: RegistryConfig[];
	/** Domains whose catalogs may be fetched and whose entries/URLs count as trusted. Subdomains match. */
	trustedDomains: string[];
}
