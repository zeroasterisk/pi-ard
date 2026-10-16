import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { readLock } from "../src/core/config.ts";
import { install, planMcp, type McpInstallContext } from "../src/core/install.ts";
import type { ArdConfig, ArdEntry } from "../src/core/types.ts";
import { fixture, fixtureJson, mockServer, routedHttp, type MockServer } from "./helpers.ts";

const SKILL = "---\nname: pdf-tools\ndescription: PDFs\n---\n# body\n";

function ctx(mock: MockServer, answers: boolean[], config?: Partial<ArdConfig>) {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-ard-i-"));
	const asked: string[] = [];
	const registered: Array<[string, Record<string, unknown>]> = [];
	const http = routedHttp(mock);
	const c: McpInstallContext = {
		agentDir,
		config: { registries: [], trustedDomains: ["example.com", "huggingface.co"], ...config },
		http,
		confirm: async (title, body) => {
			asked.push(`${title}\n${body}`);
			const a = answers.shift();
			if (a === undefined) throw new Error(`unexpected confirm: ${title}`);
			return a;
		},
		register: (n, cfg) => registered.push([n, cfg]),
	};
	return { c, agentDir, asked, registered, http };
}

const skillEntry: ArdEntry = {
	identifier: "urn:air:example.com:skill:pdf-tools",
	displayName: "PDF tools",
	type: "application/agent-skills+md",
	url: "https://example.com/skills/pdf-tools/SKILL.md",
};

describe("install: skills", () => {
	let mock: MockServer;
	before(async () => {
		mock = await mockServer({
			"GET /example.com/skills/pdf-tools/SKILL.md": () => ({ text: SKILL }),
			// Recorded 2026-10-16 from huggingface/skills; cites scripts/paper_manager.py which is not installed.
			"GET /example.com/skills/huggingface-paper-publisher/SKILL.md": () => ({ text: fixture("live/hf-skill-paper-publisher.md") }),
			"GET /example.com/notskill.md": () => ({ text: "# no frontmatter" }),
			"GET /untrusted.io/s/SKILL.md": () => ({ text: SKILL.replace("pdf-tools", "other") }),
		});
	});
	after(() => mock.close());

	it("declined: nothing fetched, nothing written", async () => {
		const t = ctx(mock, [false]);
		const out = await install(skillEntry, t.c);
		assert.equal(out.status, "declined");
		assert.equal(t.http.calls.length, 0, "confirm happens before the fetch");
		assert.ok(!existsSync(join(t.agentDir, "skills")));
	});

	it("confirmed: writes SKILL.md verbatim, records sha256 + source in lock", async () => {
		const t = ctx(mock, [true]);
		const out = await install(skillEntry, t.c);
		assert.equal(out.status, "installed");
		const path = join(t.agentDir, "skills", "pdf-tools", "SKILL.md");
		assert.equal(readFileSync(path, "utf8"), SKILL);
		const [lock] = readLock(join(t.agentDir, "pi-ard", "lock.json"));
		assert.equal(lock!.identifier, skillEntry.identifier);
		assert.match(lock!.sha256, /^[a-f0-9]{64}$/);
		assert.equal(lock!.sha256, createHash("sha256").update(SKILL).digest("hex"));
		assert.equal(lock!.url, "https://example.com/skills/pdf-tools/SKILL.md");
		assert.equal(lock!.trusted, true);
		assert.deepEqual((out as { missing: string[] }).missing, []);
	});

	it("real HF skill: bundled files it cites are reported missing (only SKILL.md is installed)", async () => {
		const t = ctx(mock, [true]);
		const out = await install({ ...skillEntry, identifier: "urn:air:example.com:skill:pp", url: "https://example.com/skills/huggingface-paper-publisher/SKILL.md" }, t.c);
		assert.deepEqual((out as { missing: string[] }).missing, ["scripts/paper_manager.py"]);
	});

	it("corrupt lock.json: refuses before writing (was: SKILL.md written, then throw, orphan left)", async () => {
		const t = ctx(mock, [true]);
		mkdirSync(join(t.agentDir, "pi-ard"), { recursive: true });
		writeFileSync(join(t.agentDir, "pi-ard", "lock.json"), "{not json");
		await assert.rejects(install(skillEntry, t.c), /Corrupt .*lock\.json.*nothing was installed/);
		assert.ok(!existsSync(join(t.agentDir, "skills", "pdf-tools")));
	});

	it("never overwrites an existing skill", async () => {
		const t = ctx(mock, [true]);
		mkdirSync(join(t.agentDir, "skills", "pdf-tools"), { recursive: true });
		const out = await install(skillEntry, t.c);
		assert.equal(out.status, "refused");
		assert.match((out as { reason: string }).reason, /already exists/);
	});

	it("untrusted source: still installable, but the prompt says UNTRUSTED", async () => {
		const t = ctx(mock, [true]);
		const out = await install({ ...skillEntry, identifier: "urn:air:untrusted.io:skill:x", url: "https://untrusted.io/s/SKILL.md" }, t.c);
		assert.equal(out.status, "installed");
		assert.match(t.asked[0]!, /UNTRUSTED SOURCE/);
		assert.match(t.asked[0]!, /Signature: unsigned/);
	});

	it("trusted publisher but artifact on an untrusted host counts as untrusted", async () => {
		const t = ctx(mock, [false]);
		await install({ ...skillEntry, url: "https://untrusted.io/s/SKILL.md" }, t.c);
		assert.match(t.asked[0]!, /host untrusted\.io not in trustedDomains/);
	});

	it("non-SKILL.md content refused after fetch, nothing written", async () => {
		const t = ctx(mock, [true]);
		const out = await install({ ...skillEntry, url: "https://example.com/notskill.md" }, t.c);
		assert.equal(out.status, "refused");
		assert.ok(!existsSync(join(t.agentDir, "skills", "pdf-tools")));
	});

	it("identity mismatch refused before asking", async () => {
		const t = ctx(mock, []);
		const out = await install({ ...skillEntry, trustManifest: { identity: "spiffe://evil.com/x" } }, t.c);
		assert.equal(out.status, "refused");
		assert.equal(t.asked.length, 0);
	});

	it("declared trust manifest shown as NOT verified", async () => {
		const t = ctx(mock, [false]);
		await install({ ...skillEntry, trustManifest: { identity: "spiffe://example.com/x", trustSchema: { identifier: "ai-card-trust" } } }, t.c);
		assert.match(t.asked[0]!, /trust manifest declared \(ai-card-trust\), signature NOT verified/);
	});

	it("unresolvable source (GitHub tree page) refused without asking", async () => {
		const t = ctx(mock, []);
		const out = await install({ ...skillEntry, type: "application/ai-skill", url: "https://github.com/a/b/tree/main/x" }, t.c);
		assert.equal(out.status, "refused");
		assert.match((out as { reason: string }).reason, /Not guessing/);
	});
});

