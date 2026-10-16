import type { ArdConfig, ArdEntry, EntryKind } from "./types.ts";

/**
 * Media types this package can act on. ARD v0.91 lists these as de facto (not IANA-registered).
 * `application/ai-skill` and `application/mcp-server+json` are not in the spec but are what the
 * Hugging Face and GitHub registries return today, so they are mapped explicitly.
 */
const KIND_BY_TYPE: Record<string, EntryKind> = {
	"application/agent-skills+md": "skill",
	"application/ai-skill": "skill", // HF Discover, GitHub Agent Finder (non-standard alias)
	"application/mcp-server-card+json": "mcp",
	"application/mcp-server+json": "mcp", // GitHub Agent Finder: MCP registry server.json (non-standard alias)
	"application/a2a-agent-card+json": "a2a",
	"application/agent-card+json": "a2a",
	"application/ai-registry+json": "registry",
	"application/ai-catalog+json": "catalog",
};

export function kindOf(type: string | undefined): EntryKind {
	return (type && KIND_BY_TYPE[type]) || "unsupported";
}

// ARD Appendix C / ard-entry.schema.json
const URN = /^urn:air:([a-zA-Z0-9.-]+)(:[a-zA-Z0-9._-]+)+$/;

export function publisherOf(identifier: string): string | undefined {
	return URN.exec(identifier)?.[1]?.toLowerCase();
}

/** Trust domain of a trustManifest.identity: SPIFFE trust domain, did:web host, or URL host. */
export function identityDomain(identity: string): string | undefined {
	const id = identity.trim();
	const spiffe = /^spiffe:\/\/([^/]+)/i.exec(id);
	if (spiffe) return spiffe[1]!.toLowerCase();
	const didWeb = /^did:web:([^:#?]+)/i.exec(id);
	if (didWeb) return decodeURIComponent(didWeb[1]!).split(":")[0]!.toLowerCase();
	if (/^https?:\/\//i.test(id)) {
		try {
			return new URL(id).hostname.toLowerCase();
		} catch {
			return undefined;
		}
	}
	if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(id)) return id.toLowerCase();
	return undefined;
}

export type Signature = "unsigned" | "declared-unverified";

export interface EntryCheck {
	kind: EntryKind;
	publisher?: string;
	/** Problems that make the entry not installable. */
	problems: string[];
	/** Labels shown to the user. Never mean "verified". */
	signature: Signature;
	trustSchema?: string;
	attestations: number;
}

/**
 * ARD §4 structural checks plus the §4.5.1 publisher-authority binding.
 * `complete` = a full entry from a catalog (needs displayName/type and exactly one of url|data).
 * Search results may legitimately omit terms (§5.3.2), so they are checked with complete=false
 * and must still carry a resolvable url to be installed.
 */
export function checkEntry(entry: ArdEntry, complete: boolean): EntryCheck {
	const problems: string[] = [];
	const publisher = typeof entry.identifier === "string" ? publisherOf(entry.identifier) : undefined;
	if (typeof entry.identifier !== "string") problems.push("missing identifier");
	else if (!publisher) problems.push(`identifier is not urn:air:<publisher>:...: ${entry.identifier}`);
	const hasUrl = typeof entry.url === "string";
	const hasData = entry.data !== undefined;
	if (hasUrl && hasData) problems.push("has both url and data (must be exactly one)");
	if (complete) {
		if (typeof entry.displayName !== "string") problems.push("missing displayName");
		if (typeof entry.type !== "string") problems.push("missing type");
		if (!hasUrl && !hasData) problems.push("has neither url nor data");
	}
	const tm = entry.trustManifest;
	let signature: Signature = "unsigned";
	if (tm && typeof tm === "object") {
		signature = "declared-unverified";
		if (typeof tm.identity !== "string") problems.push("trustManifest without identity");
		else {
			const dom = identityDomain(tm.identity);
			if (!dom || !publisher || !(dom === publisher || dom.endsWith(`.${publisher}`))) {
				problems.push(`identity mismatch: trustManifest.identity ${tm.identity} does not match publisher ${publisher ?? "?"}`);
			}
		}
	}
	return {
		kind: kindOf(entry.type),
		publisher,
		problems,
		signature,
		trustSchema: tm?.trustSchema?.identifier,
		attestations: Array.isArray(tm?.attestations) ? tm!.attestations!.length : 0,
	};
}

export function hostOf(url: string): string | undefined {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return undefined;
	}
}

export function isTrustedDomain(host: string | undefined, config: Pick<ArdConfig, "trustedDomains">): boolean {
	if (!host) return false;
	const h = host.toLowerCase();
	return config.trustedDomains.some((d) => {
		const t = d.toLowerCase().replace(/^\*\./, "");
		return h === t || h.endsWith(`.${t}`);
	});
}

export function signatureLabel(c: EntryCheck): string {
	if (c.signature === "unsigned") return "unsigned";
	return `trust manifest declared${c.trustSchema ? ` (${c.trustSchema})` : ""}, signature NOT verified`;
}
