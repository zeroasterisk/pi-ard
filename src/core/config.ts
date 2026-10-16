import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ArdConfig, RegistryConfig } from "./types.ts";

export const DEFAULT_CONFIG: ArdConfig = {
	registries: [{ name: "huggingface", url: "https://huggingface-hf-discover.hf.space" }],
	trustedDomains: ["huggingface.co"],
};

const NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** Validates a parsed config. Returns problems; empty = valid. */
export function validateConfig(c: unknown): string[] {
	const p: string[] = [];
	if (!c || typeof c !== "object") return ["config must be a JSON object"];
	const cfg = c as Record<string, unknown>;
	if (cfg.registries !== undefined) {
		if (!Array.isArray(cfg.registries)) p.push("registries must be an array");
		else
			cfg.registries.forEach((r, i) => {
				const reg = r as Partial<RegistryConfig>;
				if (!reg || typeof reg.name !== "string" || !NAME.test(reg.name)) p.push(`registries[${i}].name must match ${NAME}`);
				if (!reg?.url === !reg?.searchUrl) p.push(`registries[${i}] needs exactly one of url or searchUrl`);
			});
	}
	if (cfg.trustedDomains !== undefined && !(Array.isArray(cfg.trustedDomains) && cfg.trustedDomains.every((d) => typeof d === "string"))) {
		p.push("trustedDomains must be an array of strings");
	}
	return p;
}

export function configPath(agentDir: string): string {
	return process.env.PI_ARD_CONFIG || join(agentDir, "pi-ard", "config.json");
}

/** User-level only. Never read from a project directory. Missing file = defaults. */
export function loadConfig(path: string): ArdConfig {
	if (!existsSync(path)) return structuredClone(DEFAULT_CONFIG);
	const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ArdConfig>;
	const problems = validateConfig(parsed);
	if (problems.length) throw new Error(`Invalid ${path}: ${problems.join("; ")}`);
	return {
		registries: parsed.registries ?? structuredClone(DEFAULT_CONFIG.registries),
		trustedDomains: parsed.trustedDomains ?? [...DEFAULT_CONFIG.trustedDomains],
	};
}

export function writeJsonAtomic(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, "\t")}\n`, { mode: 0o600 });
	renameSync(tmp, path);
}

export interface LockEntry {
	identifier: string;
	kind: "skill";
	name: string;
	url: string;
	sha256: string;
	installedAt: string;
	path: string;
	trusted: boolean;
}

export function lockPath(agentDir: string): string {
	return join(agentDir, "pi-ard", "lock.json");
}

export function readLock(path: string): LockEntry[] {
	if (!existsSync(path)) return [];
	let j: { installs?: LockEntry[] };
	try {
		j = JSON.parse(readFileSync(path, "utf8"));
	} catch (e) {
		throw new Error(`Corrupt ${path} (${e instanceof Error ? e.message : String(e)}). Fix or delete it; nothing was installed.`);
	}
	return Array.isArray(j.installs) ? j.installs : [];
}
