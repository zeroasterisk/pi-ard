import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { lockPath, readLock, writeJsonAtomic, type LockEntry } from "./config.ts";
import { checkEntry, hostOf, isTrustedDomain, signatureLabel, type EntryCheck } from "./entry.ts";
import { type HttpOptions, assertSafeUrl, getJson, request } from "./http.ts";
import type { ArdConfig, ArdEntry } from "./types.ts";

/**
 * The only way anything gets installed. `confirm` must be a human prompt supplied by the host UI
 * (Pi: ctx.ui.confirm). There is deliberately no boolean "already confirmed" parameter.
 */
export type Confirm = (title: string, body: string) => Promise<boolean>;

export interface InstallContext {
	config: ArdConfig;
	agentDir: string;
	confirm: Confirm;
	http?: HttpOptions;
}

export type InstallOutcome =
	| { status: "installed"; kind: "skill"; name: string; path: string; sha256: string; url: string; missing: string[] }
	| { status: "mcp-ready"; name: string; transport: "http"; url: string; persistCommand: string }
	| { status: "mcp-ready"; name: string; transport: "stdio"; command: string; args: string[]; persistCommand: string }
	| { status: "declined"; reason: string }
	| { status: "refused"; reason: string };

export interface Resolution {
	check: EntryCheck;
	trusted: boolean;
	trustReason: string;
}

/** An entry is trusted if its publisher domain AND the URL it would fetch are both on trustedDomains. */
export function assessTrust(entry: ArdEntry, fetchUrl: string | undefined, config: ArdConfig): Resolution {
	const check = checkEntry(entry, false);
	const pubOk = isTrustedDomain(check.publisher, config);
	const urlHost = fetchUrl ? hostOf(fetchUrl) : undefined;
	const urlOk = urlHost ? isTrustedDomain(urlHost, config) : true;
	const reasons: string[] = [];
	if (!pubOk) reasons.push(`publisher ${check.publisher ?? "?"} not in trustedDomains`);
	if (!urlOk) reasons.push(`host ${urlHost} not in trustedDomains`);
	return { check, trusted: pubOk && urlOk, trustReason: reasons.join("; ") || "publisher and host are trusted" };
}

// ---------- skills ----------

const RAW_HOSTS = new Set(["raw.githubusercontent.com"]);
const GH_BLOB = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+\/SKILL\.md)$/i;

/**
 * Where to download SKILL.md from. Order: `metadata.raw_url` (HF Discover), a raw-host SKILL.md
 * `url`, a GitHub `blob/.../SKILL.md` url (rewritten to raw.githubusercontent.com, GitHub's
 * documented raw form), or any other non-github.com `.md` url for a standard skill type.
 * GitHub `tree/` directory pages are never fetched or guessed into a file path.
 */
export function skillSourceUrl(entry: ArdEntry): string | undefined {
	const raw = entry.metadata?.raw_url;
	if (typeof raw === "string" && /\/SKILL\.md$/i.test(raw)) return raw;
	if (!entry.url) return undefined;
	if (/\/SKILL\.md$/i.test(entry.url) && RAW_HOSTS.has(hostOf(entry.url) ?? "")) return entry.url;
	const blob = GH_BLOB.exec(entry.url);
	if (blob) return `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}`;
	if (/\.md$/i.test(entry.url) && entry.type === "application/agent-skills+md" && hostOf(entry.url) !== "github.com") {
		return entry.url;
	}
	return undefined;
}

/**
 * Validates a fetched SKILL.md the way Pi's loader does (same YAML parser): Pi silently skips a
 * skill without a description, so installing one would report success for a skill that never loads.
 * Name: frontmatter `name`, else the identifier tail; must be a valid Agent Skills name.
 */
