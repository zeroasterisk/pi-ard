export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpOptions {
	fetch?: FetchLike;
	timeoutMs?: number;
	maxBytes?: number;
	signal?: AbortSignal;
}

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_BYTES = 1_000_000;

/** Standard ARD error codes (Appendix B), used when a server does not send one. */
const STANDARD_CODES: Record<number, string> = {
	400: "INVALID_ARGUMENT",
	401: "UNAUTHENTICATED",
	404: "NOT_FOUND",
	429: "RATE_LIMIT_EXCEEDED",
	500: "INTERNAL_ERROR",
};

export class ArdHttpError extends Error {
	readonly status: number | undefined;
	readonly code: string | undefined;
	readonly url: string;
	constructor(message: string, url: string, status?: number, code?: string) {
		super(message);
		this.name = "ArdHttpError";
		this.url = url;
		this.status = status;
		this.code = code;
	}
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** Loopback hosts may use plain http, so owners can test local registries. */
export const isLoopback = (hostname: string) => LOOPBACK.has(hostname);

/** HTTPS only (loopback http allowed). No credentials in URLs. */
export function assertSafeUrl(raw: string): URL {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new ArdHttpError(`Not a valid URL: ${raw}`, raw);
	}
	if (url.username || url.password) throw new ArdHttpError("URLs with credentials are not allowed", raw);
	if (url.protocol === "https:") return url;
	if (url.protocol === "http:" && isLoopback(url.hostname)) return url;
	throw new ArdHttpError(`Only https URLs are allowed (got ${url.protocol}//${url.host})`, raw);
}

async function readLimited(res: Response, url: string, maxBytes: number): Promise<string> {
	const declared = Number(res.headers.get("content-length") ?? "0");
	if (declared > maxBytes) throw new ArdHttpError(`Response too large (${declared} > ${maxBytes} bytes)`, url, res.status);
	if (!res.body) return "";
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			throw new ArdHttpError(`Response too large (> ${maxBytes} bytes)`, url, res.status);
		}
		chunks.push(value);
	}
	return new TextDecoder().decode(Buffer.concat(chunks));
}

function errorFromBody(status: number, body: string): { code?: string; message?: string } {
	try {
		const j = JSON.parse(body) as Record<string, unknown>;
		const err = j.error;
		if (typeof err === "string") return { code: err, message: typeof j.message === "string" ? j.message : undefined };
		if (err && typeof err === "object") {
			const e = err as Record<string, unknown>;
			return { code: typeof e.code === "string" ? e.code : undefined, message: typeof e.message === "string" ? e.message : undefined };
		}
		if (typeof j.code === "string") return { code: j.code, message: typeof j.message === "string" ? j.message : undefined };
		if (Array.isArray(j.detail) && j.detail[0] && typeof j.detail[0] === "object") {
			const d = j.detail[0] as Record<string, unknown>;
			return { message: `${Array.isArray(d.loc) ? d.loc.join(".") + ": " : ""}${String(d.msg ?? "")}` };
		}
	} catch {
		// non-JSON body
	}
	return { message: status >= 500 ? undefined : body.slice(0, 200).replace(/\s+/g, " ").trim() || undefined };
}

export interface HttpResult {
	url: string;
	status: number;
	contentType: string;
	body: string;
}

/**
 * One request, no retries. Redirects are followed only for GET and only to the same host (max 3).
 * Non-2xx responses throw ArdHttpError carrying the status and ARD error code.
 */
export async function request(rawUrl: string, init: RequestInit, opts: HttpOptions = {}): Promise<HttpResult> {
	const doFetch = opts.fetch ?? (globalThis.fetch as FetchLike);
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
	let url = assertSafeUrl(rawUrl);
	const origin = url.host;
	const method = (init.method ?? "GET").toUpperCase();
	for (let hop = 0; hop <= 3; hop++) {
		const signals = [AbortSignal.timeout(timeoutMs)];
		if (opts.signal) signals.push(opts.signal);
		let res: Response;
		try {
			res = await doFetch(url.toString(), { ...init, redirect: "manual", signal: AbortSignal.any(signals) });
		} catch (e) {
			const msg = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError") ? `timed out after ${timeoutMs} ms` : String(e);
			throw new ArdHttpError(`Request failed: ${msg}`, url.toString());
		}
		if (res.status >= 300 && res.status < 400) {
			const loc = res.headers.get("location");
			if (!loc || method !== "GET") throw new ArdHttpError(`Redirect not followed (HTTP ${res.status})`, url.toString(), res.status);
			const next = assertSafeUrl(new URL(loc, url).toString());
			if (next.host !== origin) throw new ArdHttpError(`Redirect off ${origin} to ${next.host} blocked`, url.toString(), res.status);
			url = next;
			continue;
		}
		const body = await readLimited(res, url.toString(), maxBytes);
		if (!res.ok) {
			const parsed = errorFromBody(res.status, body);
			const code = parsed.code ?? STANDARD_CODES[res.status];
			const retry = res.headers.get("retry-after");
			const parts = [`HTTP ${res.status}`, code, parsed.message, retry ? `retry-after ${retry}s` : undefined].filter(Boolean);
			throw new ArdHttpError(parts.join(" "), url.toString(), res.status, code);
		}
		return { url: url.toString(), status: res.status, contentType: res.headers.get("content-type") ?? "", body };
	}
	throw new ArdHttpError("Too many redirects", rawUrl);
}

export async function getJson(url: string, opts?: HttpOptions): Promise<{ url: string; json: unknown }> {
	const r = await request(url, { method: "GET", headers: { accept: "application/json" } }, opts);
	try {
		return { url: r.url, json: JSON.parse(r.body) };
	} catch {
		throw new ArdHttpError(`Not JSON (content-type ${r.contentType || "none"})`, r.url, r.status);
	}
}

export async function postJson(url: string, payload: unknown, opts?: HttpOptions): Promise<unknown> {
	const r = await request(
		url,
		{ method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(payload) },
		opts,
	);
	try {
		return JSON.parse(r.body);
	} catch {
		throw new ArdHttpError(`Not JSON (content-type ${r.contentType || "none"})`, r.url, r.status);
	}
}
