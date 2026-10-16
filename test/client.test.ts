import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { fetchCatalog, search, searchEndpoint } from "../src/core/client.ts";
import { ArdHttpError, assertSafeUrl, request } from "../src/core/http.ts";
import { fixture, fixtureJson, mockServer, routedHttp, type MockServer } from "./helpers.ts";

describe("http safety", () => {
	it("https only, loopback http allowed, no credentials in URLs", () => {
		assert.ok(assertSafeUrl("https://a.com/x"));
		assert.ok(assertSafeUrl("http://127.0.0.1:9/x"));
		assert.ok(assertSafeUrl("http://localhost/x"));
		assert.throws(() => assertSafeUrl("http://a.com/x"), /Only https/);
		assert.throws(() => assertSafeUrl("file:///etc/passwd"), /Only https/);
		assert.throws(() => assertSafeUrl("https://u:p@a.com/"), /credentials/);
	});
});

describe("contract: search against recorded live registry responses", () => {
	let mock: MockServer;
	before(async () => {
		mock = await mockServer({
			"POST /hf.test/search": (_r, body) => {
				const q = JSON.parse(body) as { query?: { text?: string; filter?: { type?: string[] } } };
				if (!q.query?.text) return { status: 422, text: fixture("live/hf-search-400.txt").replace(/\n?\d+$/, "") };
				if (q.query.filter?.type?.[0] === "application/mcp-server-card+json") return { json: fixtureJson("live/hf-search-filter-mcp.json") };
				return { json: fixtureJson("live/hf-search-skill.json") };
			},
			"POST /gh.test/search": (_r, body) => {
				const q = JSON.parse(body) as { query?: { text?: string } };
				if (!q.query?.text) return { status: 400, json: { error: "INVALID_ARGUMENT", message: "query.text is required" } };
				return { json: fixtureJson("live/gh-search.json") };
			},
			"POST /rl.test/search": () => ({ status: 429, json: { error: "RATE_LIMIT_EXCEEDED" }, headers: { "retry-after": "30" } }),
			"POST /big.test/search": () => ({ json: { results: [], pad: "x".repeat(2_000_000) } }),
			"POST /bad.test/search": () => ({ json: { hits: [] } }),
		});
	});
	after(() => mock.close());

	it("HF Discover: parses results, sends ARD request shape", async () => {
		const http = routedHttp(mock);
		const r = await search({ name: "hf", url: "https://hf.test" }, { text: "paper", pageSize: 5 }, http);
		assert.ok(r.results.length > 0);
		assert.ok(r.results.every((e) => e.identifier.startsWith("urn:air:")));
		const sent = JSON.parse(mock.requests.at(-1)!.body);
		assert.deepEqual(sent, { query: { text: "paper" }, federation: "none", pageSize: 5 });
		assert.equal(http.calls[0], "POST https://hf.test/search");
	});

	it("type filter is sent as query.filter.type, expanded with registry aliases of the same kind", async () => {
		const r = await search({ name: "hf", url: "https://hf.test/" }, { text: "video", types: ["application/mcp-server-card+json"] }, routedHttp(mock));
		assert.ok(r.results.every((e) => e.type === "application/mcp-server-card+json"));
		// Live 2026-10-16: GitHub returns 0 for mcp-server-card+json, 2 for its mcp-server+json alias.
		assert.deepEqual(JSON.parse(mock.requests.at(-1)!.body).query.filter, { type: ["application/mcp-server-card+json", "application/mcp-server+json"] });
	});

	it("GitHub Agent Finder: mediaType normalized to type; pageToken surfaced", async () => {
		const r = await search({ name: "gh", url: "https://gh.test" }, { text: "pdf" }, routedHttp(mock));
		assert.ok(r.results.every((e) => typeof e.type === "string"));
		assert.equal(r.pageToken, (fixtureJson("live/gh-search.json") as { pageToken: string }).pageToken);
		assert.ok(r.pageToken && r.pageToken.length > 0);
	});

	it("errors carry status and ARD code; FastAPI 422 detail is readable", async () => {
		await assert.rejects(search({ name: "rl", url: "https://rl.test" }, { text: "x" }, routedHttp(mock)), (e: ArdHttpError) => {
			assert.equal(e.status, 429);
			assert.equal(e.code, "RATE_LIMIT_EXCEEDED");
			assert.match(e.message, /retry-after 30s/);
			return true;
		});
		await assert.rejects(search({ name: "bad", url: "https://bad.test" }, { text: "x" }, routedHttp(mock)), /no results\[\] array/);
	});

	it("empty query rejected client-side with INVALID_ARGUMENT (no request)", async () => {
		const before = mock.requests.length;
		await assert.rejects(search({ name: "hf", url: "https://hf.test" }, { text: "  " }, routedHttp(mock)), /required/);
		assert.equal(mock.requests.length, before);
	});

	it("pageSize clamped to 1..100 (HF rejects >100 with 422)", async () => {
		await search({ name: "hf", url: "https://hf.test" }, { text: "x", pageSize: 500 }, routedHttp(mock));
		assert.equal(JSON.parse(mock.requests.at(-1)!.body).pageSize, 100);
	});

	it("response size cap", async () => {
		await assert.rejects(search({ name: "big", url: "https://big.test" }, { text: "x" }, routedHttp(mock)), /too large/);
	});

	it("searchUrl used verbatim (any ARD search endpoint)", () => {
		assert.equal(searchEndpoint({ name: "x", searchUrl: "https://a.com/api/v1/search" }), "https://a.com/api/v1/search");
		assert.equal(searchEndpoint({ name: "x", url: "https://a.com/" }), "https://a.com/search");
	});
});