export function parseSkill(entry: ArdEntry, body: string): { name: string } | { error: string } {
	if (!/^---\r?\n/.test(body)) return { error: "no YAML frontmatter; not a SKILL.md" };
	let fm: Record<string, unknown>;
	try {
		fm = parseFrontmatter(body).frontmatter;
	} catch (e) {
		return { error: `invalid frontmatter: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}` };
	}
	if (typeof fm.description !== "string" || !fm.description.trim()) return { error: "frontmatter has no description (Pi would not load it)" };
	const name = (typeof fm.name === "string" ? fm.name : (entry.identifier.split(":").pop() ?? "")).trim().toLowerCase();
	if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 64) return { error: `invalid Agent Skills name "${name}" (lowercase a-z, 0-9, single hyphens)` };
	return { name };
}

function confirmBody(lines: Array<[string, string | undefined]>, warning: string): string {
	return `${lines
		.filter(([, v]) => v !== undefined && v !== "")
		.map(([k, v]) => `${k}: ${v}`)
		.join("\n")}\n\n${warning}`;
}

export async function installSkill(entry: ArdEntry, ctx: InstallContext): Promise<InstallOutcome> {
	const src = skillSourceUrl(entry);
	if (!src) {
		return {
			status: "refused",
			reason: `Cannot resolve a raw SKILL.md URL for ${entry.identifier} (url: ${entry.url ?? "none"}). Not guessing. Ask the user for the raw URL.`,
		};
	}
	const t = assessTrust(entry, src, ctx.config);
	if (t.check.problems.length) return { status: "refused", reason: `Entry not installable: ${t.check.problems.join("; ")}` };

	const skillsDir = join(ctx.agentDir, "skills");
	// Name is not known until the body is fetched; confirm before ANY write, fetch is read-only.
	const ok = await ctx.confirm(
		t.trusted ? "Install skill from ARD?" : "Install skill from UNTRUSTED source?",
		confirmBody(
			[
				["Name", entry.displayName],
				["Identifier", entry.identifier],
				["Publisher", t.check.publisher],
				["Fetch", src],
				["Into", skillsDir],
				["Trust", t.trusted ? "trusted" : `UNTRUSTED SOURCE (${t.trustReason})`],
				["Signature", signatureLabel(t.check)],
			],
			"Skills instruct the model to run commands and code with your permissions. Review the SKILL.md after install.",
		),
	);
	if (!ok) return { status: "declined", reason: "User declined. Nothing was fetched or written." };

	const res = await request(src, { method: "GET", headers: { accept: "text/markdown, text/plain" } }, { maxBytes: 256_000, ...ctx.http });
	const body = res.body;
	const parsed = parseSkill(entry, body);
	if ("error" in parsed) return { status: "refused", reason: `Fetched ${src}: ${parsed.error}. Nothing written.` };
	const { name } = parsed;
	const dir = join(skillsDir, name);
	if (existsSync(dir)) return { status: "refused", reason: `Skill "${name}" already exists at ${dir}. Not overwriting.` };

	const sha256 = createHash("sha256").update(body).digest("hex");
	const lp = lockPath(ctx.agentDir);
	const lock = readLock(lp); // before any write: a corrupt lock must not leave an orphan SKILL.md
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), body, { flag: "wx" });
	const rec: LockEntry = {
		identifier: entry.identifier,
		kind: "skill",
		name,
		url: res.url,
		sha256,
		installedAt: new Date().toISOString(),
		path: dir,
		trusted: t.trusted,
	};
	writeJsonAtomic(lp, { installs: [...lock.filter((l) => l.path !== dir), rec] });
	return { status: "installed", kind: "skill", name, path: dir, sha256, url: res.url, missing: bundledRefs(body) };
}

/**
 * Relative paths a SKILL.md refers to (scripts/, references/, assets/...). Only SKILL.md is
 * installed, so these will be missing. Real case: HF's huggingface-llm-trainer cites
 * scripts/train_sft_example.py and references/*.md.
 */