describe("install: MCP", () => {
	let mock: MockServer;
	before(async () => {
		mock = await mockServer({
			"GET /huggingface.co/mcp/server-card": () => ({ json: fixtureJson("live/hf-mcp-server-card.json") }),
			"GET /registry.example.com/markitdown": () => ({ json: fixtureJson("live/mcp-registry-markitdown.json") }),
			"GET /example.com/plain-http-card": () => ({ json: { name: "x", remotes: [{ type: "streamable-http", url: "http://example.com/mcp" }] } }),
		});
	});
	after(() => mock.close());

	const hfEntry = (fixtureJson("live/hf-ai-catalog.json") as { entries: ArdEntry[] }).entries.find((e) => e.type === "application/mcp-server-card+json")!;

	it("HF real card: one confirm; named from the identifier (card name \"huggingface.co/mcp\" would give mcp__mcp__*)", async () => {
		const t = ctx(mock, [true]);
		const out = await install(hfEntry, t.c);
		assert.equal(out.status, "mcp-ready");
		assert.deepEqual(t.registered, [["huggingface-hub", { url: "https://huggingface.co/mcp", description: "Official MCP server for the Hugging Face Hub." }]]);
		assert.equal((out as { persistCommand: string }).persistCommand, "pi mcp add huggingface-hub --url https://huggingface.co/mcp");
		assert.equal(t.asked.length, 1);
	});

	it("declined: nothing registered", async () => {
		const t = ctx(mock, [false]);
		assert.equal((await install(hfEntry, t.c)).status, "declined");
		assert.equal(t.registered.length, 0);
	});

	it("stdio (MCP registry server.json): two confirmations; second decline registers nothing", async () => {
		const e: ArdEntry = { identifier: "urn:air:registry.example.com:mcp:markitdown", type: "application/mcp-server+json", url: "https://registry.example.com/markitdown" };
		const t = ctx(mock, [true, false], { trustedDomains: ["registry.example.com"] });
		const out = await install(e, t.c);
		assert.equal(out.status, "declined");
		assert.equal(t.asked.length, 2);
		assert.match(t.asked[0]!, /LOCAL PROCESS/);
		assert.equal(t.registered.length, 0);

		const t2 = ctx(mock, [true, true], { trustedDomains: ["registry.example.com"] });
		const out2 = await install(e, t2.c);
		assert.equal(out2.status, "mcp-ready");
		assert.equal(t2.registered.length, 1);
		assert.deepEqual(t2.registered[0], ["markitdown", { command: "uvx", args: ["markitdown-mcp==0.0.1a4"], description: t2.registered[0]![1].description }]);
	});

	it("untrusted card host: asks before even fetching the card", async () => {
		const e: ArdEntry = { identifier: "urn:air:registry.example.com:mcp:markitdown", type: "application/mcp-server+json", url: "https://registry.example.com/markitdown" };
		const t = ctx(mock, [false], { trustedDomains: [] });
		assert.equal((await install(e, t.c)).status, "declined");
		assert.equal(t.http.calls.length, 0);
	});

	it("trust follows the server URL: a trusted card naming another host's remote is UNTRUSTED", async () => {
		// Before: only the card URL was assessed, so this prompted "Trust: trusted" for attacker.example.
		const t = ctx(mock, [false]);
		await install({ identifier: "urn:air:huggingface.co:mcp:x", type: "application/mcp-server-card+json", data: { name: "x", remotes: [{ type: "streamable-http", url: "https://attacker.example/mcp" }] } }, t.c);
		assert.match(t.asked[0]!, /^Add MCP server "x" from UNTRUSTED source\?/);
		assert.match(t.asked[0]!, /host attacker\.example not in trustedDomains/);
	});

	it("plain-http MCP remote refused", async () => {
		const t = ctx(mock, []);
		await assert.rejects(install({ identifier: "urn:air:example.com:mcp:x", type: "application/mcp-server-card+json", url: "https://example.com/plain-http-card" }, t.c), /Only https/);
		assert.equal(t.registered.length, 0);
	});

	it("A2A / registry / unknown types refused with guidance", async () => {
		const t = ctx(mock, []);
		assert.match(JSON.stringify(await install({ identifier: "urn:air:x.com:a:b", type: "application/a2a-agent-card+json", url: "https://x.com/c" }, t.c)), /A2A/);
		assert.match(JSON.stringify(await install({ identifier: "urn:air:x.com:a:b", type: "application/ai-registry+json", url: "https://x.com" }, t.c)), /registries/);
		assert.match(JSON.stringify(await install({ identifier: "urn:air:x.com:a:b", type: "text/html", url: "https://x.com" }, t.c)), /Unsupported/);
	});

	it("planMcp: prefers streamable-http remote; stdio pins version", () => {
		const p = planMcp(fixtureJson("live/hf-mcp-server-card.json"), hfEntry, "u")!;
		assert.equal(p.transport, "http");
		const s = planMcp(fixtureJson("live/mcp-registry-markitdown.json"), { identifier: "urn:air:a.com:m:x" }, "u")!;
		assert.deepEqual([s.transport, s.command, s.args], ["stdio", "uvx", ["markitdown-mcp==0.0.1a4"]]);
		assert.equal(planMcp({ name: "x" }, { identifier: "urn:air:a.com:m:x" }, "u"), undefined);
		// A card must not pick the program or inject flags: runtimeHint is ignored, ids are validated.
		const hostile = (p: Record<string, unknown>) => planMcp({ packages: [{ transport: { type: "stdio" }, ...p }] }, { identifier: "urn:air:a.com:m:x" }, "u");
		assert.deepEqual(hostile({ identifier: "x", registryType: "pypi", runtimeHint: "bash" })?.command, "uvx");
		assert.equal(hostile({ identifier: "-c", registryType: "pypi" }), undefined);
		assert.equal(hostile({ identifier: "a b", registryType: "npm" }), undefined);
		assert.deepEqual(hostile({ identifier: "x", registryType: "npm", version: "1;rm -rf ~" })?.args, ["-y", "x"]);
	});
});