describe("contract: catalog resolution (§5.1)", () => {
	let mock: MockServer;
	before(async () => {
		mock = await mockServer({
			// HF today: ard.json 401 HTML, ai-catalog.json works.
			"GET /huggingface.co/.well-known/ard.json": () => ({ status: 401, text: "<html>" }),
			"GET /huggingface.co/.well-known/ai-catalog.json": () => ({ json: fixtureJson("live/hf-ai-catalog.json") }),
			"GET /spec.test/.well-known/ard.json": () => ({ json: fixtureJson("spec/basic-ard.json") }),
			"GET /mixed.test/.well-known/ard.json": () => ({
				json: { entries: [{ identifier: "urn:air:mixed.test:a:ok", displayName: "ok", type: "x", url: "https://mixed.test/a" }, { identifier: "urn:air:mixed.test:a:bad", url: "https://x", data: {} }] },
			}),
			"GET /redir.test/.well-known/ard.json": () => ({ status: 302, headers: { location: "https://evil.test/.well-known/ard.json" } }),
			"GET /none.test/.well-known/ard.json": () => ({ status: 404, text: "" }),
		});
	});
	after(() => mock.close());

	it("ard.json first", async () => {
		const r = await fetchCatalog("spec.test", routedHttp(mock));
		assert.equal(r.path, "ard.json");
		assert.ok(r.entries.length > 0);
	});

	it("falls back to ai-catalog.json and says why (HF reality)", async () => {
		const r = await fetchCatalog("https://huggingface.co/", routedHttp(mock));
		assert.equal(r.path, "ai-catalog.json");
		assert.match(r.fallbackReason!, /401/);
		assert.equal(r.specVersion, "1.0");
		assert.ok(r.entries.some((e) => e.type === "application/mcp-server-card+json"));
	});

	it("invalid entries are separated, not dropped silently", async () => {
		const r = await fetchCatalog("mixed.test", routedHttp(mock));
		assert.equal(r.entries.length, 1);
		assert.equal(r.invalid.length, 1);
		assert.match(r.invalid[0]!.problems.join(), /both url and data/);
	});

	it("cross-host redirect blocked", async () => {
		await assert.rejects(fetchCatalog("redir.test", routedHttp(mock)), /No catalog.*blocked/s);
	});

	it("both missing: one error naming both paths", async () => {
		await assert.rejects(fetchCatalog("none.test", routedHttp(mock)), /ard\.json: HTTP 404.*ai-catalog\.json: HTTP 404/s);
	});

	it("non-domain input rejected", async () => {
		await assert.rejects(fetchCatalog("a b", routedHttp(mock)), /Not a domain/);
	});

	it("POST redirects are never followed", async () => {
		const m = await mockServer({ "POST /r.test/x": () => ({ status: 307, headers: { location: "/r.test/y" } }) });
		try {
			await assert.rejects(request("https://r.test/x", { method: "POST" }, routedHttp(m)), /Redirect not followed/);
		} finally {
			await m.close();
		}
	});
});
