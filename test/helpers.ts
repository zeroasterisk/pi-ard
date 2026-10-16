import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HttpOptions } from "../src/core/http.ts";

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
export const fixture = (p: string) => readFileSync(join(FIXTURES, p), "utf8");
export const fixtureJson = (p: string) => JSON.parse(fixture(p)) as unknown;

export type Route = (req: IncomingMessage, body: string) => { status?: number; json?: unknown; text?: string; headers?: Record<string, string> };

export interface MockServer {
	origin: string;
	host: string;
	requests: Array<{ method: string; path: string; body: string }>;
	close(): Promise<void>;
}

/** Local HTTP server standing in for ARD registries, catalogs and artifact hosts. */
export async function mockServer(routes: Record<string, Route>): Promise<MockServer> {
	const requests: MockServer["requests"] = [];
	const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			const path = (req.url ?? "/").split("?")[0]!;
			requests.push({ method: req.method ?? "GET", path, body });
			const route = routes[`${req.method} ${path}`];
			if (!route) {
				res.writeHead(404, { "content-type": "text/html" }).end("<h1>404</h1>");
				return;
			}
			const r = route(req, body);
			const headers = { ...(r.json !== undefined ? { "content-type": "application/json" } : { "content-type": "text/plain" }), ...r.headers };
			res.writeHead(r.status ?? 200, headers).end(r.json !== undefined ? JSON.stringify(r.json) : (r.text ?? ""));
		});
	});
	await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
	const port = (server.address() as { port: number }).port;
	return {
		origin: `http://127.0.0.1:${port}`,
		host: `127.0.0.1:${port}`,
		requests,
		close: () => new Promise((ok) => server.close(() => ok())),
	};
}

/**
 * Rewrites https://<name>/... to the mock server so tests exercise real HTTPS-only logic
 * (URL checks, host trust) against named hosts, while bytes go to localhost.
 */
export function routedHttp(mock: MockServer, extra: Partial<HttpOptions> = {}): HttpOptions & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		...extra,
		fetch: (input, init) => {
			calls.push(`${init?.method ?? "GET"} ${input}`);
			const u = new URL(input);
			const target = `${mock.origin}/${u.hostname}${u.pathname}${u.search}`;
			return fetch(target, init).then(async (res) => {
				// Keep relative/absolute redirects pointing at the logical host.
				const loc = res.headers.get("location");
				if (!loc) return res;
				const headers = new Headers(res.headers);
				headers.set("location", loc.startsWith("/") ? `https://${loc.slice(1).replace(/^([^/]+)/, "$1")}` : loc);
				return new Response(res.body, { status: res.status, headers });
			});
		},
	};
}
