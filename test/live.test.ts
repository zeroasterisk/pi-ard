/**
 * Live checks against real public ARD registries. Opt-in: PI_ARD_LIVE=1.
 * Read-only: search + catalog + one SKILL.md download to a temp dir with an auto-confirm.
 * Asserts ARD shape, not specific results (registry contents change).
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fetchCatalog, search } from "../src/core/client.ts";
import { DEFAULT_CONFIG } from "../src/core/config.ts";
import { checkEntry } from "../src/core/entry.ts";
import { installSkill, skillSourceUrl } from "../src/core/install.ts";

const LIVE = process.env.PI_ARD_LIVE === "1";
const opts = { skip: !LIVE && "set PI_ARD_LIVE=1", timeout: 60_000 };

describe("live registries", () => {
	it("Hugging Face Discover: search returns urn:air results", opts, async () => {
		const r = await search(DEFAULT_CONFIG.registries[0]!, { text: "pdf", pageSize: 5 });
		assert.ok(r.results.length > 0, "expected results");
		for (const e of r.results) assert.deepEqual(checkEntry(e, false).problems, [], e.identifier);
	});

	it("GitHub Agent Finder: search via searchUrl", opts, async () => {
		const r = await search({ name: "github", searchUrl: "https://agentfinder.github.com/api/v1/search" }, { text: "pdf", pageSize: 5 });
		assert.ok(r.results.length > 0);
		assert.ok(r.results.every((e) => typeof e.type === "string"));
	});

	it("huggingface.co catalog resolves (ard.json or ai-catalog.json fallback)", opts, async () => {
		const r = await fetchCatalog("huggingface.co");
		assert.ok(r.entries.length > 0);
		console.log(`# huggingface.co catalog via ${r.path}${r.fallbackReason ? ` (${r.fallbackReason})` : ""}`);
	});

	it("end-to-end: search HF for a skill, resolve raw SKILL.md, install to temp dir", opts, async () => {
		const r = await search(DEFAULT_CONFIG.registries[0]!, { text: "paper", types: ["application/agent-skills+md"], pageSize: 10 });
		const entry = r.results.find((e) => skillSourceUrl(e));
		assert.ok(entry, "a result with a resolvable SKILL.md");
		const agentDir = mkdtempSync(join(tmpdir(), "pi-ard-live-"));
		const out = await installSkill(entry, {
			agentDir,
			config: { registries: [], trustedDomains: ["huggingface.co", "github.com", "raw.githubusercontent.com"] },
			confirm: async () => true,
		});
		assert.equal(out.status, "installed", JSON.stringify(out));
		const body = readFileSync(join((out as { path: string }).path, "SKILL.md"), "utf8");
		assert.match(body, /^---\r?\n[\s\S]*?name:/);
	});
});
