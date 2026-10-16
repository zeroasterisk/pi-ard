import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import { mockServer, routedHttp, type MockServer } from "./helpers.ts";
import { piHarness } from "./pi-harness.ts";

const SKILL = "---\nname: pdf-tools\ndescription: Work with PDFs\n---\n# PDF tools\n";

describe("pi e2e: extension loaded into a real Pi AgentSession", () => {
	let mock: MockServer;
	before(async () => {
		mock = await mockServer({
			"POST /reg.example.com/search": () => ({
				json: {
					results: [
						{
							identifier: "urn:air:example.com:skill:pdf-tools",
							displayName: "PDF tools",
							type: "application/agent-skills+md",
							url: "https://example.com/skills/pdf-tools/SKILL.md",
							score: 0.9,
						},
					],
				},
			}),
			"GET /example.com/skills/pdf-tools/SKILL.md": () => ({ text: SKILL }),
		});
	});
	after(() => mock.close());

	function cfg(agentDir: string) {
		mkdirSync(join(agentDir, "pi-ard"), { recursive: true });
		writeFileSync(
			join(agentDir, "pi-ard", "config.json"),
			JSON.stringify({ registries: [{ name: "corp", url: "https://reg.example.com" }], trustedDomains: ["example.com"] }),
		);
	}

	it("registers exactly ard_search, ard_catalog, ard_install and /ard", async () => {
		const h = await piHarness({ ard: { http: routedHttp(mock) } });
		try {
			const tools = h.session.getAllTools().map((t) => t.name).filter((n) => n.startsWith("ard_")).sort();
			assert.deepEqual(tools, ["ard_catalog", "ard_install", "ard_search"]);
			cfg(h.agentDir);
			await h.session.prompt("/ard");
			assert.equal(h.notifications.length, 1, "/ard must run as an extension command, not reach the model");
			assert.match(h.notifications[0]!, /corp {2}https:\/\/reg\.example\.com\/search/);
			assert.match(h.notifications[0]!, /trustedDomains: example\.com/);
		} finally {
			h.dispose();
		}
	});

	it("model searches then installs; the user's Pi confirm gates the write", async () => {
		const h = await piHarness({ answers: [true], ard: { http: routedHttp(mock) } });
		cfg(h.agentDir);
		try {
			h.setResponses([
				fauxAssistantMessage(fauxToolCall("ard_search", { text: "pdf" }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("ard_install", { identifier: "urn:air:example.com:skill:pdf-tools" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await h.session.prompt("find and install a pdf skill");
			const [searchOut] = h.toolResults("ard_search");
			assert.match(searchOut!, /PDF tools <urn:air:example\.com:skill:pdf-tools> \[skill, trusted, unsigned\]/);
			assert.match(searchOut!, /relevance only, not trust/);
			const [installOut] = h.toolResults("ard_install");
			assert.match(installOut!, /^installed: skill "pdf-tools"/);
			assert.equal(h.confirms.length, 1);
			assert.match(h.confirms[0]!.body, /Signature: unsigned/);
			assert.equal(readFileSync(join(h.agentDir, "skills", "pdf-tools", "SKILL.md"), "utf8"), SKILL);
			// "installed" must mean Pi actually loads it: run Pi's own skill loader against agentDir.
			const loaded = loadSkills({ cwd: h.agentDir, agentDir: h.agentDir, skillPaths: [], includeDefaults: true });
			assert.deepEqual(loaded.skills.map((s) => [s.name, s.description]), [["pdf-tools", "Work with PDFs"]]);
			assert.deepEqual(loaded.diagnostics, []);
		} finally {
			h.dispose();
		}
	});

	it("an identifier two sources point to different urls is not installable (no silent last-write-wins)", async () => {
		const m = await mockServer({
			"POST /reg.example.com/search": () => ({ json: { results: [{ identifier: "urn:air:example.com:skill:pdf-tools", type: "application/agent-skills+md", url: "https://example.com/skills/pdf-tools/SKILL.md" }] } }),
			"POST /other.example.org/search": () => ({ json: { results: [{ identifier: "urn:air:example.com:skill:pdf-tools", type: "application/agent-skills+md", url: "https://example.com/evil/SKILL.md" }] } }),
		});
		const h = await piHarness({ answers: [], ard: { http: routedHttp(m) } });
		mkdirSync(join(h.agentDir, "pi-ard"), { recursive: true });
		writeFileSync(join(h.agentDir, "pi-ard", "config.json"), JSON.stringify({ registries: [{ name: "a", url: "https://reg.example.com" }, { name: "b", url: "https://other.example.org" }], trustedDomains: ["example.com"] }));
		try {
			h.setResponses([
				fauxAssistantMessage(fauxToolCall("ard_search", { text: "pdf" }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("ard_search", { text: "pdf", registry: "b" }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("ard_install", { identifier: "urn:air:example.com:skill:pdf-tools" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("ok"),
			]);
			await h.session.prompt("install pdf-tools");
			assert.match(h.toolResults("ard_install")[0]!, /different urls by different sources/);
			assert.equal(h.confirms.length, 0);
		} finally {
			h.dispose();
			await m.close();
		}
	});

	it("install of an identifier never returned by search is rejected (model cannot fabricate entries)", async () => {
		const h = await piHarness({ answers: [], ard: { http: routedHttp(mock) } });
		cfg(h.agentDir);
		try {
			h.setResponses([
				fauxAssistantMessage(fauxToolCall("ard_install", { identifier: "urn:air:evil.com:skill:x" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("ok"),
			]);
			await h.session.prompt("install it");
			assert.match(h.toolResults("ard_install")[0]!, /Unknown identifier/);
			assert.equal(h.confirms.length, 0);
		} finally {
			h.dispose();
		}
	});

	it("without a UI (print mode) install refuses instead of auto-approving", async () => {
		const h = await piHarness({ hasUI: false, ard: { http: routedHttp(mock) } });
		cfg(h.agentDir);
		try {
			h.setResponses([
				fauxAssistantMessage(fauxToolCall("ard_search", { text: "pdf" }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("ard_install", { identifier: "urn:air:example.com:skill:pdf-tools" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("ok"),
			]);
			await h.session.prompt("install");
			assert.match(h.toolResults("ard_install")[0]!, /needs an interactive Pi UI/);
		} finally {
			h.dispose();
		}
	});
});
