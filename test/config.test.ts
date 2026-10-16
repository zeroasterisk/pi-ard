import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_CONFIG, configPath, loadConfig, validateConfig } from "../src/core/config.ts";

describe("config", () => {
	it("missing file = defaults (Hugging Face Discover, trusts huggingface.co)", () => {
		const c = loadConfig("/nonexistent/config.json");
		assert.deepEqual(c, DEFAULT_CONFIG);
		assert.notEqual(c, DEFAULT_CONFIG, "returns a copy");
	});

	it("rejects bad shapes with specific messages", () => {
		assert.match(validateConfig({ registries: [{ name: "x" }] }).join(), /exactly one of url or searchUrl/);
		assert.match(validateConfig({ registries: [{ name: "x", url: "https://a", searchUrl: "https://b" }] }).join(), /exactly one/);
		assert.match(validateConfig({ registries: [{ name: "bad name", url: "https://a" }] }).join(), /name must match/);
		assert.match(validateConfig({ trustedDomains: "a.com" }).join(), /array of strings/);
		assert.deepEqual(validateConfig({}), []);
	});

	it("invalid file throws with path", () => {
		const p = join(mkdtempSync(join(tmpdir(), "pi-ard-c-")), "config.json");
		writeFileSync(p, JSON.stringify({ registries: {} }));
		assert.throws(() => loadConfig(p), /Invalid .*config\.json: registries must be an array/);
	});

	it("PI_ARD_CONFIG overrides path; default is <agentDir>/pi-ard/config.json", () => {
		const prev = process.env.PI_ARD_CONFIG;
		delete process.env.PI_ARD_CONFIG;
		assert.equal(configPath("/a"), "/a/pi-ard/config.json");
		process.env.PI_ARD_CONFIG = "/x.json";
		assert.equal(configPath("/a"), "/x.json");
		if (prev === undefined) delete process.env.PI_ARD_CONFIG;
		else process.env.PI_ARD_CONFIG = prev;
	});
});
