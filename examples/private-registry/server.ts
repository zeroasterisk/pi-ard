/**
 * A minimal, spec-shaped ARD registry for owners who want to run their own trusted endpoint.
 * Serves POST /search (ARD §5.3.2) and GET /.well-known/ard.json (§5.1) from a JSON file.
 *
 * Run:  node --experimental-strip-types examples/private-registry/server.ts [port]
 * Then: point pi-ard at it (examples/private-registry/config.json) — loopback http is allowed.
 * In production put it behind HTTPS on a domain you list in trustedDomains.
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, "ard.json"), "utf8")) as { entries: Array<Record<string, unknown>> };
const port = Number(process.argv[2] ?? 8787);

function err(res: import("node:http").ServerResponse, status: number, code: string, message: string) {
	res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: { code, message } }));
}

createServer((req, res) => {
	if (req.method === "GET" && req.url === "/.well-known/ard.json") {
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(manifest));
		return;
	}
	if (req.method === "POST" && req.url === "/search") {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			let q: { query?: { text?: string; filter?: { type?: string[] } }; pageSize?: number };
			try {
				q = JSON.parse(body);
			} catch {
				return err(res, 400, "INVALID_ARGUMENT", "body must be JSON");
			}
			const text = q.query?.text?.toLowerCase().trim();
			if (!text) return err(res, 400, "INVALID_ARGUMENT", "query.text is required");
			const types = q.query?.filter?.type;
			const terms = text.split(/\s+/);
			const results = manifest.entries
				.filter((e) => !types?.length || types.includes(String(e.type)))
				.map((e) => {
					const hay = [e.displayName, e.description, ...((e.tags as string[]) ?? [])].join(" ").toLowerCase();
					return { ...e, score: terms.filter((t) => hay.includes(t)).length / terms.length };
				})
				.filter((e) => e.score > 0)
				.sort((a, b) => b.score - a.score)
				.slice(0, Math.min(q.pageSize ?? 10, 100));
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ results }));
		});
		return;
	}
	err(res, 404, "NOT_FOUND", "not found");
}).listen(port, "127.0.0.1", () => console.log(`ARD registry on http://127.0.0.1:${port} (POST /search, GET /.well-known/ard.json)`));