export function bundledRefs(body: string): string[] {
	const refs = body.match(/(?<![\w/.:-])(?:\.\/)?(?:scripts|references|assets|templates|examples)\/[\w./-]*[\w-]/g) ?? [];
	return [...new Set(refs.map((r) => r.replace(/^\.\//, "")))];
}

// ---------- MCP ----------

export interface McpPlan {
	name: string;
	transport: "http" | "stdio";
	url?: string;
	command?: string;
	args?: string[];
	description?: string;
	cardUrl: string;
}

const MCP_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * Session server name from the ARD identifier tail: the publisher chose it and it is unique in the
 * namespace. Card names are not: HF's official card is named "huggingface.co/mcp", which became
 * "mcp" and tools "mcp__mcp__*". Prefixed with the publisher's first label when the tail is generic.
 */
function serverName(entry: ArdEntry): string {
	const parts = entry.identifier.split(":");
	const tail = parts.at(-1) ?? "";
	const base = /^(mcp|hub|server|default)$/i.test(tail) ? `${(parts[2] ?? "ard").split(".")[0]}-${tail}` : tail;
	const n = base.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
	return MCP_NAME.test(n) ? n : "ard-server";
}

const STDIO_RUNNERS: Record<string, "npx" | "uvx" | "docker"> = { npm: "npx", pypi: "uvx", oci: "docker" };
/** npm (@scope/name), PyPI and OCI names. No leading "-" (would be parsed as a flag), no spaces or shell syntax. */
const PKG_ID = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w./:@-]*$/i;
const PKG_VER = /^[\w.+-]+$/;

/**
 * Map an MCP server card (static.modelcontextprotocol.io server-card schema) or an MCP registry
 * server.json (`{server:{...}}`) to one candidate. Prefers a streamable-http remote; falls back to
 * the first stdio package. The command comes only from registryType (npm/pypi/oci), never from the
 * card's free-form `runtimeHint`: a card saying `runtimeHint: "bash"` must not choose the program.
 */
export function planMcp(card: unknown, entry: ArdEntry, cardUrl: string): McpPlan | undefined {
	if (!card || typeof card !== "object") return undefined;
	const doc = ((card as { server?: unknown }).server ?? card) as Record<string, unknown>;
	const name = serverName(entry);
	const description = typeof doc.description === "string" ? doc.description.slice(0, 200) : undefined;
	const remotes = Array.isArray(doc.remotes) ? (doc.remotes as Array<Record<string, unknown>>) : [];
	const remote = remotes.find((r) => typeof r.url === "string" && (r.type === "streamable-http" || r.type === "http")) ??
		remotes.find((r) => typeof r.url === "string");
	if (remote) return { name, transport: "http", url: String(remote.url), description, cardUrl };
	const pkgs = Array.isArray(doc.packages) ? (doc.packages as Array<Record<string, unknown>>) : [];
	for (const pkg of pkgs) {
		const runner = STDIO_RUNNERS[String(pkg.registryType)];
		const id = String(pkg.identifier);
		const ver = typeof pkg.version === "string" && PKG_VER.test(pkg.version) ? pkg.version : undefined;
		if (!runner || (pkg.transport as { type?: string } | undefined)?.type !== "stdio" || !PKG_ID.test(id)) continue;
		const spec = !ver || runner === "docker" ? id : runner === "uvx" ? `${id}==${ver}` : `${id}@${ver}`;
		const args = runner === "npx" ? ["-y", spec] : runner === "docker" ? ["run", "-i", "--rm", spec] : [spec];
		return { name, transport: "stdio", command: runner, args, description, cardUrl };
	}
	return undefined;
}

export interface McpInstallContext extends InstallContext {
	/** Session-scoped registration (Pi: pi.registerMcpServer). Called only after confirmation. */
	register: (name: string, config: Record<string, unknown>) => void;
}

export async function installMcp(entry: ArdEntry, ctx: McpInstallContext): Promise<InstallOutcome> {
	let cardUrl: string;
	let card: unknown;
	if (entry.data !== undefined && entry.url === undefined) {
		cardUrl = "(inline data)";
		card = entry.data;
	} else if (entry.url) {
		cardUrl = entry.url;
	} else return { status: "refused", reason: "Entry has no url or data." };

	const t = assessTrust(entry, entry.url, ctx.config);
	if (t.check.problems.length) return { status: "refused", reason: `Entry not installable: ${t.check.problems.join("; ")}` };
	if (!t.trusted) {
		// Fetching the card is itself a request to an untrusted host. Ask first.
		const ok = await ctx.confirm(
			"Fetch MCP server card from UNTRUSTED source?",
			confirmBody([["Identifier", entry.identifier], ["Fetch", cardUrl], ["Trust", `UNTRUSTED SOURCE (${t.trustReason})`]], "Only the card is fetched. Nothing is registered yet."),
		);
		if (!ok) return { status: "declined", reason: "User declined. Nothing was fetched or registered." };
	}
	if (card === undefined) card = (await getJson(cardUrl, ctx.http)).json;

	const plan = planMcp(card, entry, cardUrl);
	if (!plan) return { status: "refused", reason: `No usable remote or stdio package in server card ${cardUrl}` };
	if (plan.transport === "http") assertSafeUrl(plan.url!);

	const what = plan.transport === "http" ? plan.url! : `${plan.command} ${plan.args!.join(" ")}`;
	// Trust is about where tool calls go, not only where the card came from: re-assess against the
	// server URL. A card from a trusted host (or inline data) may name any remote.
	const st = plan.transport === "http" ? assessTrust(entry, plan.url, ctx.config) : t;
	const ok = await ctx.confirm(
		st.trusted ? `Add MCP server "${plan.name}" for this session?` : `Add MCP server "${plan.name}" from UNTRUSTED source?`,
		confirmBody(
			[
				["Identifier", entry.identifier],
				["Publisher", t.check.publisher],
				["Card", cardUrl],
				[plan.transport === "http" ? "Server URL" : "Command", what],
				["Trust", st.trusted ? "trusted" : `UNTRUSTED SOURCE (${st.trustReason})`],
				["Signature", signatureLabel(t.check)],
			],
			plan.transport === "stdio"
				? "This starts a LOCAL PROCESS with your permissions. You will be asked a second time."
				: "The server's tools become callable by the model in this session.",
		),
	);
	if (!ok) return { status: "declined", reason: "User declined. Nothing was registered." };

	if (plan.transport === "stdio") {
		const again = await ctx.confirm(
			"Run a local command?",
			`${plan.command} ${plan.args!.join(" ")}\n\nThis downloads and executes a package on your machine. Confirm again to proceed.`,
		);
		if (!again) return { status: "declined", reason: "User declined the second confirmation for a stdio server. Nothing was registered." };
		ctx.register(plan.name, { command: plan.command, args: plan.args, ...(plan.description ? { description: plan.description } : {}) });
		return {
			status: "mcp-ready",
			name: plan.name,
			transport: "stdio",
			command: plan.command!,
			args: plan.args!,
			persistCommand: `pi mcp add ${plan.name} -- ${plan.command} ${plan.args!.join(" ")}`,
		};
	}
	ctx.register(plan.name, { url: plan.url, ...(plan.description ? { description: plan.description } : {}) });
	return { status: "mcp-ready", name: plan.name, transport: "http", url: plan.url!, persistCommand: `pi mcp add ${plan.name} --url ${plan.url}` };
}


// ---------- dispatcher ----------

export async function install(entry: ArdEntry, ctx: McpInstallContext): Promise<InstallOutcome> {
	const kind = checkEntry(entry, false).kind;
	if (kind === "skill") return installSkill(entry, ctx);
	if (kind === "mcp") return installMcp(entry, ctx);
	if (kind === "a2a") return { status: "refused", reason: `A2A agent card at ${entry.url ?? "(inline)"}. pi-ard does not run A2A; use an A2A package.` };
	if (kind === "registry") return { status: "refused", reason: "This is a registry. Add it to config.json registries instead (see /ard)." };
	if (kind === "catalog") return { status: "refused", reason: "This is a nested catalog. Use ard_catalog with its url." };
	return { status: "refused", reason: `Unsupported type ${entry.type ?? "(none)"}.` };
}
