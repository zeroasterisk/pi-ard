import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { checkEntry, identityDomain, isTrustedDomain, kindOf, publisherOf, signatureLabel } from "../src/core/entry.ts";
import { parseSkill, skillSourceUrl } from "../src/core/install.ts";
import { fixtureJson } from "./helpers.ts";

describe("entry: ARD §4 / Appendix C", () => {
	it("parses publisher from urn:air", () => {
		assert.equal(publisherOf("urn:air:Example.com:skill:pdf"), "example.com");
		assert.equal(publisherOf("urn:air:huggingface.co:mcp:space:a:b"), "huggingface.co");
		assert.equal(publisherOf("example.com/pdf"), undefined);
		assert.equal(publisherOf("urn:air:example.com"), undefined, "needs at least one namespace segment");
	});

	it("maps spec and real-world media types; unknown is unsupported", () => {
		assert.equal(kindOf("application/agent-skills+md"), "skill");
		assert.equal(kindOf("application/ai-skill"), "skill");
		assert.equal(kindOf("application/mcp-server-card+json"), "mcp");
		assert.equal(kindOf("application/mcp-server+json"), "mcp");
		assert.equal(kindOf("application/a2a-agent-card+json"), "a2a");
		assert.equal(kindOf("application/ai-registry+json"), "registry");
		assert.equal(kindOf("text/html"), "unsupported");
		assert.equal(kindOf(undefined), "unsupported");
	});

	it("complete entries need displayName, type and exactly one of url/data", () => {
		const base = { identifier: "urn:air:x.com:a:b", displayName: "B", type: "application/agent-skills+md" };
		assert.deepEqual(checkEntry({ ...base, url: "https://x.com/s.md" }, true).problems, []);
		assert.match(checkEntry({ ...base }, true).problems.join(), /neither url nor data/);
		assert.match(checkEntry({ ...base, url: "https://x.com", data: {} }, true).problems.join(), /both url and data/);
		assert.match(checkEntry({ identifier: "urn:air:x.com:a:b", url: "https://x.com" }, true).problems.join(), /displayName.*type|missing type/);
	});

	it("spec conformance examples are valid", () => {
		for (const f of ["spec/basic-ard.json", "spec/scan-attestation-ard.json"]) {
			const doc = fixtureJson(f) as { entries: Array<Record<string, unknown>> };
			for (const e of doc.entries) assert.deepEqual(checkEntry(e as never, true).problems, [], `${f} ${String(e.identifier)}`);
		}
	});
});

describe("entry: trust manifest (§4.5) — declared, never verified", () => {
	it("identity domain from SPIFFE, did:web, https", () => {
		assert.equal(identityDomain("spiffe://tools.example.com/mcp/x"), "tools.example.com");
		assert.equal(identityDomain("did:web:example.com:agents:x"), "example.com");
		assert.equal(identityDomain("did:web:example.com%3A8443"), "example.com");
		assert.equal(identityDomain("https://example.com/agent"), "example.com");
		assert.equal(identityDomain("did:key:z6Mk"), undefined);
	});

	it("scan-attestation example: user sees which attestations are declared, and that none are verified", () => {
		const doc = fixtureJson("spec/scan-attestation-ard.json") as { entries: never[] };
		const c = checkEntry(doc.entries[0]!, true);
		assert.equal(c.signature, "declared-unverified");
		assert.equal(signatureLabel(c), "trust manifest declared; attestations declared: SOC2-Type2, agent-threat-scan; signature and attestations NOT verified");
		assert.deepEqual(c.problems, []);
	});

	it("subdomain identity binds to parent publisher; lookalike does not", () => {
		assert.deepEqual(checkEntry({ identifier: "urn:air:example.com:a:b", trustManifest: { identity: "spiffe://tools.example.com/x" } }, false).problems, []);
		assert.match(
			checkEntry({ identifier: "urn:air:example.com:a:b", trustManifest: { identity: "spiffe://badexample.com/x" } }, false).problems.join(),
			/identity mismatch/,
		);
	});

	it("no trust manifest = unsigned; a bare search result (§5.3.2: only identifier) has no problems", () => {
		assert.deepEqual(checkEntry({ identifier: "urn:air:x.com:a:b" }, false), { kind: "unsupported", publisher: "x.com", problems: [], signature: "unsigned", trustSchema: undefined, attestations: [] });
		assert.equal(checkEntry({ identifier: "urn:air:x.com:a:b", trustManifest: null as never }, false).signature, "unsigned");
	});
});

describe("trustedDomains matching", () => {
	const cfg = { trustedDomains: ["example.com", "*.corp.dev"] };
	it("exact and subdomain match; suffix lookalikes do not", () => {
		assert.ok(isTrustedDomain("example.com", cfg));
		assert.ok(isTrustedDomain("api.example.com", cfg));
		assert.ok(isTrustedDomain("x.corp.dev", cfg));
		assert.ok(!isTrustedDomain("badexample.com", cfg));
		assert.ok(!isTrustedDomain("example.com.evil.io", cfg));
		assert.ok(!isTrustedDomain(undefined, cfg));
	});
});

describe("skill source resolution: never guesses", () => {
	it("HF Discover: uses metadata.raw_url", () => {
		const e = (fixtureJson("live/hf-search-skill.json") as { results: never[] }).results[0]!;
		assert.match(skillSourceUrl(e)!, /^https:\/\/raw\.githubusercontent\.com\/.+\/SKILL\.md$/);
	});
	it("GitHub Agent Finder: blob/.../SKILL.md -> raw.githubusercontent.com", () => {
		const e = (fixtureJson("live/gh-search.json") as { results: never[] }).results[0]!;
		assert.equal(skillSourceUrl(e), "https://raw.githubusercontent.com/github/awesome-copilot/main/skills/convert-pdf-to-md/SKILL.md");
	});
	it("HF Space skill (Discover-served .../SKILL.md, type ai-skill): used as-is; was refused", () => {
		assert.equal(
			skillSourceUrl({ identifier: "urn:air:huggingface.co:skill:space:hysts:daily-papers", type: "application/ai-skill", url: "https://huggingface-hf-discover.hf.space/skills/huggingface/hysts/daily-papers/SKILL.md" }),
			"https://huggingface-hf-discover.hf.space/skills/huggingface/hysts/daily-papers/SKILL.md",
		);
	});
	it("GitHub tree/ directory without raw_url: refuses", () => {
		assert.equal(skillSourceUrl({ identifier: "urn:air:github.com:a:b", type: "application/ai-skill", url: "https://github.com/a/b/tree/main/skills/x" }), undefined);
	});
	it("parseSkill: matches Pi's loader (name fallback, description required, YAML folding)", () => {
		const e = { identifier: "urn:air:x.com:skill:Fallback" };
		assert.deepEqual(parseSkill(e, "---\nname: pdf-tools\ndescription: d\n---\n"), { name: "pdf-tools" });
		assert.deepEqual(parseSkill(e, "---\ndescription: >\n  folded\n---\n"), { name: "fallback" });
		// Pi skips a SKILL.md without description; installing it would "succeed" and never load.
		assert.match((parseSkill(e, "---\nname: pdf-tools\n---\n") as { error: string }).error, /no description/);
		assert.match((parseSkill(e, "---\nname: ../../etc\ndescription: d\n---\n") as { error: string }).error, /invalid Agent Skills name/);
		assert.match((parseSkill(e, "---\nname: a--b\ndescription: d\n---\n") as { error: string }).error, /invalid/);
	});
});
